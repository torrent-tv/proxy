/**
 * Serve a subtitle as WebVTT, with the detected language reported in the
 * `X-Subtitle-Language` / `X-Subtitle-Language-Name` response headers. Two
 * modes:
 *
 *   - Embedded track:  ?sourceKey&fileIndex=<video>&trackIndex=<sub stream N>
 *     indexed text packets are read from available source bytes.
 *   - External file:   ?sourceKey&fileIndex=<subtitle file>   (no trackIndex)
 *     the subtitle FILE is read, decoded (UTF-8/Windows-1251), and converted
 *     (.srt/.ass/.ssa → WebVTT) here on the proxy.
 *
 * The proxy owns subtitle conversion + language detection so no model or
 * converter ships to the browser and detection sees the full text.
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{
 *   sourceRegistry: ReturnType<import("../../../store/source-registry.js").createSourceRegistry>,
 *   torrentPool: import("../../../services/torrent/torrent-pool.js").TorrentPool,
 * }} deps
 * @returns {Promise<void>}
 */

import { deriveSourceKey } from "../../../utils/torrent-source-key.js";
import { SubtitleController } from "../../../services/server/controllers/SubtitleController.js";

/** Set the detected-language response headers (no-op when detection failed). */
function setLanguageHeaders(reply, lang) {
  if (lang && typeof lang.code === "string") {
    reply.raw.setHeader("X-Subtitle-Language", lang.code);
    if (typeof lang.name === "string") {
      reply.raw.setHeader("X-Subtitle-Language-Name", encodeURIComponent(lang.name));
    }
    // These are custom headers on a cross-origin fetch — expose them.
    reply.raw.setHeader("Access-Control-Expose-Headers", "X-Subtitle-Language, X-Subtitle-Language-Name");
  }
}

export async function handleApiSubtitlesGet(req, reply, { sourceRegistry, torrentPool, viewers, subtitles }) {
  const query = req.query ?? {};
  const sourceKey = typeof query.sourceKey === "string" ? query.sourceKey.trim() : "";
  const fileIndex = Number(query.fileIndex);
  const hasTrackIndex = query.trackIndex !== undefined && query.trackIndex !== "";
  const trackIndex = Number(query.trackIndex);

  if (!sourceKey || !Number.isInteger(fileIndex) || fileIndex < 0) {
    return reply.code(400).send({ error: "sourceKey and fileIndex are required." });
  }
  if (hasTrackIndex && (!Number.isSafeInteger(trackIndex) || trackIndex < 0)) {
    return reply.code(400).send({ error: "trackIndex must be a non-negative integer.", canRetry: false });
  }

  // Turning subtitles on is a fact about the VIEWER, and this is the only place
  // that knows both the person and the file, so this is where it is recorded.
  //
  // It used to be recorded in the transport, against the CHANNEL, which the
  // transport could only do by sniffing this path out of the request and
  // deriving the torrent key itself. Two costs followed: a reconnect lost the
  // subscription for the rest of the session, and the layer that carries bytes
  // held application routing and torrent identity.
  //
  // The browser sends its registry key; the push side speaks the pool key, so
  // the two are reconciled here — the same reconciliation the transport did.
  const consumerId = typeof query.consumerId === "string" ? query.consumerId.trim() : "";
  if (consumerId && hasTrackIndex && viewers) {
    const record = sourceRegistry?.get(sourceKey);
    if (record) {
      try {
        viewers.wantsCues(consumerId, await deriveSourceKey(record.sourceType, record.source), fileIndex);
      } catch {
        // A subscription that cannot be resolved costs this viewer pushed cues;
        // it must not cost them the subtitles they asked for in this request.
      }
    }
  }

  // Interface layer delegates to SubtitleController (orchestrator + domain),
  // which owns external-file vs embedded-track branching and the cluster walk.
  const controller = new SubtitleController({ sourceRegistry, torrentPool, subtitles });
  const since = Number.parseInt(String(req.query?.since ?? ""), 10);
  const after = Number.parseFloat(String(req.query?.after ?? ""));
  const cancellation = new AbortController();
  const closed = () => cancellation.abort(new DOMException("Subtitle caller closed.", "AbortError"));
  reply.raw.once("close", closed);
  let result;
  try { result = await controller.getSubtitle({
    sourceKey,
    fileIndex,
    trackIndex: hasTrackIndex ? trackIndex : undefined,
    since: Number.isInteger(since) ? since : null,
    after: Number.isFinite(after) ? after : null,
    signal: cancellation.signal
  }); } finally { reply.raw.removeListener("close", closed); }

  if (result.error) {
    return reply.code(result.status ?? 400).send({ error: result.error });
  }
  if (hasTrackIndex) {
    reply.header("X-Subtitle-Delivery", "push");
    reply.header("Access-Control-Expose-Headers",
      "X-Subtitle-Delivery, X-Subtitle-Language, X-Subtitle-Language-Name, X-Subtitle-Covered-Clusters, X-Subtitle-Indexed-Clusters, X-Subtitle-Cursor");
  }
  if (result.pending && !hasTrackIndex) {
    return reply.code(202).send({ pending: true });
  }
  if (result.vtt !== undefined) {
    if (result.vtt !== null) {
      // External file or cluster-held cues — controller already detected language.
      const lang = result.language ?? null;
      if (lang) setLanguageHeaders(reply, lang);
      reply.header("content-type", "text/vtt; charset=utf-8");
      reply.header("cache-control", "no-store");
      if (hasTrackIndex) {
        reply.header("access-control-allow-origin", "*");
        if (result.headers) {
          for (const [k, v] of Object.entries(result.headers)) reply.header(k, String(v));
          reply.raw.setHeader(
            "Access-Control-Expose-Headers",
            "X-Subtitle-Delivery, X-Subtitle-Language, X-Subtitle-Language-Name, X-Subtitle-Covered-Clusters, X-Subtitle-Indexed-Clusters, X-Subtitle-Cursor"
          );
        }
      }
      return reply.send(result.vtt);
    }
  }
  return reply.code(202).send({ pending: true });
}
