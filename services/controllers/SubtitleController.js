/**
 * @file Subtitle controller — interface layer over SubtitleOrchestrator.
 *
 * Routes (HTTP or data-channel) call this, not the domain module directly.
 * Handles external files vs embedded tracks branching, header setting, and
 * cursor/covered-cluster bookkeeping. Domain work (cluster walk, conversion,
 * language detection) stays in orchestrator/domain.
 */

import { subtitleOrchestrator } from "../orchestrators/SubtitleOrchestrator.js";
import { convertSubtitleToVtt, cuesToVtt, decodeSubtitleBytes, finalizeCues } from "../subtitle-convert.js";
import { detectLanguage, detectLanguageFromVtt } from "../language-detect.js";

const EXTERNAL_MAX_BYTES = 8 * 1024 * 1024;

function readFileFully(file, maxBytes) {
  return new Promise((resolve, reject) => {
    const stream = file.createReadStream();
    const chunks = [];
    let total = 0;
    stream.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) { stream.destroy(); reject(new Error("subtitle file exceeds size cap")); return; }
      chunks.push(chunk);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

export class SubtitleController {
  constructor({ sourceRegistry, torrentPool }) {
    this.sourceRegistry = sourceRegistry;
    this.torrentPool = torrentPool;
    this.orchestrator = subtitleOrchestrator;
  }

  /**
   * Serve external subtitle file or embedded track.
   * Returns { vtt, language, headers } or { error, status }.
   */
  async getSubtitle({ sourceKey, fileIndex, trackIndex, since, after }) {
    const rec = this.sourceRegistry.get(sourceKey);
    if (!rec) return { error: "Source key was not found.", status: 404 };
    const torrent = await this.torrentPool.getTorrent(rec.sourceType, rec.source);
    const file = torrent.files[fileIndex];
    if (!file) return { error: "File index was not found in torrent.", status: 404 };

    const hasTrack = trackIndex !== undefined && trackIndex !== "" && Number.isFinite(Number(trackIndex));
    if (!hasTrack) {
      const name = file.name ?? "";
      const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
      const release = this.torrentPool.acquireFile(torrent, fileIndex);
      try {
        const bytes = await readFileFully(file, EXTERNAL_MAX_BYTES);
        const text = decodeSubtitleBytes(bytes);
        const vtt = convertSubtitleToVtt(text, ext);
        if (!vtt) return { error: `Unsupported subtitle format: ${ext}`, status: 422 };
        // The language is read from the CONVERTED document, not from the file.
        // The conversion has already dropped everything that is not the words —
        // and on an ASS file that is half of it, in Latin letters, which is what
        // made a Russian track answer `en` (field 2026-09-01, and the whole of
        // `research/subtitle-language-ass-markup-2026-09-01.md`).
        return { vtt, language: detectLanguageFromVtt(vtt), headers: {} };
      } catch (e) {
        return { error: `Could not read subtitle file: ${e?.message ?? e}`, status: 502 };
      } finally {
        release();
      }
    }

    const idx = Number(trackIndex);
    if (!Number.isInteger(idx) || idx < 0) return { error: "trackIndex must be a non-negative integer.", status: 400 };

    // Resolve via orchestrator (domain: cluster walk or MP4 sample ranges)
    const tracks = await this.orchestrator.getTracks(torrent, fileIndex, sourceKey);
    const track = Array.isArray(tracks) ? tracks.find((c) => c.declaredIndex === idx) ?? null : null;
    // Also try domain's declaredIndex-agnostic lookup via getCues path — keep compat with existing subtitle-cues declaredIndex
    let held = null;
    try {
      // Need trackNumber for domain call — find via declared workspace
      const domainTracks = await this.orchestrator.getDeclaredTracks(torrent, fileIndex, sourceKey);
      // If not found, fall back to direct cuesHeldFor via trackNumber from tracks list
      const target = track ?? domainTracks.find((t) => t.declaredIndex === idx) ?? null;
      const trackNumber = target?.trackNumber ?? track?.trackNumber;
      if (trackNumber != null) {
        held = await this.orchestrator.getCues(this.torrentPool, torrent, fileIndex, sourceKey, trackNumber);
      }
    } catch {}
    if (held && Array.isArray(held.cues)) {
      const cursor = held.cues.reduce((h, c) => Math.max(h, Number(c.seq) || 0), 0);
      const fresh = Number.isInteger(since) ? held.cues.filter((c) => (Number(c.seq) || 0) > since)
        : Number.isFinite(after) ? held.cues.filter((c) => c.startSeconds > after) : held.cues;
      const codecId = held.track?.codecId ?? track?.codecId ?? "";
      const vtt = cuesToVtt(fresh, codecId);
      // Two things this reads, and each of them was wrong before 2.68.1.
      //
      // It reads the cues through `finalizeCues`, so what reaches the detector
      // is the words and not ASS's `{\…}` override groups, which are Latin on a
      // Russian track. (The dialogue row's own fields are gone earlier now, in
      // the container that framed them — before 2.72.1 they were not gone at
      // all, and the detector was reading them too.)
      //
      // And it reads EVERY cue held so far, not the `fresh` subset that is
      // being sent. A re-subscription after a reconnect asks only for what this
      // page missed, which can be three lines, and three lines are not a sample
      // of a language.
      const language = detectLanguage(
        finalizeCues(held.cues, codecId).map((cue) => cue.text).join("\n")
      );
      return {
        vtt,
        language,
        headers: {
          "X-Subtitle-Covered-Clusters": String(held.coveredClusters ?? 0),
          "X-Subtitle-Indexed-Clusters": String(held.indexedClusters ?? 0),
          "X-Subtitle-Cursor": String(cursor)
        }
      };
    }
    return { pending: true, status: 202 };
  }

  async warm(torrent, fileIndex, sourceKey) {
    return this.orchestrator.warm(torrent, fileIndex, sourceKey);
  }
}
