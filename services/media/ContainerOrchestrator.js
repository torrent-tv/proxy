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
import { BytesUnavailable, isUnavailable } from "./container/unavailable.js";
import { IndexMemoryUnavailable } from "./container/memory-unavailable.js";
import { logger } from "../../utils/logger.js";

/**
 * How much of a file's head its track table lives in.
 *
 * A fact of the FORMATS, not of the torrent: Matroska puts its Tracks element
 * in the head and MP4's `moov` is there or pointed to from there. Whoever
 * fetches bytes before asking is told this figure rather than choosing one.
 */
export const CONTAINER_HEAD_BYTES = 256 * 1024;

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
    if (!["container", "tracks", "media-info", "keyframes", "packets"].includes(statement)) {
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
