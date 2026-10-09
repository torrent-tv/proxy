/**
 * @file ffmpeg banner parsers.
 *
 * Pure helpers that extract media info from the ffmpeg `-i` stderr banner
 * (printed before any decoding): duration, start time, video resolution,
 * frame rate and HDR transfer. Shared by the playback planner (which runs the
 * codec probe) and the HLS session manager (which needs the same fields when
 * building a session), so a session can reuse the planner's probe instead of
 * running a second ffmpeg scan of the same input.
 */

/**
 * Extract the total duration in seconds from ffmpeg stderr output.
 * Returns `null` if the duration line is absent or unparseable.
 *
 * @param {string} stderrText
 * @returns {number | null}
 */
export function parseFfmpegDurationSeconds(stderrText) {
  if (typeof stderrText !== "string" || stderrText.length === 0) {
    return null;
  }
  const match = stderrText.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (![hours, minutes, seconds].every((item) => Number.isFinite(item))) {
    return null;
  }
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Parse the bitrate (kbit/s) that the decode cost is priced from: the VIDEO
 * stream's own, falling back to the container's when the stream does not state
 * one. Returns null when neither is present.
 *
 * The distinction is not cosmetic. The calibration clips carry video alone and
 * are decoded with `-an`, so the fitted bitrate term describes VIDEO bits; the
 * container figure adds every audio and subtitle track. A Russian release with
 * two or three AC-3/DTS tracks carries 1-2 Mbit/s of audio, and on this host's
 * own fit that inflates the predicted decode cost by 10-25 % — refusing rungs
 * on the strength of audio the benchmark never decoded. And the term is not the
 * weak one it was once described as: on the shipped clips an 11.7× bitrate
 * change moved the cost 2.47×, and it accounts for about two thirds of the
 * predicted cost of a high-bitrate 1080p source.
 *
 * @param {string} stderrText
 * @returns {number | null}
 */
export function parseFfmpegBitrateKbps(stderrText) {
  if (typeof stderrText !== "string" || stderrText.length === 0) {
    return null;
  }
  // `Stream #0:0 … Video: h264 … 11375 kb/s, 24 fps` — the stream's own rate,
  // stated per stream and therefore free of the other tracks. Only the INPUT
  // section is read: everything from "Stream mapping:" onwards describes what
  // ffmpeg is about to produce, and that line carries a bitrate of its own.
  const inputSection = stderrText.split(/^Stream mapping:/m)[0];
  const perStream = inputSection.match(/Stream\s+#[^\n]*?Video:[^\n]*?,\s*(\d+)\s*kb\/s/i);
  if (perStream) {
    const streamValue = Number(perStream[1]);
    if (Number.isFinite(streamValue) && streamValue > 0) {
      return streamValue;
    }
  }
  const match = stderrText.match(/Duration:[^\n]*?bitrate:\s*(\d+)\s*kb\/s/i);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Parse the source video resolution from ffmpeg's stderr (the "Stream … Video:
 * … WxH" line). Returns `{ width: null, height: null }` when absent.
 *
 * @param {string} stderrText
 * @returns {{ width: number | null, height: number | null }}
 */
export function parseFfmpegVideoDimensions(stderrText) {
  if (typeof stderrText !== "string" || stderrText.length === 0) {
    return { width: null, height: null };
  }
  const match = stderrText.match(/Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/i);
  if (!match) {
    return { width: null, height: null };
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  return {
    width: Number.isFinite(width) && width > 0 ? width : null,
    height: Number.isFinite(height) && height > 0 ? height : null
  };
}

/**
 * Count the streams the source declares, by type, from ffmpeg's banner
 * ("Stream #0:3(rus): Audio: ac3 …").
 *
 * Every `-map` this proxy builds carries the `?` suffix, which tells ffmpeg to
 * drop the mapping silently when the stream is absent instead of refusing. Map
 * every stream of a run away that way and the output is left with nothing in
 * it, which ffmpeg reports as `Output file does not contain any stream` and
 * exit 255 — three sessions died that way on 2026-08-26 and the log held only
 * the exit code. What separates "we asked for a track that is not there" from
 * every other cause of 255 is this count, so it is read once, with the rest of
 * the banner, and kept for the failure to quote.
 *
 * @param {string} stderrText
 * @returns {{ video: number, audio: number, subtitle: number, other: number } | null}
 *   Null when the banner carried no stream lines at all — which is itself
 *   different from a file that genuinely has none.
 */
export function parseFfmpegStreamCounts(stderrText) {
  if (typeof stderrText !== "string" || stderrText.length === 0) {
    return null;
  }
  // The source's streams only. A probe that writes somewhere — the planner's
  // `-f null -` does — goes on to print `Stream mapping:` and `Output #0` with
  // stream lines of their own, and counting those doubled the picture and the
  // sound (field 2026-10-04: one soundtrack read as two).
  const end = stderrText.search(/^(?:Stream mapping:|Output #\d+)/m);
  const inputText = end >= 0 ? stderrText.slice(0, end) : stderrText;
  const lines = inputText.match(/^\s*Stream #\d+:\d+.*$/gim);
  if (!lines || lines.length === 0) {
    return null;
  }
  const counts = { video: 0, audio: 0, subtitle: 0, other: 0 };
  for (const line of lines) {
    // The type follows the stream's id and its optional language/metadata:
    // "Stream #0:1(eng): Audio: aac". Attached pictures also announce
    // themselves as Video, and they are counted as such deliberately — that is
    // exactly what `0:v:0?` would map, and a cover image mapped as the picture
    // is one of the ways a run ends up producing nothing anyone can watch.
    const match = line.match(/Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?:\s*(\w+)/i);
    const kind = match ? match[1].toLowerCase() : "";
    if (kind === "video") {
      counts.video += 1;
    } else if (kind === "audio") {
      counts.audio += 1;
    } else if (kind === "subtitle") {
      counts.subtitle += 1;
    } else {
      counts.other += 1;
    }
  }
  return counts;
}

/**
 * Parse the source frame rate from the ffmpeg "Video:" line
 * (e.g. "… 23.98 fps," / "… 25 fps,"). Returns null when absent.
 *
 * @param {string} stderrText
 * @returns {number | null}
 */
export function parseFfmpegVideoFps(stderrText) {
  if (typeof stderrText !== "string" || stderrText.length === 0) {
    return null;
  }
  const videoLine = stderrText.match(/Video:[^\n]*/i);
  if (!videoLine) {
    return null;
  }
  const match = videoLine[0].match(/([\d.]+)\s*fps/i);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}
