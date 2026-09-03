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
   * Cues already downloaded for one track — ASKED OF THE TORRENT WORKER, never
   * walked here.
   *
   * The walk decides what it may read from `torrent.bitfield` and
   * `torrent.pieceLength`, and a torrent stand-in on the main thread has
   * neither: it carries `infoHash`, `name` and a `files` list whose reads go
   * back across the boundary (`torrent-worker/client.js`). So the same code
   * called here answers that nothing is downloaded, walks no clusters, and
   * returns an empty document — which is not a failure anything reports,
   * because "no cues held" is a legitimate answer.
   *
   * Field 2026-09-03, and it is the whole reason this method changed. An
   * episode already downloaded from an earlier sitting had its cues found
   * within a second and a half of the file being opened, and the first four
   * pushes — everything before 81.7 s — went out before the browser had
   * subscribed. The catch-up pull that exists for exactly that case answered
   * `WEBVTT` and nothing else, with `x-subtitle-covered-clusters: 0` against
   * 283 indexed, so the viewer watched the opening of the episode with no
   * subtitles and the rest of it with them.
   *
   * There is a second reason, independent of the bitfield. The register of what
   * has been walked, what has been found and in what ORDER lives in the module
   * that does the walking, and the worker already keeps one — the push path
   * fills it. Walking again on the main thread would build a SECOND register
   * with its own `seq` counter, and the browser mixes the cursors from both
   * paths (`#rememberCursor`): two counters would make a cursor from a pull and
   * a cursor from a push incomparable. One register, one walk, one cursor.
   *
   * @param {{ getSubtitleCues?: Function }} pool - The torrent pool, which is
   *   what holds the channel to the worker.
   * @param {object} torrent
   * @param {number} fileIndex
   * @param {string} sourceKey
   * @param {number} trackNumber - Container trackNumber
   * @returns {Promise<{ cues: object[], coveredClusters: number, indexedClusters: number, track: object | null }>}
   */
  async getCues(pool, torrent, fileIndex, sourceKey, trackNumber) {
    // Built fresh on each of the three paths that need it. One shared literal
    // returned by reference would hand every caller the same array, and a
    // single one of them appending to it would change what the next caller
    // reads — which in a method about cue registers not leaking into each
    // other would be a poor thing to introduce.
    const empty = () => ({ cues: [], coveredClusters: 0, indexedClusters: 0, track: null });
    if (typeof pool?.getSubtitleCues !== "function") {
      // Nothing here can read pieces, and answering an empty document would be
      // indistinguishable from a file that genuinely holds no cues.
      logger.warn(
        "subtitle-orchestrator: the torrent pool cannot be asked for cues, " +
        "so none can be served — the walk needs the thread that owns the torrent"
      );
      return empty();
    }
    try {
      const answer = await pool.getSubtitleCues(torrent, fileIndex, trackNumber);
      if (!answer) {
        return empty();
      }
      return {
        cues: Array.isArray(answer.cues) ? answer.cues : [],
        coveredClusters: answer.coveredClusters ?? 0,
        indexedClusters: answer.indexedClusters ?? 0,
        // The worker answers with the track's own fields flat, because a
        // `ContainerTrack` is a class and only plain objects cross the boundary.
        track: {
          codecId: answer.codecId ?? "",
          codecPrivate: answer.codecPrivate ?? "",
          language: answer.language ?? ""
        }
      };
    } catch (e) {
      logger.warn(`subtitle-orchestrator: getCues failed: ${e?.message ?? e}`);
      return empty();
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
