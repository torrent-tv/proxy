/**
 * @file Subtitle conversion (proxy side).
 *
 * Decodes subtitle file bytes (encoding-aware) and converts SubRip (.srt) and
 * ASS/SSA (.ass/.ssa) to WebVTT so the browser can attach them to a `<track>`
 * without any client-side conversion. The proxy owns subtitle conversion so it
 * can also run language detection where the full text is available.
 */

/**
 * Decode subtitle bytes to text. Prefers UTF-8 (honouring a BOM); if the UTF-8
 * decode yields many replacement characters the bytes are re-decoded as
 * Windows-1251 (very common for Russian .srt files) — otherwise both display
 * and language detection would see mojibake.
 *
 * @param {Buffer | Uint8Array} bytes
 * @returns {string}
 */
export function decodeSubtitleBytes(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // UTF-8 BOM → definitely UTF-8.
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(buf);
  }
  const utf8 = new TextDecoder("utf-8").decode(buf);
  const replacements = (utf8.match(/�/g) || []).length;
  // >0.5% replacement chars ⇒ not valid UTF-8; try the common legacy Cyrillic
  // codepage. TextDecoder supports windows-1251 with a full-ICU Node build.
  if (replacements > Math.max(2, utf8.length * 0.005)) {
    try {
      return new TextDecoder("windows-1251").decode(buf);
    } catch {
      // Decoder unavailable — fall back to the UTF-8 attempt.
    }
  }
  return utf8;
}

/** Strip a leading UTF-8 BOM so it never leaks into the WEBVTT signature or first cue. */
function stripBom(text) {
  return typeof text === "string" && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function srtTsToVtt(ts) {
  return ts.replace(",", ".");
}

/**
 * Convert SubRip (.srt) text to WebVTT.
 *
 * @param {string} text
 * @returns {string}
 */
function srtToVtt(text) {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out = ["WEBVTT", ""];
  for (const line of lines) {
    const m = line.match(/^(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})(.*)?$/);
    out.push(m ? `${srtTsToVtt(m[1])} --> ${srtTsToVtt(m[2])}${m[3] ?? ""}` : line);
  }
  return out.join("\n");
}

function assTsToVtt(ts) {
  const m = ts.match(/^(\d+):(\d{2}):(\d{2})\.(\d{2})$/);
  if (!m) {
    return "00:00:00.000";
  }
  const ms = (parseInt(m[4], 10) * 10).toString().padStart(3, "0");
  return `${m[1].padStart(2, "0")}:${m[2]}:${m[3]}.${ms}`;
}

function stripAssTags(text) {
  return text
    .replace(/\{[^}]*\}/g, "")
    .replace(/\\N/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\h/g, " ")
    .trim();
}

/**
 * Convert ASS/SSA text to WebVTT (only the [Events] section; styling dropped).
 *
 * @param {string} text
 * @returns {string}
 */
function assToVtt(text) {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let inEvents = false;
  let formatCols = null;
  const cues = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "[Events]") {
      inEvents = true;
      continue;
    }
    if (trimmed.startsWith("[") && trimmed.endsWith("]") && inEvents) {
      inEvents = false;
      continue;
    }
    if (!inEvents) {
      continue;
    }
    if (trimmed.startsWith("Format:")) {
      formatCols = trimmed.slice("Format:".length).split(",").map((c) => c.trim().toLowerCase());
      continue;
    }
    if (trimmed.startsWith("Dialogue:") && formatCols) {
      const parts = trimmed.slice("Dialogue:".length).split(",");
      const startIdx = formatCols.indexOf("start");
      const endIdx = formatCols.indexOf("end");
      const textIdx = formatCols.indexOf("text");
      if (startIdx < 0 || endIdx < 0 || textIdx < 0) {
        continue;
      }
      const cueText = stripAssTags(parts.slice(textIdx).join(","));
      if (!cueText) {
        continue;
      }
      cues.push(`${assTsToVtt((parts[startIdx] ?? "").trim())} --> ${assTsToVtt((parts[endIdx] ?? "").trim())}\n${cueText}`);
    }
  }
  return cues.length === 0 ? "WEBVTT\n" : `WEBVTT\n\n${cues.join("\n\n")}`;
}

/**
 * Convert subtitle text to WebVTT by file extension. Returns null for formats
 * that cannot be converted in-place (image-based .sup, ambiguous .sub, .ttml).
 *
 * @param {string} text
 * @param {string} ext - Lowercase extension including the dot, e.g. ".srt".
 * @returns {string | null}
 */
export function convertSubtitleToVtt(text, ext) {
  const clean = stripBom(text);
  switch (ext) {
    case ".vtt":
    case ".webvtt":
      return clean.trimStart().startsWith("WEBVTT") ? clean : `WEBVTT\n\n${clean}`;
    case ".srt":
      return srtToVtt(clean);
    case ".ass":
    case ".ssa":
      return assToVtt(clean);
    default:
      return null;
  }
}
