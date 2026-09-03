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

/** Bytes of a file's head worth fetching before its track table is read. */
export const CONTAINER_HEAD_BYTES = HEAD_BYTES;

/**
 * How much of the file to pull in under the viewer's resume position.
 *
 * One piece of a video torrent is 4-16 MB and a resume lands anywhere inside
 * one, so anything smaller would still leave the encoder waiting for the piece
 * it starts in. Eight megabytes covers that piece and usually the next.
 */
const RESUME_REGION_BYTES = 8 * 1024 * 1024;

/**
 * Where a position in seconds falls in a file, in bytes.
 *
 * Proportional, and therefore approximate on a variable bitrate — which is what
 * it is for: a prefetch that puts the swarm to work on roughly the right place
 * while the plan and the session are still being built. The encoder's own read
 * asks for the exact bytes a moment later and corrects it.
 *
 * A position past the end is clamped to the end rather than refused: a resume
 * position can outlive the file it was recorded against, and reading the last
 * bytes is harmless where reading past them is an error.
 *
 * @param {number} fileLength
 * @param {number} durationSeconds
 * @param {number} positionSeconds
 * @returns {number}
 */
export function resumeByteOffset(fileLength, durationSeconds, positionSeconds) {
  if (!(fileLength > 0) || !(durationSeconds > 0) || !(positionSeconds > 0)) {
    return 0;
  }
  const within = Math.min(positionSeconds, durationSeconds);
  return Math.min(fileLength - 1, Math.floor((fileLength * within) / durationSeconds));
}

/**
 * Start fetching the region a viewer is about to resume at.
 *
 * Where that region IS can only be worked out from two numbers the file itself
 * holds — its length and its duration — so this belongs beside the container
 * read rather than in the route: the route knows a position in seconds and
 * nothing else. The conversion is proportional and therefore approximate on a
 * variable bitrate; it is a prefetch, and the encoder's own read corrects it.
 *
 * @param {object} torrent
 * @param {number} fileIndex
 * @param {string} sourceKey
 * @param {number} positionSeconds
 * @param {{ prefetchEdges?: () => Promise<unknown>, fetchRegion?: (start: number, bytes: number) => Promise<unknown> }} options
 * @returns {Promise<boolean>} Whether a region was asked for.
 */
export async function warmResumePosition(torrent, fileIndex, sourceKey, positionSeconds, options = {}) {
  const file = torrent?.files?.[fileIndex];
  if (!file || !(positionSeconds > 0) || typeof options.fetchRegion !== "function") {
    return false;
  }
  const info = await containerMediaInfoOf(torrent, fileIndex, sourceKey, options);
  const duration = info?.durationSeconds;
  if (!Number.isFinite(duration) || duration <= 0) {
    logger.info(
      `warm ${sourceKey.slice(0, 8)}: "${String(file.name).slice(0, 40)}" does not declare its ` +
      "duration, so where the viewer's position falls in it cannot be worked out — " +
      "the region under it is left to the encoder's own read"
    );
    return false;
  }
  const at = resumeByteOffset(file.length, duration, positionSeconds);
  logger.info(
    `warm ${sourceKey.slice(0, 8)}: fetching ${(RESUME_REGION_BYTES / (1024 * 1024)).toFixed(0)}MB under the ` +
    `viewer's position ${positionSeconds.toFixed(1)}s of ${duration.toFixed(1)}s, which is ` +
    `${(at / (1024 * 1024)).toFixed(1)}MB into "${String(file.name).slice(0, 40)}"`
  );
  await options.fetchRegion(at, RESUME_REGION_BYTES);
  return true;
}

/**
 * Where one file's keyframes are, from the container's own table.
 *
 * A property of immutable bytes, like the duration and the track list, and read
 * here for the same reason they are: the container is cached per file, so the
 * table is read ONCE however many sessions ask for it, and two sessions created
 * in the same moment join one read instead of making two. That is the two-viewer
 * case exactly — measured 2026-09-03, two pictures of one file were created 13 ms
 * apart, and each read the table for itself over the proxy's own HTTP.
 *
 * It decides which branch a copy takes: a picture can only be cut where the
 * source already has a keyframe, so a file with no readable index is re-encoded
 * instead. That decision belongs to the FILE, and it is the same for everybody
 * watching it.
 *
 * @param {object} torrent
 * @param {number} fileIndex
 * @param {string} sourceKey
 * @param {{ prefetchEdges?: () => Promise<unknown> }} [options]
 * @returns {Promise<{ times: number[], tolerance: number } | null>}
 */
export async function containerKeyframesOf(torrent, fileIndex, sourceKey, options = {}) {
  const file = torrent?.files?.[fileIndex];
  if (!file || !Number.isFinite(file.length) || file.length <= 0) {
    return null;
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
  const startedAt = Date.now();
  const params = {
    sourceKey,
    fileIndex,
    readRange,
    fileSize: file.length,
    label: String(file.name ?? "")
  };
  try {
    const index = await containerOrchestrator.getKeyframeIndex(params);
    // Which container answered, reported whether or not it produced anything:
    // how often an index disagrees with its own file is a question about the
    // CONTAINER, and a measurement that does not say which one cannot answer
    // it. Free — the container is the cached one that has just read the table.
    const format = (await containerOrchestrator.getContainer(params))?.formatName ?? "unrecognised";
    const times = Array.isArray(index?.times) && index.times.length > 0 ? index.times : null;
    logger.info(
      `container-keyframes: "${String(file.name).slice(0, 40)}" ` +
      (times
        ? `${times.length} keyframes from the ${format} index in ${Date.now() - startedAt}ms`
        : `has no readable index (${format}, ${Date.now() - startedAt}ms)`)
    );
    return {
      times,
      format,
      tolerance: Number.isFinite(index?.tolerance) ? index.tolerance : 0
    };
  } catch (error) {
    logger.warn(
      `container-keyframes: "${String(file.name).slice(0, 40)}" could not be read: ${error?.message ?? error}`
    );
    return null;
  }
}

/**
 * What one file declares about itself as a whole.
 *
 * @param {object} torrent
 * @param {number} fileIndex
 * @param {string} sourceKey
 * @param {{ prefetchEdges?: () => Promise<unknown> }} [options]
 * @returns {Promise<import("../container/Container.js").ContainerMediaInfo | null>}
 */
export async function containerMediaInfoOf(torrent, fileIndex, sourceKey, options = {}) {
  const file = torrent?.files?.[fileIndex];
  if (!file || !Number.isFinite(file.length) || file.length <= 0) {
    return null;
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
    const info = await containerOrchestrator.getMediaInfo({
      sourceKey,
      fileIndex,
      readRange,
      fileSize: file.length,
      label: String(file.name ?? "")
    });
    if (info) {
      logger.info(
        `container-info: "${String(file.name).slice(0, 40)}" is ${info.format}, ` +
        `${info.durationSeconds === null ? "duration not declared" : `${info.durationSeconds.toFixed(3)}s`}, ` +
        `${info.startTimeSeconds === null
          ? "start of its timeline not declared"
          : `its timeline starts at ${info.startTimeSeconds.toFixed(6)}s`}`
      );
    }
    return info;
  } catch (error) {
    logger.warn(
      `container-info: "${String(file.name).slice(0, 40)}" could not be read: ${error?.message ?? error}`
    );
    return null;
  }
}
