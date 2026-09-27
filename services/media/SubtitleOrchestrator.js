/**
 * @file Subtitle orchestrator — the track list and the cues, behind the
 * Container/Track abstraction.
 *
 * Provides per-file track list and cue streaming, with the same "only already
 * downloaded clusters" rule as before. Controllers (HTTP or data-channel)
 * depend on this, not on the worker module directly. Delegates to
 * `ContainerOrchestrator` for track enumeration so subtitle tracks and their
 * flags come from the unified `ContainerTrack` hierarchy.
 *
 * **The cue reading is HANDED IN, not imported, and that is the layer boundary.**
 * Which clusters may be read, where the cursor stands and what one walk at a
 * time means are the TORRENT's rules, and they live in
 * `torrent-worker/subtitle-cues.js`. This file used to import them, so the media
 * layer named the torrent's worker — the one direction the layers may not go.
 * Now the wiring puts the two together (`server/controllers/SubtitleController.js`) and
 * this can be exercised with four plain functions.
 */

import { logger } from "../../utils/logger.js";
import { SubtitleFileContainer } from "./container/SubtitleFileContainer.js";
import { TextSubtitleTrack } from "./tracks/TextSubtitleTrack.js";
import { detectLanguage } from "./tracks/language-detect.js";

export class SubtitleOrchestrator {
  /**
   * @param {import("./ContainerOrchestrator.js").ContainerOrchestrator} containerOrchestrator
   * @param {object} [cues] - How the torrent reads subtitle cues: `warm`,
   *   `tracksOf`, `declaredTracksOf`, `forget`. Absent, this answers from the
   *   containers alone, which is what a proxy with no torrent behind it can do.
   */
  constructor(containerOrchestrator, cues = {}) {
    this.containers = containerOrchestrator;
    this.cues = cues ?? {};
  }

  /**
   * Tracks for menu — text tracks via domain, enriched with ContainerTrack flags.
   * Falls back to container tracks when domain has no plan yet.
   * @param {object} torrent
   * @param {number} fileIndex
   * @param {string} sourceKey
   * @param {(start:number,end:number)=>Promise<Buffer|null>} [readRange]
   * @param {number} [fileSize]
   * @returns {Promise<import("./tracks/index.js").ContainerTrack[]>}
   */
  async getTracks(torrent, fileIndex, sourceKey, readRange, fileSize) {
    try {
      const domain = await this.cues.tracksOf?.(torrent, fileIndex, sourceKey);
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
      return (await this.cues.declaredTracksOf?.(torrent, fileIndex, sourceKey)) ?? [];
    } catch {
      return [];
    }
  }

  /**
   * The cues a file already holds for one track.
   *
   * The PULL path: a browser asking `/api/subtitles` rather than being pushed
   * to. It runs the same walk as the push, on this thread — it used to be sent
   * to the torrent thread as a command, and when that command went the guard
   * here answered an EMPTY document instead of failing, which is
   * indistinguishable from a file that genuinely holds no cues. That is the one
   * failure this whole path is written to avoid, so an absent walk says so.
   *
   * @param {object} torrent
   * @param {number} fileIndex
   * @param {string} sourceKey
   * @param {number} trackNumber
   * @returns {Promise<{ cues: object[], coveredClusters: number, indexedClusters: number, track: object | null }>}
   */
  async getCues(torrent, fileIndex, sourceKey, trackNumber) {
    const empty = () => ({ cues: [], coveredClusters: 0, indexedClusters: 0, track: null });
    if (typeof this.cues.held !== "function") {
      logger.warn(
        "subtitle-orchestrator: no walk was supplied, so no cue can be read — " +
        "an empty document here would be indistinguishable from a file with none"
      );
      return empty();
    }
    try {
      const answer = await this.cues.held(torrent, fileIndex, sourceKey, trackNumber);
      return answer ?? empty();
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
      return (await this.cues.warm?.(torrent, fileIndex, sourceKey)) ?? [];
    } catch {
      return [];
    }
  }

  /**
   * A subtitle FILE as WebVTT, and the language its words are in.
   *
   * The language is read from the CONVERTED document, not from the file. The
   * conversion has already dropped everything that is not the words — and on
   * an ASS file that is half of it, in Latin letters, which is what made a
   * Russian track answer `en` (field 2026-09-01,
   * `research/subtitle-language-ass-markup-2026-09-01.md`).
   *
   * @param {Buffer} bytes
   * @param {string} extension - With its dot, lower case.
   * @returns {{ vtt: string, language: string | null } | null} Null for a
   *   format this cannot convert.
   */
  fileAsVtt(bytes, extension) {
    const text = SubtitleFileContainer.decodeBytes(bytes);
    const vtt = SubtitleFileContainer.toVtt(text, extension);
    if (!vtt) {
      return null;
    }
    return { vtt, language: TextSubtitleTrack.detectLanguageFromVtt(vtt) };
  }

  /**
   * Cues held for an embedded track as WebVTT, and the language of the track.
   *
   * Two things this reads, and each of them was wrong before 2.68.1. It reads
   * the cues through `finalizeCues`, so what reaches the detector is the words
   * and not ASS's `{\…}` override groups, which are Latin on a Russian track.
   * And it reads EVERY cue held so far, not the subset being sent: a
   * re-subscription after a reconnect asks only for what the page missed,
   * which can be three lines, and three lines are not a sample of a language.
   *
   * @param {object[]} sending - The cues this answer carries.
   * @param {object[]} held - Every cue held for the track so far.
   * @param {string} codecId
   * @returns {{ vtt: string, language: string | null }}
   */
  cuesAsVtt(sending, held, codecId) {
    return {
      vtt: TextSubtitleTrack.cuesToVtt(sending, codecId),
      language: detectLanguage(TextSubtitleTrack.finalizeCues(held, codecId).map((cue) => cue.text).join("\n"))
    };
  }

  forget(sourceKey, fileIndex) {
    this.cues.forget?.(sourceKey, fileIndex);
    this.containers.forget(sourceKey, fileIndex);
  }
}
