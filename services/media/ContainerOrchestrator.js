/**
 * @file Container orchestrator — application layer over Container domain.
 *
 * Holds ONE Container per file (key sourceKey:fileIndex), and every reader of a
 * file's statements — the track table, the media info, the keyframe table, the
 * subtitle plan and the cue walk — goes through that one. The subtitle walk used
 * to build a second container over the same file with readers of its own, which
 * read the head and the Cues table a second time under a different rule for a
 * read that had not arrived (`research/subtitles-never-appear-2026-10-01.md`).
 *
 * What is kept, and what is not: a container is kept once the bytes have said
 * what format they are (including "none this proxy knows"); a head that has not
 * arrived throws `BytesUnavailable` and leaves nothing behind, so the next ask
 * reads again. Delegates format detection to ContainerFactory. Transport-
 * agnostic — takes readRange, knows nothing about torrents or HTTP.
 */

import { ContainerFactory } from "./container/ContainerFactory.js";
import { BytesUnavailable, isUnavailable, strictReader } from "./container/unavailable.js";
import { OSHASH_EDGE_BYTES, hasOshash, oshash } from "./oshash.js";
import { IndexMemoryUnavailable } from "./container/memory-unavailable.js";
import { OutsideReadableEdges } from "./container/work-tags.js";
import { logger } from "../../utils/logger.js";

/**
 * How much of a file's head its track table lives in.
 *
 * A fact of the FORMATS, not of the torrent: Matroska puts its Tracks element
 * in the head and MP4's `moov` is there or pointed to from there. Whoever
 * fetches bytes before asking is told this figure rather than choosing one.
 */
export const CONTAINER_HEAD_BYTES = 256 * 1024;

/**
 * The size of the file and its OpenSubtitles hash, from the two edges. A read
 * that has not arrived throws `BytesUnavailable`, so nothing partial is kept.
 *
 * @param {{ readRange: (start: number, end: number) => Promise<Buffer | null>, fileSize: number }} params
 * @returns {Promise<{ hash: string, size: number } | null>} `null` for a file too short to have one.
 */
async function readFingerprint({ readRange, fileSize }) {
  if (!hasOshash(fileSize)) return null;
  const read = strictReader(readRange, fileSize);
  const head = await read(0, OSHASH_EDGE_BYTES - 1);
  const tail = await read(fileSize - OSHASH_EDGE_BYTES, fileSize - 1);
  return { hash: oshash(fileSize, head, tail), size: fileSize };
}

/**
 * Which bytes of a file a reading of what it states about the work may ask the
 * swarm for: the pieces that hold its first and last bytes. Those are fetched
 * when a file is opened anyway — its OpenSubtitles hash is read from both
 * edges (`readFingerprint`) and its container head from the first — so a
 * reading that stays inside them costs no download (torrent-tv/meta#139).
 *
 * Where the file lies in the torrent is what decides which pieces those are;
 * without it, the first and the last piece length of the file are taken, which
 * is never more than one piece beyond them at each end.
 *
 * @param {{ fileSize: number, fileOffset?: number, portionBytes?: number }} params
 * @returns {(start: number, end: number) => boolean}
 */
export function edgesOf({ fileSize, fileOffset, portionBytes }) {
  const piece = Number.isFinite(portionBytes) && portionBytes > 0 ? portionBytes : CONTAINER_HEAD_BYTES;
  const offset = Number.isInteger(fileOffset) && fileOffset >= 0 ? fileOffset : null;
  const headEnd = offset === null ? piece : (Math.floor(offset / piece) + 1) * piece - offset;
  const tailStart = offset === null ? fileSize - piece : Math.floor((offset + fileSize - 1) / piece) * piece - offset;
  return (start, end) => end < headEnd || start >= tailStart;
}

/**
 * One log line's worth of what a reading of work tags found: which fields the
 * file states, not their values, and whether something was left outside the
 * edges — the two things a field check counts.
 *
 * @param {{ kind: string, value?: object, reason?: string }} result
 * @returns {string}
 */
export function describeWorkTags(result) {
  if (result.kind !== "result" || !result.value) return `none (${result.reason ?? result.kind})`;
  const tags = result.value;
  const stated = Object.entries(tags)
    .filter(([key, value]) => key !== "outsideEdges" && (Array.isArray(value) ? value.length > 0 : value && typeof value === "object" ? Object.keys(value).length > 0 : value !== null))
    .map(([key, value]) => (key === "externalIds" ? `ids:${Object.keys(value).join("+")}` : key));
  return `${stated.length ? stated.join(" ") : "nothing stated"}${tags.outsideEdges ? " (some elements lie outside the edges and are not held)" : ""}`;
}

export class ContainerOrchestrator {
  #reads = new Map();
  #lifetimes = new Map();
  #activityEpoch = 0;
  #activeReads = 0;

