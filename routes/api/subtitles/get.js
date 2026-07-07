/**
 * Extract an embedded text subtitle track from a torrent file as WebVTT.
 *
 * GET /api/subtitles?sourceKey=...&fileIndex=N&trackIndex=M
 *
 * `trackIndex` is the TYPE-RELATIVE subtitle stream index (what ffmpeg's
 * `-map 0:s:M` selects), as reported by the playback plan's
 * `subtitleTracks[].index`.
 *
 * The response streams while ffmpeg produces it. Extraction has to read the
 * file up to the last cue, so on a cold torrent this drives (and waits for)
 * the sequential download — callers must use a generous timeout.
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

// Safety cap: no extraction may outlive this (a dead swarm would otherwise
// hold the ffmpeg process forever).
const EXTRACTION_TIMEOUT_MS = 30 * 60 * 1000;

export async function handleApiSubtitlesGet(req, reply, { sourceRegistry, torrentPool, ffmpegBin, localBaseUrl }) {
  const query = req.query ?? {};
  const sourceKey = typeof query.sourceKey === "string" ? query.sourceKey.trim() : "";
  const fileIndex = Number(query.fileIndex);
  const trackIndex = Number(query.trackIndex);

  if (!sourceKey || !Number.isInteger(fileIndex) || fileIndex < 0 || !Number.isInteger(trackIndex) || trackIndex < 0) {
    return reply.code(400).send({ error: "sourceKey, fileIndex and trackIndex are required." });
  }

  const sourceRecord = sourceRegistry.get(sourceKey);
  if (!sourceRecord) {
    return reply.code(404).send({ error: "Source key was not found." });
  }
  const torrent = await torrentPool.getTorrent(sourceRecord.sourceType, sourceRecord.source);
  if (!torrent.files[fileIndex]) {
    return reply.code(404).send({ error: "File index was not found in torrent." });
  }

  const inputUrl = new URL("/stream", `${localBaseUrl}/`);
  inputUrl.searchParams.set("sourceKey", sourceKey);
  inputUrl.searchParams.set("fileIndex", String(fileIndex));

  const ffmpeg = spawn(
    ffmpegBin,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputUrl.toString(),
      "-map",
      `0:s:${trackIndex}`,
      "-f",
      "webvtt",
      "pipe:1"
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
  );

  let stderr = "";
  ffmpeg.stderr.on("data", (chunk) => {
    if (stderr.length < 4096) {
      stderr += String(chunk);
    }
  });

  const killTimer = setTimeout(() => {
    if (!ffmpeg.killed) {
      ffmpeg.kill("SIGKILL");
    }
  }, EXTRACTION_TIMEOUT_MS);
  killTimer.unref?.();

  // Stop extracting when the client goes away.
  req.raw.on("close", () => {
    clearTimeout(killTimer);
    if (!ffmpeg.killed) {
      ffmpeg.kill("SIGTERM");
    }
  });

  // Distinguish "bad track / not text-based" (ffmpeg dies before any output)
  // from a mid-stream failure (headers already sent; the stream just ends).
  const firstChunk = await new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    ffmpeg.stdout.once("data", (chunk) => settle(chunk));
    ffmpeg.once("exit", () => settle(null));
    ffmpeg.once("error", () => settle(null));
  });

  if (firstChunk === null) {
    clearTimeout(killTimer);
    return reply
      .code(422)
      .send({ error: `Subtitle track could not be extracted: ${stderr.trim() || "no output from ffmpeg"}` });
  }

  reply.raw.writeHead(200, {
    "content-type": "text/vtt; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*"
  });
  reply.raw.write(firstChunk);
  ffmpeg.stdout.pipe(reply.raw);
  await new Promise((resolve) => {
    ffmpeg.stdout.once("end", resolve);
    ffmpeg.once("error", resolve);
  });
  clearTimeout(killTimer);
  reply.raw.end();
  return reply;
}
