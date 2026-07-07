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
import { convertSubtitleToVtt, decodeSubtitleBytes } from "../../../services/subtitle-convert.js";
import { detectLanguage } from "../../../services/language-detect.js";

// Safety cap: no embedded extraction may outlive this.
const EXTRACTION_TIMEOUT_MS = 30 * 60 * 1000;
// External subtitle files are small; cap the read to guard against a bad index.
const EXTERNAL_MAX_BYTES = 8 * 1024 * 1024;

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

  const sourceRecord = sourceRegistry.get(sourceKey);
  if (!sourceRecord) {
    return reply.code(404).send({ error: "Source key was not found." });
  }
  const torrent = await torrentPool.getTorrent(sourceRecord.sourceType, sourceRecord.source);
  const file = torrent.files[fileIndex];
  if (!file) {
    return reply.code(404).send({ error: "File index was not found in torrent." });
  }

  // ---- External subtitle FILE (no trackIndex) -----------------------------
  if (!hasTrackIndex) {
    const name = typeof file.name === "string" ? file.name : "";
    const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
    const release = torrentPool.acquireFile(torrent, fileIndex);
    try {
      const bytes = await readFileFully(file, EXTERNAL_MAX_BYTES);
      const text = decodeSubtitleBytes(bytes);
      const vtt = convertSubtitleToVtt(text, ext);
      if (!vtt) {
        return reply.code(422).send({ error: `Unsupported subtitle format: ${ext}` });
      }
      setLanguageHeaders(reply, detectLanguage(text));
      reply.header("content-type", "text/vtt; charset=utf-8");
      reply.header("cache-control", "no-store");
      return reply.send(vtt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(502).send({ error: `Could not read subtitle file: ${message}` });
    } finally {
      release();
    }
  }

  // ---- Embedded track (ffmpeg extraction, streamed) -----------------------
  if (!Number.isInteger(trackIndex) || trackIndex < 0) {
    return reply.code(400).send({ error: "trackIndex must be a non-negative integer." });
  }

  const inputUrl = new URL("/stream", `${localBaseUrl}/`);
  inputUrl.searchParams.set("sourceKey", sourceKey);
  inputUrl.searchParams.set("fileIndex", String(fileIndex));

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

  const killTimer = setTimeout(() => {
    if (!ffmpeg.killed) {
      ffmpeg.kill("SIGKILL");
    }
  }, EXTRACTION_TIMEOUT_MS);
  killTimer.unref?.();
  req.raw.on("close", () => {
    clearTimeout(killTimer);
    if (!ffmpeg.killed) {
      ffmpeg.kill("SIGTERM");
    }
  });

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

  // Detect language from the first chunk of the produced VTT (embedded tracks
  // frequently lack a language tag in their container metadata).
  setLanguageHeaders(reply, detectLanguage(String(firstChunk)));
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

/**
 * Read a torrent file fully into a Buffer, bounded by `maxBytes`.
 *
 * @param {{ createReadStream: () => import("node:stream").Readable, length?: number }} file
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
function readFileFully(file, maxBytes) {
  return new Promise((resolve, reject) => {
    const stream = file.createReadStream();
    const chunks = [];
    let total = 0;
    stream.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        stream.destroy();
        reject(new Error("subtitle file exceeds the size cap"));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}
