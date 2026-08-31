/**
 * The tracks a file declares, read from the file itself on the thread that owns
 * the torrent.
 *
 * This exists because the container layer (`services/container/`) reads bytes,
 * and the bytes live here: the torrent client runs on this worker thread, so the
 * main thread cannot open a read stream on one of its files. The main thread
 * asks over the channel (`Command.CONTAINER_TRACKS`) and gets plain objects
 * back, because a class instance does not survive the boundary as a class.
 *
 * It reads whatever container the file is — the same `ContainerFactory` that
 * serves the picture serves a `.mka` beside it, since a `.mka` IS Matroska and
 * differs only in having no video track. That is the whole reason no new class
 * was needed for a soundtrack shipped as its own file.
 *
 * Unlike the subtitle walk, the reads here DO wait on the swarm. A sidecar file
 * has usually had nothing downloaded at all when this is first asked, and its
 * header is a few hundred kilobytes; the alternative is offering the viewer a
 * soundtrack with nothing known about it.
 */

import { containerOrchestrator } from "../orchestrators/ContainerOrchestrator.js";
import { logger } from "../../utils/logger.js";

/**
 * How long one range read may take before it is given up.
 *
 * Not a measurement and nothing is derived from it: it is the point past which a
 * read of a file nobody is playing is presumed lost, so that one stream which
 * never ends cannot hold the answer — and with it the viewer's audio menu — for
 * the rest of the session.
 */
const READ_ABANDON_MS = 60_000;

/** Bytes of the head a container's track table lives in. */
const HEAD_BYTES = 256 * 1024;

/**
 * Tracks already read, by `sourceKey:fileIndex`. Only a non-empty reading is
 * kept: an empty one usually means the header has not arrived yet, and caching
 * that would hide the file's tracks for the life of the process.
 *
 * @type {Map<string, object[]>}
 */
const byFile = new Map();

/** @type {Map<string, Promise<object[]>>} */
const inFlight = new Map();

/**
 * Read a byte range of a file, fetching what is missing.
 *
 * @param {object} file
 * @param {number} start
 * @param {number} end - Inclusive.
 * @returns {Promise<Buffer | null>}
 */
function readFetching(file, start, end) {
  return new Promise((resolve) => {
    const chunks = [];
    let stream;
    try {
      stream = file.createReadStream({ start, end });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let abandon = null;
    const settle = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (abandon !== null) {
        clearTimeout(abandon);
      }
      if (value === null) {
        stream.destroy?.();
      }
      resolve(value);
    };
    abandon = setTimeout(() => {
      logger.info(
        `container-tracks: a read of ${start}-${end} in "${String(file.name).slice(0, 40)}" ` +
        `did not finish in ${READ_ABANDON_MS / 1000}s and was given up`
      );
      settle(null);
    }, READ_ABANDON_MS);
    abandon.unref?.();
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => settle(Buffer.concat(chunks)));
    stream.on("error", () => settle(null));
  });
}

/**
 * One track as it crosses the thread boundary: the fields the inventory and the
 * master playlist read, and nothing that would not survive being cloned.
 *
 * @param {import("../tracks/index.js").ContainerTrack} track
 * @returns {object}
 */
function plainTrack(track) {
  return {
    type: track.type,
    trackNumber: track.trackNumber,
    declaredIndex: track.declaredIndex,
    codecId: track.codecId,
    language: track.resolvedLanguage(),
    languageBcp47: track.languageBcp47,
    name: track.name,
    isEnabled: track.isEnabled,
    isDefault: track.isDefault,
    declaresDefault: track.declaresDefault,
    // Audio-only, per RFC 9559 — absent on other types, and read as false there
    // rather than being placed on the base track where they do not belong.
    isOriginal: track.isOriginal === true,
    isCommentary: track.isCommentary === true,
    isVisualImpaired: track.isVisualImpaired === true,
    channels: Number.isFinite(track.channels) ? track.channels : null,
    samplingFrequency: Number.isFinite(track.samplingFrequency) ? track.samplingFrequency : null
  };
}

/**
 * Every track one file declares, in container order.
 *
 * @param {object} torrent
 * @param {number} fileIndex
 * @param {string} sourceKey
 * @param {{ prefetchEdges?: () => Promise<unknown> }} [options]
 * @returns {Promise<object[]>}
 */
export async function containerTracksOf(torrent, fileIndex, sourceKey, options = {}) {
  const key = `${sourceKey}:${fileIndex}`;
  const held = byFile.get(key);
  if (Array.isArray(held)) {
    return held;
  }
  const running = inFlight.get(key);
  if (running) {
    return running;
  }
  const work = readTracks(torrent, fileIndex, sourceKey, options)
    .then((tracks) => {
      if (tracks.length > 0) {
        byFile.set(key, tracks);
      }
      return tracks;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, work);
  return work;
}

/**
 * @param {object} torrent
 * @param {number} fileIndex
 * @param {string} sourceKey
 * @param {{ prefetchEdges?: () => Promise<unknown> }} options
 * @returns {Promise<object[]>}
 */
async function readTracks(torrent, fileIndex, sourceKey, options) {
  const file = torrent?.files?.[fileIndex];
  if (!file || !Number.isFinite(file.length) || file.length <= 0) {
    return [];
  }
  if (typeof options.prefetchEdges === "function") {
    try {
      await options.prefetchEdges();
    } catch {
      // A prefetch that failed is not a reason to skip the read: the read
      // fetches what it needs itself, only more slowly.
    }
  }
  const readRange = async (start, end) =>
    readFetching(file, start, Math.min(end, file.length - 1));
  try {
    const tracks = await containerOrchestrator.getTracks({
      sourceKey,
      fileIndex,
      readRange,
      fileSize: file.length,
      label: String(file.name ?? "")
    });
    const plain = tracks.map(plainTrack);
    if (plain.length > 0) {
      logger.info(
        `container-tracks: "${String(file.name).slice(0, 40)}" declares ` +
        `${plain.filter((track) => track.type === "video").length} video, ` +
        `${plain.filter((track) => track.type === "audio").length} audio, ` +
        `${plain.filter((track) => track.type === "subtitle").length} subtitle track(s)`
      );
    }
    return plain;
  } catch (error) {
    logger.warn(
      `container-tracks: "${String(file.name).slice(0, 40)}" could not be read: ${error?.message ?? error}`
    );
    return [];
  }
}

/**
 * The audio tracks of one file, in the order ffmpeg numbers them `0:a:N`.
 *
 * @param {object} torrent
 * @param {number} fileIndex
 * @param {string} sourceKey
 * @param {{ prefetchEdges?: () => Promise<unknown> }} [options]
 * @returns {Promise<object[]>}
 */
export async function containerAudioTracksOf(torrent, fileIndex, sourceKey, options = {}) {
  const tracks = await containerTracksOf(torrent, fileIndex, sourceKey, options);
  return tracks
    .filter((track) => track.type === "audio")
    .sort((left, right) => left.declaredIndex - right.declaredIndex);
}

/** Bytes of a file's head worth fetching before its track table is read. */
export const CONTAINER_HEAD_BYTES = HEAD_BYTES;

/**
 * Forget one file's tracks, or every file of a source.
 *
 * @param {string} sourceKey
 * @param {number} [fileIndex]
 */
export function forgetContainerTracks(sourceKey, fileIndex) {
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
