/**
 * @file Container orchestrator — application layer over Container domain.
 *
 * Holds a per-file cache of Container instances (key sourceKey:fileIndex) so
 * Tracks and keyframe index are read once per file, not per request.
 * Delegates format detection to ContainerFactory. Transport-agnostic — takes
 * readRange, knows nothing about torrents or HTTP.
 */

import { ContainerFactory } from "../container/ContainerFactory.js";
import { logger } from "../../utils/logger.js";

export class ContainerOrchestrator {
  constructor() {
    /** @type {Map<string, import("../container/Container.js").Container|null>} */
    this.cache = new Map();
    /** @type {Map<string, Promise<import("../container/Container.js").Container|null>>} */
    this.pending = new Map();
  }

  /**
   * @param {object} params
   * @param {string} params.sourceKey
   * @param {number} params.fileIndex
   * @param {(start:number,end:number)=>Promise<Buffer|null>} params.readRange
   * @param {number} params.fileSize
   * @param {string} [params.label]
   * @returns {Promise<import("../container/Container.js").Container|null>}
   */
  async getContainer({ sourceKey, fileIndex, readRange, fileSize, label = "" }) {
    const key = `${sourceKey}:${fileIndex}`;
    if (this.cache.has(key)) return this.cache.get(key);
    if (this.pending.has(key)) return this.pending.get(key);
    const p = ContainerFactory.create({ readRange, fileSize, label }).then((c) => {
      this.cache.set(key, c);
      this.pending.delete(key);
      if (c) logger.info(`container: ${c.formatName} for "${label}"`);
      else logger.info(`container: unknown for "${label}"`);
      return c;
    }).catch((e) => {
      this.pending.delete(key);
      logger.warn(`container: failed for "${label}": ${e?.message ?? e}`);
      return null;
    });
    this.pending.set(key, p);
    return p;
  }

  /**
   * @param {object} params - same as getContainer
   * @returns {Promise<import("../tracks/index.js").ContainerTrack[]>}
   */
  async getTracks(params) {
    const container = await this.getContainer(params);
    if (!container) return [];
    try {
      return await container.readTracks();
    } catch (e) {
      logger.warn(`container: readTracks failed for "${params.label}": ${e?.message ?? e}`);
      return [];
    }
  }

  /**
   * What the file declares about itself as a whole — format, duration, and
   * where its own timeline begins.
   *
   * Read once per file, like the track table beside it, and from the same 64 KB
   * of header. A `null` field means the container does not declare it, which is
   * a final answer about the container.
   *
   * @param {object} params - same as getContainer
   * @returns {Promise<import("../container/Container.js").ContainerMediaInfo|null>}
   */
  async getMediaInfo(params) {
    const container = await this.getContainer(params);
    if (!container) return null;
    try {
      return await container.readMediaInfo();
    } catch (e) {
      logger.warn(`container: readMediaInfo failed for "${params.label}": ${e?.message ?? e}`);
      return null;
    }
  }

  /**
   * @param {object} params - same as getContainer
   * @returns {Promise<{times:number[],tolerance:number}|null>}
   */
  async getKeyframeIndex(params) {
    const container = await this.getContainer(params);
    if (!container) return null;
    try {
      return await container.readKeyframeIndex();
    } catch {
      return null;
    }
  }

  forget(sourceKey, fileIndex) {
    if (fileIndex === undefined) {
      for (const k of [...this.cache.keys()]) if (k.startsWith(`${sourceKey}:`)) this.cache.delete(k);
      for (const k of [...this.pending.keys()]) if (k.startsWith(`${sourceKey}:`)) this.pending.delete(k);
      return;
    }
    this.cache.delete(`${sourceKey}:${fileIndex}`);
    this.pending.delete(`${sourceKey}:${fileIndex}`);
  }
}

export const containerOrchestrator = new ContainerOrchestrator();