  activity() { return { epoch: this.#activityEpoch, active: this.#activeReads > 0 }; }
  constructor() {
    /** @type {Map<string, import("./container/Container.js").Container|null>} */
    this.cache = new Map();
    /** @type {Map<string, Promise<import("./container/Container.js").Container|null>>} */
    this.pending = new Map();
    /**
     * What each file's container declares, once it has said it.
     *
     * The track table is asked for the audio menu, the subtitle defaults and
     * the video facts of one file; the container keeps its own reading, and
     * this keeps the answer so the question costs nothing the second time.
     *
     * @type {Map<string, import("./tracks/index.js").ContainerTrack[]>}
     */
    this.tracks = new Map();
  }

  /**
   * The container already built for a file, if any — without reading anything.
   *
   * `undefined` means none has been built yet; `null` means the bytes were read
   * and are no format this proxy knows.
   *
   * @param {string} sourceKey
   * @param {number} fileIndex
   * @returns {import("./container/Container.js").Container | null | undefined}
   */
  known(sourceKey, fileIndex) {
    return this.cache.get(`${sourceKey}:${fileIndex}`);
  }

  packetIndexBytes() {
    return [...new Set(this.cache.values())].reduce((bytes, container) => bytes + (container?.packetIndexBytes?.() ?? 0), 0);
  }

  /** Read one statement without converting missing bytes into an empty answer. */
  async inspect(params, statement = "tracks") {
    if (!["container", "tracks", "media-info", "keyframes", "packets", "fingerprint", "work-tags", "cover"].includes(statement)) {
      throw new TypeError(`Unknown media statement: ${statement}`);
    }
    const key = `${params.sourceKey}:${params.fileIndex}`;
    let lifetime = this.#lifetimes.get(key);
    if (!lifetime) this.#lifetimes.set(key, lifetime = {});
    const isCurrent = () => this.#lifetimes.get(key) === lifetime && params.isCurrent?.() !== false;
    const previous = this.#reads.get(key) ?? Promise.resolve();
    const reading = previous.catch(() => undefined).then(async () => {
      if (!isCurrent()) return { result: { kind: "terminal", reason: "request-obsolete", requestId: params.requestId } };
      const revision = params.onReadStart?.(statement);
      const result = await this.#inspectRead({ ...params, isCurrent }, statement);
      return { result, revision };
    });
    this.#reads.set(key, reading);
    try {
      const { result, revision } = await reading;
      if (!isCurrent()) return { kind: "terminal", reason: "request-obsolete", requestId: params.requestId };
      if (result.kind === "needs-ranges") params.onNeedsRanges?.(result);
      if (statement === "tracks" && result.kind === "result") params.onTracks?.(result.value);
      await params.onReadResult?.(statement, result, revision);
      return result;
    } finally {
      if (this.#reads.get(key) === reading) this.#reads.delete(key);
    }
  }

  async #inspectRead(params, statement) {
    const requestId = params.requestId ?? `${params.sourceKey}:${params.fileIndex}:${statement}`;
    this.#activityEpoch++;
    this.#activeReads++;
    try {
      if (statement === "fingerprint") {
        // A fact about the bytes at the two ends of the file, whatever the format.
        const value = await readFingerprint(params);
        return value ? { kind: "result", value, requestId } : { kind: "terminal", reason: "file-too-short", requestId };
      }
      const container = await this.containerFor(params);
      if (!container) {
        const result = { kind: "terminal", reason: "format-not-supported", requestId };
        logger.info(`media request=${requestId} terminal=${result.reason}`);
        return result;
      }
      let value;
      if (statement === "container") {
        value = container;
      } else if (statement === "tracks") {
        const key = `${params.sourceKey}:${params.fileIndex}`;
        value = this.tracks.get(key);
        if (!value) {
          value = await container.readTracks();
          if (!Array.isArray(value)) throw new Error("Container did not return a track table.");
          if (params.isCurrent?.() === false) return { kind: "terminal", reason: "request-obsolete", requestId };
          this.tracks.set(key, value);
        }
      } else if (statement === "media-info") {
        value = await container.readMediaInfo();
      } else if (statement === "keyframes") {
        value = await container.readKeyframeIndex();
      } else if (statement === "work-tags" || statement === "cover") {
        value = await (statement === "cover" ? container.readCover(edgesOf(params)) : container.readWorkTags(edgesOf(params)));
        if (value === null) return { kind: "terminal", reason: statement === "cover" ? "no-cover" : "format-states-nothing", requestId };
      } else if (statement === "packets") {
        value = await container.readPacketIndex(params.packetInterval);
        await value?.prepareAudioDependencies?.(params.packetInterval, container.readRange);
      } else {
        throw new TypeError(`Unknown media statement: ${statement}`);
      }
      return { kind: "result", value, requestId };
    } catch (error) {
      if (error instanceof IndexMemoryUnavailable) {
        const result = { kind: "needs-memory", bytes: error.bytes, requestId };
        logger.info(`media request=${requestId} needs memory=${error.bytes}`);
        return result;
      }
      if (error instanceof OutsideReadableEdges) {
        // Not a fault and not "not here yet": the bytes lie where this reading
        // may not ask for them. Asked again, it reads them once they are held.
        return { kind: "terminal", reason: "outside-edges", requestId };
      }
      if (isUnavailable(error)) {
        const result = { kind: "needs-ranges", ranges: [[error.start, error.end]], requestId };
        logger.info(`media request=${requestId} needs bytes=${error.start}-${error.end}`);
        return result;
      }
      const result = { kind: "terminal", reason: "media-read-failed", message: error?.message ?? String(error), requestId };
      logger.warn(`media request=${requestId} terminal=${result.reason}: ${result.message}`);
      return result;
    } finally {
      this.#activeReads--;
      this.#activityEpoch++;
    }
  }

  /**
   * The file's one container, built on first ask.
   *
   * @param {object} params
   * @param {string} params.sourceKey
   * @param {number} params.fileIndex
   * @param {(start:number,end:number)=>Promise<Buffer|null>} params.readRange
   * @param {number} params.fileSize
   * @param {string} [params.label]
   * @param {number} [params.portionBytes]
   * @returns {Promise<import("./container/Container.js").Container|null>}
   * @throws {import("./container/unavailable.js").BytesUnavailable} While the
   *   head has not arrived. Nothing is kept for it.
   */
  async containerFor({ sourceKey, fileIndex, readRange, fileSize, label = "", portionBytes, probe, packetMemory }) {
    const key = `${sourceKey}:${fileIndex}`;
    if (this.cache.has(key)) return this.cache.get(key);
    if (this.pending.has(key)) return this.pending.get(key);
    const p = ContainerFactory.create({ readRange, fileSize, label, portionBytes, probe, packetMemory })
      .then((c) => {
        if (this.pending.get(key) !== p) throw new Error("Container request was withdrawn.");
        this.cache.set(key, c);
        if (c) logger.info(`container: ${c.formatName} for "${label}"`);
        else logger.info(`container: unknown for "${label}"`);
        return c;
      })
      .catch((e) => {
        if (!isUnavailable(e)) {
          logger.warn(`container: failed for "${label}": ${e?.message ?? e}`);
        }
        throw e;
      })
      .finally(() => {
        if (this.pending.get(key) === p) this.pending.delete(key);
      });
    this.pending.set(key, p);
    return p;
  }

  /**
   * The same, answering null rather than throwing while the head is not here —
   * for the callers whose own answer to "not yet" is "nothing yet".
   *
   * @param {object} params - same as containerFor
   * @returns {Promise<import("./container/Container.js").Container|null>}
   */
  async getContainer(params) {
    const result = await this.inspect(params, "container");
    return result.kind === "result" ? result.value : null;
  }

  /**
   * @param {object} params - same as containerFor
   * @returns {Promise<import("./tracks/index.js").ContainerTrack[]>} Empty while
   *   the bytes have not arrived; that empty answer is not kept.
   */
  async getTracks(params) {
    const result = await this.inspect(params, "tracks");
    return result.kind === "result" ? result.value : [];
  }

  /**
   * What the file declares about itself as a whole — format, duration, and
   * where its own timeline begins.
   *
   * A `null` field means the container does not declare it, which is a final
   * answer about the container. A null RESULT means the bytes have not arrived,
   * or the format is unknown; neither is kept here.
   *
   * @param {object} params - same as containerFor
   * @returns {Promise<import("./container/Container.js").ContainerMediaInfo|null>}
   */
  async getMediaInfo(params) {
    const result = await this.inspect(params, "media-info");
    return result.kind === "result" ? result.value : null;
  }

  /**
   * @param {object} params - same as containerFor
   * @returns {Promise<{times:number[],tolerance:number}|null>} Null where the
   *   file has no usable index, or is of no known format.
   * @throws {import("./container/unavailable.js").BytesUnavailable} While the
   *   bytes the index needs have not arrived — so that the keyframe table does
   *   not record "no keyframes" for a file whose index is still downloading.
   */
  async getKeyframeIndex(params) {
    const result = await this.inspect(params, "keyframes");
    if (result.kind === "needs-memory") throw new IndexMemoryUnavailable(result.bytes);
    if (result.kind === "needs-ranges") {
      const [start, end] = result.ranges[0];
      throw new BytesUnavailable(start, end, 0);
    }
    return result.kind === "result" ? result.value : null;
  }

  forget(sourceKey, fileIndex) {
    const prefix = `${sourceKey}:`;
    for (const key of this.#lifetimes.keys()) {
      if (fileIndex === undefined ? key.startsWith(prefix) : key === `${sourceKey}:${fileIndex}`) {
        this.#lifetimes.delete(key);
        this.#reads.delete(key);
      }
    }
    if (fileIndex === undefined) {
      for (const k of [...this.cache.keys()]) if (k.startsWith(`${sourceKey}:`)) this.cache.delete(k);
      for (const k of [...this.pending.keys()]) if (k.startsWith(`${sourceKey}:`)) this.pending.delete(k);
      for (const k of [...this.tracks.keys()]) if (k.startsWith(`${sourceKey}:`)) this.tracks.delete(k);
      return;
    }
    this.cache.delete(`${sourceKey}:${fileIndex}`);
    this.pending.delete(`${sourceKey}:${fileIndex}`);
    this.tracks.delete(`${sourceKey}:${fileIndex}`);
  }
}

export const containerOrchestrator = new ContainerOrchestrator();
