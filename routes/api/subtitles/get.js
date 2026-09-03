/**
 * Serve a subtitle as WebVTT, with the detected language reported in the
 * `X-Subtitle-Language` / `X-Subtitle-Language-Name` response headers. Two
 * modes:
 *
 *   - Embedded track:  ?sourceKey&fileIndex=<video>&trackIndex=<sub stream N>
 *     ffmpeg extracts the text subtitle stream (`-map 0:s:N -f webvtt`),
 *     streamed as it is produced.
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
 *   torrentPool: import("../../../services/torrent-pool.js").TorrentPool,
 *   ffmpegBin: string,
 *   localBaseUrl: string
 * }} deps
 * @returns {Promise<void>}
 */

import { spawn } from "node:child_process";
import { TextSubtitleTrack } from "../../../services/tracks/TextSubtitleTrack.js";
import { SubtitleController } from "../../../services/controllers/SubtitleController.js";
import { logger } from "../../../utils/logger.js";

// Safety cap: no embedded extraction may outlive this.
const EXTRACTION_TIMEOUT_MS = 30 * 60 * 1000;

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

export async function handleApiSubtitlesGet(req, reply, { sourceRegistry, torrentPool, ffmpegBin, localBaseUrl }) {
  const query = req.query ?? {};
  const sourceKey = typeof query.sourceKey === "string" ? query.sourceKey.trim() : "";
  const fileIndex = Number(query.fileIndex);
  const hasTrackIndex = query.trackIndex !== undefined && query.trackIndex !== "";
  const trackIndex = Number(query.trackIndex);

  if (!sourceKey || !Number.isInteger(fileIndex) || fileIndex < 0) {
    return reply.code(400).send({ error: "sourceKey and fileIndex are required." });
  }

  // Interface layer delegates to SubtitleController (orchestrator + domain),
  // which owns external-file vs embedded-track branching and the cluster walk.
  const controller = new SubtitleController({ sourceRegistry, torrentPool });
  const since = Number.parseInt(String(req.query?.since ?? ""), 10);
  const after = Number.parseFloat(String(req.query?.after ?? ""));
  const result = await controller.getSubtitle({
    sourceKey,
    fileIndex,
    trackIndex: hasTrackIndex ? trackIndex : undefined,
    since: Number.isInteger(since) ? since : null,
    after: Number.isFinite(after) ? after : null
  });

  if (result.error) {
    return reply.code(result.status ?? 400).send({ error: result.error });
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
            "X-Subtitle-Language, X-Subtitle-Language-Name, X-Subtitle-Covered-Clusters, X-Subtitle-Indexed-Clusters, X-Subtitle-Cursor"
          );
        }
      }
      return reply.send(result.vtt);
    }
  }
  // If controller returned pending, fall through to ffmpeg extraction below.

  // ---- Embedded track — controller had no held cues, try cluster path directly for headers compatibility
  // The controller's getSubtitle already attempted the cluster walk; reaching here means it returned pending.
  if (!hasTrackIndex) {
    // Should have been handled above — pending for external is unsupported format
    return reply.code(422).send({ error: "Unsupported subtitle format" });
  }
  if (!Number.isInteger(trackIndex) || trackIndex < 0) {
    return reply.code(400).send({ error: "trackIndex must be a non-negative integer." });
  }

  const inputUrl = new URL("/stream", `${localBaseUrl}/`);
  inputUrl.searchParams.set("sourceKey", sourceKey);
  inputUrl.searchParams.set("fileIndex", String(fileIndex));

  const key = `${sourceKey}:${fileIndex}:${trackIndex}`;
  const known = extractions.get(key);
  if (known?.state === "done") {
    setLanguageHeaders(reply, known.language);
    reply.header("content-type", "text/vtt; charset=utf-8");
    reply.header("cache-control", "no-store");
    reply.header("access-control-allow-origin", "*");
    return reply.send(known.body);
  }
  if (known?.state === "failed") {
    return reply.code(422).send({ error: known.error });
  }
  if (known?.state !== "running") {
    startExtraction({ key, ffmpegBin, localBaseUrl, sourceKey, fileIndex, trackIndex });
  }
  // Being prepared. The connection is NOT held: extracting an embedded track
  // makes ffmpeg read the whole file, because subtitles are interleaved through
  // it, and that means downloading the film for the sake of a few kilobytes of
  // text. Measured 2026-08-19: track 0 of one release produced 3040 bytes over
  // **752 seconds**, with the data channel idle the whole time — the browser
  // gave up at its own sixty-second limit, and every retry started the same
  // twelve-minute scan again. So the work runs once in the background and the
  // caller is told to come back.
  return reply.code(202).send({ pending: true });
}

/**
 * Extractions by `sourceKey:fileIndex:trackIndex`, so the scan happens once per
 * track however many times it is asked for.
 *
 * @type {Map<string, { state: "running" | "done" | "failed", body?: Buffer, language?: { code: string, name: string } | null, error?: string }>}
 */
const extractions = new Map();

/**
 * Run one extraction to completion in the background, keeping the result.
 *
 * @param {{ key: string, ffmpegBin: string, localBaseUrl: string, sourceKey: string, fileIndex: number, trackIndex: number }} params
 * @returns {void}
 */
function startExtraction({ key, ffmpegBin, localBaseUrl, sourceKey, fileIndex, trackIndex }) {
  const inputUrl = new URL("/stream", `${localBaseUrl}/`);
  inputUrl.searchParams.set("sourceKey", sourceKey);
  inputUrl.searchParams.set("fileIndex", String(fileIndex));

  extractions.set(key, { state: "running" });
  const startedAt = Date.now();
  const ffmpeg = spawn(
    ffmpegBin,
    ["-hide_banner", "-loglevel", "error", "-i", inputUrl.toString(), "-map", `0:s:${trackIndex}`, "-f", "webvtt", "pipe:1"],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
  );

  let stderr = "";
  ffmpeg.stderr.on("data", (chunk) => {
    if (stderr.length < 4096) {
      stderr += String(chunk);
    }
  });

  /** @type {Buffer[]} */
  const chunks = [];
  ffmpeg.stdout.on("data", (chunk) => chunks.push(chunk));

  const killTimer = setTimeout(() => {
    if (!ffmpeg.killed) {
      ffmpeg.kill("SIGKILL");
    }
  }, EXTRACTION_TIMEOUT_MS);
  killTimer.unref?.();

  const settle = () => {
    clearTimeout(killTimer);
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    const body = Buffer.concat(chunks);
    if (body.length === 0) {
      extractions.set(key, {
        state: "failed",
        error: `Subtitle track could not be extracted: ${stderr.trim() || "no output from ffmpeg"}`
      });
      logger.warn(`subtitles ${key}: nothing produced after ${seconds}s`);
      return;
    }
    // The whole document, decoded as one string, and only its cue text.
    // Detecting on the first 4096 BYTES was wrong twice over: a byte cut lands
    // mid-character on any non-Latin track, and most of those bytes are
    // timestamps rather than words. This runs once per track in the background,
    // so reading all of it costs nothing anybody waits for.
    extractions.set(key, { state: "done", body, language: TextSubtitleTrack.detectLanguageFromVtt(body.toString("utf8")) });
    logger.info(`subtitles ${key}: ${body.length} bytes in ${seconds}s`);
  };
  ffmpeg.once("close", settle);
  ffmpeg.once("error", settle);
}


