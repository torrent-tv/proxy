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
import { isUnavailable } from "./container/unavailable.js";
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
  async containerFor({ sourceKey, fileIndex, readRange, fileSize, label = "", portionBytes }) {
    const key = `${sourceKey}:${fileIndex}`;
    if (this.cache.has(key)) return this.cache.get(key);
    if (this.pending.has(key)) return this.pending.get(key);
    const p = ContainerFactory.create({ readRange, fileSize, label, portionBytes })
      .then((c) => {
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
        this.pending.delete(key);
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
    try {
      return await this.containerFor(params);
    } catch {
      // `containerFor` has already said what failed, where it was not a
      // shortage of bytes; either way nothing was kept.
      return null;
    }
  }

  /**
   * @param {object} params - same as containerFor
   * @returns {Promise<import("./tracks/index.js").ContainerTrack[]>} Empty while
   *   the bytes have not arrived; that empty answer is not kept.
   */
  async getTracks(params) {
    const key = `${params.sourceKey}:${params.fileIndex}`;
    const known = this.tracks.get(key);
    if (known) {
      return known;
    }
    try {
      const container = await this.containerFor(params);
      if (!container) return [];
      const tracks = await container.readTracks();
      if (Array.isArray(tracks)) {
        this.tracks.set(key, tracks);
        return tracks;
      }
      return [];
    } catch (e) {
      if (!isUnavailable(e)) {
        logger.warn(`container: readTracks failed for "${params.label}": ${e?.message ?? e}`);
      }
      return [];
    }
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
    try {
      const container = await this.containerFor(params);
      if (!container) return null;
      return await container.readMediaInfo();
    } catch (e) {
      if (!isUnavailable(e)) {
        logger.warn(`container: readMediaInfo failed for "${params.label}": ${e?.message ?? e}`);
      }
      return null;
    }
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
    const container = await this.containerFor(params);
    if (!container) return null;
    try {
      return await container.readKeyframeIndex();
    } catch (e) {
      if (isUnavailable(e)) throw e;
      return null;
    }
  }

  forget(sourceKey, fileIndex) {
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
