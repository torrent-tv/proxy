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

/**
 * How many bits per sample the video carries, from the pixel format ffmpeg
 * prints on its `Video:` line.
 *
 * This is a decode-cost input, not a colour one: a 10-bit stream holds wider
 * samples and is decoded with wider arithmetic, and how much that costs is a
 * property of the machine. It is therefore its own calibration family rather
 * than a multiplier on the 8-bit one.
 *
 * ffmpeg names the depth in the format itself — `yuv420p10le`, `yuv420p12le`,
 * `p010le` — and omits it at 8 bits (`yuv420p`, `nv12`). An unreadable line
 * gives null, and the caller then prices the source as 8-bit, which is what
 * every source was priced as before this existed.
 *
 * @param {string} stderrText
 * @returns {number | null}
 */
export function parseFfmpegBitDepth(stderrText) {
  if (typeof stderrText !== "string" || stderrText.length === 0) {
    return null;
  }
  const videoLine = stderrText.match(/Video:[^\n]*/i);
  if (!videoLine) {
    return null;
  }
  // The pixel format is the token after the codec and its tag, and the depth
  // rides on its name. `p010`/`p016` are the two that state it without a `p`
  // separator, and they are 10 and 16 bits.
  const named = videoLine[0].match(/\byuv[a-z0-9]*?p(\d{1,2})(?:le|be)\b/i);
  if (named) {
    const depth = Number(named[1]);
    return Number.isFinite(depth) && depth >= 8 ? depth : null;
  }
  if (/\bp010(?:le|be)?\b/i.test(videoLine[0])) {
    return 10;
  }
  if (/\bp016(?:le|be)?\b/i.test(videoLine[0])) {
    return 16;
  }
  if (/\byuv[a-z0-9]*p\b|\bnv12\b|\bnv21\b|\bgbrp\b/i.test(videoLine[0])) {
    return 8;
  }
  return null;
}
