/**
 * @file Subtitle cues gathered from the clusters a viewer has already brought
 * in, never from clusters they have not.
 *
 * The rule this file exists to keep (stated by the user 2026-08-20): subtitles
 * arrive the way the picture does, or they are not offered. So nothing here
 * requests a byte. It looks at what the torrent already holds, reads the
 * clusters inside it, and returns what it found; the region the viewer is
 * watching is downloaded before they reach it, so its cues are ready before
 * they are needed. A region nobody has watched has no cues, and that is
 * correct — there is nobody to show them to.
 *
 * Why not ffmpeg: measured 2026-08-19, extracting one subtitle track of
 * `Minions.and.Monsters.1080p.mkv` took **752 seconds** and pulled the download
 * from 2.7 % to 81 % of a 6.5 GB film, because a subtitle stream is sparse and
 * the demuxer walks the container to the end whatever range is asked of it.
 * Reading the clusters costs nothing extra at all.
 */

import { readSubtitlePlan, harvestCluster } from "../container-index/matroska-subtitles.js";
import { iterateElements } from "../container-index/ebml-reader.js";
import { logger } from "../../utils/logger.js";

/** Enough to read any cluster's own element header. */
const CLUSTER_HEADER_PROBE = 64;
/**
 * The largest cluster this will read whole. Real muxers write clusters of a few
 * megabytes; anything past this is not a cluster boundary we recognised and
 * reading it would be a large read for nothing.
 */
const MAX_CLUSTER_BYTES = 32 * 1024 * 1024;

/** @type {Map<string, { plan: object | null, harvested: Map<number, Set<number>>, cues: Map<number, object[]> }>} */
const byFile = new Map();

/**
 * Whether every piece covering a byte range is already downloaded.
 *
 * @param {object} torrent
 * @param {object} file
 * @param {number} start - Offset within the FILE.
 * @param {number} end - Inclusive.
 * @returns {boolean}
 */
function rangeIsHeld(torrent, file, start, end) {
  const pieceLength = Number(torrent?.pieceLength);
  const offset = Number(file?.offset) || 0;
  if (!Number.isFinite(pieceLength) || pieceLength <= 0 || !torrent?.bitfield) {
    return false;
  }
  const first = Math.floor((offset + start) / pieceLength);
  const last = Math.floor((offset + end) / pieceLength);
  for (let index = first; index <= last; index += 1) {
    if (!torrent.bitfield.get(index)) {
      return false;
    }
  }
  return true;
}

/**
 * Read a byte range of a file straight from the store, without asking the swarm
 * for anything.
 *
 * @param {object} file
 * @param {number} start
 * @param {number} end - Inclusive.
 * @returns {Promise<Buffer | null>}
 */
function readHeld(file, start, end) {
  return new Promise((resolve) => {
    const chunks = [];
    let stream;
    try {
      stream = file.createReadStream({ start, end });
    } catch {
      resolve(null);
      return;
    }
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", () => resolve(null));
  });
}

/**
 * The subtitle tracks of a file, read once and kept.
 *
 * The head and the Cues table are two short reads, and they ARE fetched if
 * missing — they are kilobytes, they are needed before anything can be offered,
 * and the codec probe has already pulled the head for every file that plays.
 *
 * @param {object} torrent
 * @param {number} fileIndex
 * @param {string} key - `sourceKey:fileIndex`.
 * @returns {Promise<object | null>}
 */
async function planFor(torrent, fileIndex, key) {
  let state = byFile.get(key);
  if (!state) {
    state = { plan: null, harvested: new Map(), cues: new Map() };
    byFile.set(key, state);
  }
  if (state.plan !== null) {
    return state.plan;
  }
  const file = torrent?.files?.[fileIndex];
  if (!file || !/\.mkv$/i.test(String(file.name))) {
    // Only Matroska is read this way. An MP4's text track is cheaper still —
    // its sample table gives exact byte offsets — and is not written yet.
    state.plan = { tracks: [], secondsPerTick: 0.001, segmentDataOffset: 0 };
    return state.plan;
  }
  const readRange = async (start, end) => readHeld(file, start, Math.min(end, file.length - 1));
  const plan = await readSubtitlePlan(readRange, file.length);
  state.plan = plan ?? { tracks: [], secondsPerTick: 0.001, segmentDataOffset: 0 };
  if (state.plan.tracks.length > 0) {
    logger.info(
      `subtitles: "${String(file.name).slice(0, 40)}" has ${state.plan.tracks.length} text track(s) — ` +
      state.plan.tracks
        .map((track) => `${track.trackNumber}:${track.language || "?"}${track.name ? `/${track.name}` : ""}` +
          `(${track.clusterPositions.length} indexed)`)
        .join(" ")
    );
  }
  return state.plan;
}

