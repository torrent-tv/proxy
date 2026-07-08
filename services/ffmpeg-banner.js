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
 * Parse the container start time (seconds) from ffmpeg's "Duration: …, start:
 * X, …" line. Many MKVs report a small non-zero start (e.g. 0.1 s); preserving
 * it via `-copyts` would put a hole at the beginning, so we normalize it away.
 * Returns 0 when absent.
 *
 * @param {string} stderrText
 * @returns {number}
 */
export function parseFfmpegStartTimeSeconds(stderrText) {
  if (typeof stderrText !== "string" || stderrText.length === 0) {
    return 0;
  }
  const match = stderrText.match(/Duration:[^\n]*?start:\s*(-?\d+(?:\.\d+)?)/i);
  if (!match) {
    return 0;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : 0;
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

/**
 * Detect an HDR / wide-gamut source from the ffmpeg "Video:" line's colour
 * metadata. HDR is identified by the transfer function — `smpte2084` (PQ /
 * HDR10) or `arib-std-b67` (HLG). Re-encoding such a source to 8-bit SDR
 * without tone mapping produces a washed-out, desaturated picture, so this
 * gates the tonemap filter chain.
 *
 * @param {string} stderrText
 * @returns {boolean}
 */
export function parseFfmpegHdr(stderrText) {
  if (typeof stderrText !== "string" || stderrText.length === 0) {
    return false;
  }
  const videoLine = stderrText.match(/Video:[^\n]*/i);
  if (!videoLine) {
    return false;
  }
  // ffmpeg prints the colour info in parentheses, e.g.
  // "yuv420p10le(tv, bt2020nc/bt2020/smpte2084)". The transfer (last token) is
  // the reliable HDR signal.
  return /\b(smpte2084|arib-std-b67|arib_std_b67)\b/i.test(videoLine[0]);
}
