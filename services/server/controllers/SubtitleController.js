/**
 * @file Subtitle controller — interface layer over SubtitleOrchestrator.
 *
 * Routes (HTTP or data-channel) call this, not the domain module directly.
 * Handles external files vs embedded tracks branching, header setting, and
 * cursor/covered-cluster bookkeeping. Domain work (cluster walk, conversion,
 * language detection) stays in orchestrator/domain.
 */

export class SubtitleController {
  /**
   * @param {object} deps
   * @param {object} deps.sourceRegistry
   * @param {object} deps.torrentPool
   * @param {import("../../media/SubtitleOrchestrator.js").SubtitleOrchestrator} deps.subtitles -
   *   HANDED IN rather than built here. A controller translates a request for
   *   an orchestrator and reaches every layer below it THROUGH that one; putting
   *   the media layer and the torrent's cue reading together is composition, and
   *   composition belongs to the one place that already knows about both.
   */
  constructor({ sourceRegistry, torrentPool, subtitles }) {
    this.sourceRegistry = sourceRegistry;
    this.torrentPool = torrentPool;
    this.orchestrator = subtitles;
  }

  /**
   * Serve external subtitle file or embedded track.
   * Returns { vtt, language, headers } or { error, status }.
   */
  async getSubtitle({ sourceKey, fileIndex, trackIndex, since, after, signal }) {
    const rec = this.sourceRegistry.get(sourceKey);
    if (!rec) return { error: "Source key was not found.", status: 404 };
    const torrent = this.torrentPool.knownTorrent(sourceKey);
    if (!torrent) return { pending: true, status: 202 };
    const file = torrent.files[fileIndex];
    if (!file) return { error: "File index was not found in torrent.", status: 404 };

    const hasTrack = trackIndex !== undefined && trackIndex !== "" && Number.isFinite(Number(trackIndex));
    if (!hasTrack) {
      const document = await this.orchestrator.waitForDocument(sourceKey, fileIndex, signal);
      if (document.kind === "terminal") return { error: document.message ?? document.reason, status: 422 };
      return { ...document.value, headers: {} };
    }

    const idx = Number(trackIndex);
    if (!Number.isInteger(idx) || idx < 0) return { error: "trackIndex must be a non-negative integer.", status: 400 };

    // Resolve via orchestrator (domain: cluster walk or MP4 sample ranges)
    const tracks = await this.orchestrator.getTracks(torrent, fileIndex, sourceKey);
    const track = Array.isArray(tracks) ? tracks.find((c) => c.declaredIndex === idx) ?? null : null;
    if (!track && this.orchestrator.hasTrackDeclaration(sourceKey, fileIndex)) return { error: "Subtitle track index was not found.", status: 422 };
    if (track?.isTextBased?.() === false) return { error: "The subtitle track is not supported.", status: 422 };
    // Also try domain's declaredIndex-agnostic lookup via getCues path — keep compat with existing subtitle-cues declaredIndex
    let held = null;
    try {
      // Need trackNumber for domain call — find via declared workspace
      const domainTracks = await this.orchestrator.getDeclaredTracks(torrent, fileIndex, sourceKey);
      // If not found, fall back to direct cuesHeldFor via trackNumber from tracks list
      const target = track ?? domainTracks.find((t) => t.declaredIndex === idx) ?? null;
      const trackNumber = target?.trackNumber ?? track?.trackNumber;
      if (trackNumber != null) {
        held = await this.orchestrator.getCues(torrent, fileIndex, sourceKey, trackNumber);
      }
    } catch {}
    if (held && Array.isArray(held.cues)) {
      const cursor = held.cues.reduce((h, c) => Math.max(h, Number(c.seq) || 0), 0);
      const fresh = Number.isInteger(since) ? held.cues.filter((c) => (Number(c.seq) || 0) > since)
        : Number.isFinite(after) ? held.cues.filter((c) => c.startSeconds > after) : held.cues;
      const codecId = held.track?.codecId ?? track?.codecId ?? "";
      const { vtt, language } = this.orchestrator.cuesAsVtt(fresh, held.cues, codecId);
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