/**
 * Every cue of one track that can be read from what is already downloaded.
 *
 * @param {object} torrent
 * @param {number} fileIndex
 * @param {string} sourceKey
 * @param {number} trackNumber
 * @returns {Promise<{ cues: object[], coveredClusters: number, indexedClusters: number, track: object | null }>}
 */
export async function cuesHeldFor(torrent, fileIndex, sourceKey, trackNumber) {
  const key = `${sourceKey}:${fileIndex}`;
  const plan = await planFor(torrent, fileIndex, key);
  const state = byFile.get(key);
  const track = plan?.tracks?.find((candidate) => candidate.trackNumber === trackNumber) ?? null;
  if (!track) {
    return { cues: [], coveredClusters: 0, indexedClusters: 0, track: null };
  }
  const file = torrent.files[fileIndex];
  let harvested = state.harvested.get(trackNumber);
  if (!harvested) {
    harvested = new Set();
    state.harvested.set(trackNumber, harvested);
  }
  let cues = state.cues.get(trackNumber);
  if (!cues) {
    cues = [];
    state.cues.set(trackNumber, cues);
  }

  for (const position of track.clusterPositions) {
    if (harvested.has(position)) {
      continue;
    }
    // The header first: it says how long the cluster is, and a cluster whose
    // bytes are not all here is left for the next time round.
    if (!rangeIsHeld(torrent, file, position, Math.min(file.length - 1, position + CLUSTER_HEADER_PROBE - 1))) {
      continue;
    }
    const probe = await readHeld(file, position, Math.min(file.length - 1, position + CLUSTER_HEADER_PROBE - 1));
    const header = probe && [...iterateElements(probe, 0, probe.length)][0];
    if (!header || header.size <= 0 || header.size > MAX_CLUSTER_BYTES) {
      harvested.add(position); // not a cluster we can read; do not look again
      continue;
    }
    const last = Math.min(file.length - 1, position + header.dataOffset + header.size - 1);
    if (!rangeIsHeld(torrent, file, position, last)) {
      continue;
    }
    const bytes = await readHeld(file, position, last);
    if (!bytes) {
      continue;
    }
    harvested.add(position);
    for (const cue of harvestCluster(bytes, trackNumber, plan.secondsPerTick)) {
      cues.push(cue);
    }
  }
  cues.sort((left, right) => left.startSeconds - right.startSeconds);
  return {
    cues,
    coveredClusters: harvested.size,
    indexedClusters: track.clusterPositions.length,
    track
  };
}

/**
 * The text subtitle tracks of a file, for the menu the viewer sees.
 *
 * @param {object} torrent
 * @param {number} fileIndex
 * @param {string} sourceKey
 * @returns {Promise<object[]>}
 */
export async function subtitleTracksOf(torrent, fileIndex, sourceKey) {
  const plan = await planFor(torrent, fileIndex, `${sourceKey}:${fileIndex}`);
  return (plan?.tracks ?? []).map((track) => ({
    trackNumber: track.trackNumber,
    codecId: track.codecId,
    language: track.language,
    name: track.name,
    isDefault: track.isDefault,
    indexedClusters: track.clusterPositions.length
  }));
}

/**
 * Forget a file's cues — the torrent is gone, and holding them would keep the
 * text of a film nobody is watching.
 *
 * @param {string} sourceKey
 * @param {number} [fileIndex]
 * @returns {void}
 */
export function forgetSubtitles(sourceKey, fileIndex) {
  if (fileIndex === undefined) {
    for (const key of [...byFile.keys()]) {
      if (key.startsWith(`${sourceKey}:`)) {
        byFile.delete(key);
      }
    }
    return;
  }
  byFile.delete(`${sourceKey}:${fileIndex}`);
}
