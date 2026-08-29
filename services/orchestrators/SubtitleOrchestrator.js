/**
 * @file Subtitle orchestrator — application layer over subtitle domain.
 *
 * Wraps torrent-worker/subtitle-cues.js domain (planFor, cuesHeldFor,
 * warmSubtitleCues, forgetSubtitles) behind Container/Track abstraction.
 * Provides per-file track list and cue streaming, with the same "only already
 * downloaded clusters" rule as before. Controllers (HTTP or data-channel)
 * depend on this, not on the worker module directly.
 *
 * Delegates to ContainerOrchestrator for track enumeration so subtitle tracks
 * and their flags come from the unified ContainerTrack hierarchy.
 */

import { containerOrchestrator } from "./ContainerOrchestrator.js";
import {
  cuesHeldFor as domainCuesHeldFor,
  warmSubtitleCues as domainWarm,
  subtitleTracksOf,
  declaredSubtitleTracksOf,
  forgetSubtitles as domainForget
} from "../torrent-worker/subtitle-cues.js";
import { logger } from "../../utils/logger.js";

export class SubtitleOrchestrator {
  /**
   * @param {import("./ContainerOrchestrator.js").ContainerOrchestrator} containerOrchestrator
   */
  constructor(containerOrchestrator) {
    this.containers = containerOrchestrator;
  }

  /**
   * Tracks for menu — text tracks via domain, enriched with ContainerTrack flags.
   * Falls back to container tracks when domain has no plan yet.
   * @param {object} torrent
   * @param {number} fileIndex
   * @param {string} sourceKey
   * @param {(start:number,end:number)=>Promise<Buffer|null>} [readRange]
   * @param {number} [fileSize]
   * @returns {Promise<import("../tracks/index.js").ContainerTrack[]>}
   */
  async getTracks(torrent, fileIndex, sourceKey, readRange, fileSize) {
    try {
      const domain = await subtitleTracksOf(torrent, fileIndex, sourceKey);
      if (Array.isArray(domain) && domain.length > 0) return domain;
    } catch {}
    if (readRange && Number.isFinite(fileSize)) {
      try {
        const tracks = await this.containers.getTracks({ sourceKey, fileIndex, readRange, fileSize, label: torrent?.files?.[fileIndex]?.name ?? "" });
        return tracks.filter((t) => t.type === "subtitle");
      } catch {}
    }
    return [];
  }

  /**
   * Declared subtitle tracks in container order (including image tracks) — for declaredIndex alignment.
   */
  async getDeclaredTracks(torrent, fileIndex, sourceKey) {
    try {
      return await declaredSubtitleTracksOf(torrent, fileIndex, sourceKey);
    } catch {
      return [];
    }
  }

  /**
   * Cues already downloaded for one track.
   * @param {object} torrent
   * @param {number} fileIndex
   * @param {string} sourceKey
   * @param {number} trackNumber - Container trackNumber
   */
  async getCues(torrent, fileIndex, sourceKey, trackNumber) {
    try {
      return await domainCuesHeldFor(torrent, fileIndex, sourceKey, trackNumber);
    } catch (e) {
      logger.warn(`subtitle-orchestrator: getCues failed: ${e?.message ?? e}`);
      return { cues: [], coveredClusters: 0, indexedClusters: 0, track: null };
    }
  }

  /**
   * Warm all subtitle tracks of a file — called periodically and on verified pieces.
   * Returns per-track fresh cues for push.
   */
  async warm(torrent, fileIndex, sourceKey) {
    try {
      return await domainWarm(torrent, fileIndex, sourceKey);
    } catch {
      return [];
    }
  }

  forget(sourceKey, fileIndex) {
    domainForget(sourceKey, fileIndex);
    this.containers.forget(sourceKey, fileIndex);
  }
}

export const subtitleOrchestrator = new SubtitleOrchestrator(containerOrchestrator);
