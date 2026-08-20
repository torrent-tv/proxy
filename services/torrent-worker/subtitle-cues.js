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
import { decodeSubtitleSample, readMp4SubtitlePlan } from "../container-index/mp4-subtitles.js";
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
    state = { plan: null, harvested: new Map(), cues: new Map(), seq: new Map(), walked: new Set() };
    byFile.set(key, state);
  }
  if (state.plan !== null) {
    return state.plan;
  }
  const file = torrent?.files?.[fileIndex];
  // `declared` is what the container itself says about its subtitle tracks, in
  // its own order. Empty means the container said nothing — which is a real
  // answer and not a missing one: nothing is then shown unasked. An MP4 has no
  // element that means "show this subtitle track by default", so it declares
  // nothing however many tracks it carries.
  const empty = { tracks: [], declared: [], secondsPerTick: 0.001, segmentDataOffset: 0 };
  if (!file) {
    state.plan = empty;
    return state.plan;
  }
  const readRange = async (start, end) => readHeld(file, start, Math.min(end, file.length - 1));
  const name = String(file.name);
  if (/\.mp4$/i.test(name) || /\.m4v$/i.test(name)) {
    // An MP4 states every sample's byte range in its own table, so a cue costs
    // its own few dozen bytes rather than the cluster around it. The samples
    // are carried as `clusterPositions` of one byte range each, so the harvest
    // treats both containers the same way.
    const mp4 = await readMp4SubtitlePlan(readRange, file.length);
    state.plan = mp4
      ? {
        ...empty,
        tracks: mp4.tracks.map((track, order) => ({
          trackNumber: track.trackId,
          codecId: track.format,
          language: track.language,
          name: "",
          isDefault: order === 0,
          codecPrivate: "",
          clusterPositions: [],
          samples: track.samples
        }))
      }
      : empty;
    return state.plan;
  }
  if (!/\.mkv$/i.test(name) && !/\.webm$/i.test(name)) {
    state.plan = empty;
    return state.plan;
  }
  const plan = await readSubtitlePlan(readRange, file.length);
  state.plan = plan ?? empty;
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
 * The order a cue was FOUND in, which is the only cursor a browser can follow.
 *
 * A cue's TIME cannot serve as one. Cues are harvested out of whichever
 * clusters happen to be downloaded, and those are not contiguous, so the set
 * grows in the middle as well as at the end. A browser that remembered "the
 * latest time I hold" and asked for everything past it would never be sent the
 * cues that turn up BEHIND that mark afterwards — which is exactly the stretch
 * it is about to play. Measured 2026-08-20 on a viewer at 272 s: one answer
 * carried cues out to 1176 s, and from then on every cue between the two was
 * filtered away for the rest of the session, with 59 of 276 clusters read.
 *
 * Found-order is monotonic by construction, so `?since=<n>` is exact however
 * the file arrives.
 *
 * @param {{ seq: Map<number, number> }} state
 * @param {number} trackNumber
 * @returns {number}
 */
function nextSeq(state, trackNumber) {
  const next = (state.seq.get(trackNumber) ?? 0) + 1;
  state.seq.set(trackNumber, next);
  return next;
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

  if (Array.isArray(track.samples)) {
    // An MP4: every cue's bytes are stated, so only those bytes are read, and
    // only where they are already downloaded.
    for (const sample of track.samples) {
      if (harvested.has(sample.offset)) {
        continue;
      }
      const last = Math.min(file.length - 1, sample.offset + sample.size - 1);
      if (!rangeIsHeld(torrent, file, sample.offset, last)) {
        continue;
      }
      const bytes = await readHeld(file, sample.offset, last);
      if (!bytes) {
        continue;
      }
      harvested.add(sample.offset);
      const text = decodeSubtitleSample(bytes, track.codecId);
      if (text) {
        cues.push({
          startSeconds: sample.startSeconds,
          endSeconds: sample.endSeconds,
          text,
          seq: nextSeq(state, trackNumber)
        });
      }
    }
    cues.sort((left, right) => left.startSeconds - right.startSeconds);
    return {
      cues,
      coveredClusters: harvested.size,
      indexedClusters: track.samples.length,
      track
    };
  }

  // ONE walk for the whole file, not one per track. A Matroska cluster carries
  // the blocks of every track that has anything to say over its span, so the
  // bytes that answer one track answer them all — and reading them once per
  // track meant the same cluster was fetched and parsed as many times as the
  // film has subtitle tracks. Measured 2026-08-20 on a film with five: five
  // requests every fifteen seconds, each costing 0.2-5.2 s of container
  // reading, for cues that together weigh a few kilobytes.
  //
  // The union of the tracks' cluster lists is what gets walked: each track's
  // list comes from its own Cues entries, so they overlap but do not coincide.
  const positions = new Set();
  for (const candidate of plan.tracks) {
    for (const position of candidate.clusterPositions ?? []) {
      positions.add(position);
    }
  }
  for (const position of [...positions].sort((left, right) => left - right)) {
    if (state.walked.has(position)) {
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
      state.walked.add(position); // not a cluster we can read; do not look again
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
    state.walked.add(position);
    for (const candidate of plan.tracks) {
      let into = state.cues.get(candidate.trackNumber);
      if (!into) {
        into = [];
        state.cues.set(candidate.trackNumber, into);
      }
      let found = false;
      for (const cue of harvestCluster(bytes, candidate.trackNumber, plan.secondsPerTick)) {
        cue.seq = nextSeq(state, candidate.trackNumber);
        into.push(cue);
        found = true;
      }
      if (found) {
        into.sort((left, right) => left.startSeconds - right.startSeconds);
      }
    }
  }
  return {
    cues: state.cues.get(trackNumber) ?? [],
    // Every track is filled by the same walk, so this is a fact about the FILE
    // and reads the same whichever track asked.
    coveredClusters: state.walked.size,
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
 * What the container itself says about its subtitle tracks, in its own order
 * and including the picture-based ones.
 *
 * Separate from `subtitleTracksOf`, which lists only what can be turned into
 * WebVTT and is indexed by position in the subtitle API. This one exists to be
 * lined up against ffmpeg's `0:s:N` numbering, which counts every subtitle
 * stream, so leaving the picture ones out would shift it.
 *
 * @param {object} torrent
 * @param {number} fileIndex
 * @param {string} sourceKey
 * @returns {Promise<object[]>}
 */
export async function declaredSubtitleTracksOf(torrent, fileIndex, sourceKey) {
  const plan = await planFor(torrent, fileIndex, `${sourceKey}:${fileIndex}`);
  return plan?.declared ?? [];
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
