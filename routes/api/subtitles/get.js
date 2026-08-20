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
import { logger } from "../../../utils/logger.js";

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

  // From the clusters the viewer has already downloaded, if this file can be
  // read that way. Costs no network at all and answers with the part of the
  // film they are watching; the rest arrives as they watch it. Only when the
  // container cannot be read this way does the old extraction run.
  const held = await cuesFromDownloadedClusters(torrentPool, torrent, fileIndex, trackIndex);
  if (held !== null) {
    setLanguageHeaders(reply, held.language);
    reply.header("content-type", "text/vtt; charset=utf-8");
    reply.header("cache-control", "no-store");
    reply.header("access-control-allow-origin", "*");
    // How much of the film these cues cover, so the browser knows to ask again
    // as playback moves into clusters that were not downloaded yet.
    reply.header("X-Subtitle-Covered-Clusters", String(held.coveredClusters));
    reply.header("X-Subtitle-Indexed-Clusters", String(held.indexedClusters));
    reply.raw.setHeader(
      "Access-Control-Expose-Headers",
      "X-Subtitle-Language, X-Subtitle-Language-Name, X-Subtitle-Covered-Clusters, X-Subtitle-Indexed-Clusters"
    );
    return reply.send(held.vtt);
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
 * @type {Map<string, { state: "running" | "done" | "failed", body?: Buffer, language?: string, error?: string }>}
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
    extractions.set(key, { state: "done", body, language: detectLanguage(String(body.subarray(0, 4096))) });
    logger.info(`subtitles ${key}: ${body.length} bytes in ${seconds}s`);
  };
  ffmpeg.once("close", settle);
  ffmpeg.once("error", settle);
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

/**
 * The cues of a track from clusters already downloaded, as WebVTT.
 *
 * `trackIndex` is the browser's number for the subtitle stream — its position
 * among the subtitle streams, as ffprobe lists them — while Matroska blocks
 * carry the file's own track number. The plan lists the text tracks in file
 * order, so the browser's Nth subtitle stream is the Nth entry.
 *
 * @param {object} torrentPool
 * @param {object} torrent
 * @param {number} fileIndex
 * @param {number} trackIndex
 * @returns {Promise<{ vtt: string, language: object | null, coveredClusters: number, indexedClusters: number } | null>}
 *   Null when this file cannot be read this way, and then the caller falls back.
 */
async function cuesFromDownloadedClusters(torrentPool, torrent, fileIndex, trackIndex) {
  if (typeof torrentPool?.getSubtitleTracks !== "function") {
    return null;
  }
  let tracks;
  try {
    tracks = await torrentPool.getSubtitleTracks(torrent, fileIndex);
  } catch {
    return null;
  }
  const track = Array.isArray(tracks) ? tracks[trackIndex] : null;
  if (!track) {
    return null;
  }
  let held;
  try {
    held = await torrentPool.getSubtitleCues(torrent, fileIndex, track.trackNumber);
  } catch {
    return null;
  }
  if (!held || !Array.isArray(held.cues)) {
    return null;
  }
  const vtt = cuesToVtt(held.cues, held.codecId);
  const language = held.cues.length > 0
    ? detectLanguage(held.cues.map((cue) => cue.text).join("\n"))
    : null;
  return {
    vtt,
    language,
    coveredClusters: held.coveredClusters ?? 0,
    indexedClusters: held.indexedClusters ?? 0
  };
}

/**
 * WebVTT from cues read out of the container.
 *
 * A cue with no duration — a SimpleBlock, which subtitles rarely use — is given
 * the time until the next one, and the last such cue a few seconds. That is not
 * an invention about the film: it is what a player does with an open-ended cue,
 * made explicit here so the file is valid.
 *
 * @param {{ startSeconds: number, endSeconds: number | null, text: string }[]} cues
 * @param {string} codecId
 * @returns {string}
 */
function cuesToVtt(cues, codecId) {
  const lines = ["WEBVTT", ""];
  const isAss = codecId === "S_TEXT/ASS" || codecId === "S_TEXT/SSA";
  cues.forEach((cue, index) => {
    const next = cues[index + 1];
    const end = cue.endSeconds ?? (next ? next.startSeconds : cue.startSeconds + 4);
    const text = isAss ? assDialogueToText(cue.text) : cue.text.trim();
    if (!text) {
      return;
    }
    lines.push(`${vttTime(cue.startSeconds)} --> ${vttTime(end)}`);
    lines.push(text);
    lines.push("");
  });
  return lines.join("\n");
}

/**
 * The visible text of an ASS dialogue row.
 *
 * A block carries the fields after `Dialogue:` without their header — nine of
 * them, then the text, which itself holds override groups in braces.
 *
 * @param {string} raw
 * @returns {string}
 */
function assDialogueToText(raw) {
  const fields = raw.split(",");
  const text = fields.length > 9 ? fields.slice(9).join(",") : raw;
  return text
    .replace(/\{[^}]*\}/g, "")
    .replace(/\\N/gi, "\n")
    .trim();
}

/**
 * A time in the form WebVTT requires.
 *
 * @param {number} seconds
 * @returns {string}
 */
function vttTime(seconds) {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const rest = safe % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:` +
    `${rest.toFixed(3).padStart(6, "0")}`;
}
