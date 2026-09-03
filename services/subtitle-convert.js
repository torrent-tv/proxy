/**
 * @file Subtitle conversion (proxy side).
 *
 * Decodes subtitle file bytes (encoding-aware) and converts SubRip (.srt) and
 * ASS/SSA (.ass/.ssa) to WebVTT so the browser can attach them to a `<track>`
 * without any client-side conversion. The proxy owns subtitle conversion so it
 * can also run language detection where the full text is available.
 *
 * Reading a format's own framing is NOT here — it is `SubtitleFileContainer`
 * for a file beside the film, and `MatroskaContainer` / `Mp4Container` for a
 * track inside it. What is here is everything after that: a cue's missing end
 * time, its codec's markup, and writing the WebVTT document. One writer, so a
 * pushed cue and a pulled one cannot read differently.
 */

import { SubtitleFileContainer } from "./container/SubtitleFileContainer.js";
import { plainCueText } from "./tracks/subtitle-markup.js";

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

/**
 * One cue's start or end as WebVTT writes it: `hh:mm:ss.mmm`.
 *
 * @param {number} seconds
 * @returns {string}
 */
export function vttTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const rest = safe % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${rest.toFixed(3).padStart(6, "0")}`;
}

/**
 * Resolve what a cue is missing and take its codec's markup off, so what is
 * left is what a player shows.
 *
 * The container's framing is NOT undone here — it is undone where the cue is
 * read, by the container that framed it, which is the only place the framing is
 * known. Until 2.72.1 this function tried to do both by counting commas, and
 * on an embedded ASS track it showed every field of the dialogue row to the
 * viewer.
 *
 * A cue with no duration — a Matroska SimpleBlock, which subtitles rarely use —
 * is given the time until the next one IN THIS LIST, and the last such cue a
 * few seconds. Not an invention about the film: it is what a player does with
 * an open-ended cue, made explicit so every consumer agrees on it.
 *
 * @param {{ startSeconds: number, endSeconds?: number | null, text: string }[]} cues
 * @param {string} codecId
 * @returns {{ startSeconds: number, endSeconds: number, text: string }[]}
 */
export function finalizeCues(cues, codecId) {
  const result = [];
  (Array.isArray(cues) ? cues : []).forEach((cue, index) => {
    const next = cues[index + 1];
    const endSeconds = cue.endSeconds ?? (next ? next.startSeconds : cue.startSeconds + 4);
    const text = plainCueText(cue.text, codecId);
    if (!text) {
      return;
    }
    result.push({ startSeconds: cue.startSeconds, endSeconds, text });
  });
  return result;
}

/**
 * A WebVTT document from a list of cues — the one writer, used by every path
 * that produces subtitles: a file beside the film, a track inside it, a pull
 * and a push.
 *
 * @param {{ startSeconds: number, endSeconds?: number | null, text: string }[]} cues
 * @param {string} codecId
 * @returns {string}
 */
export function cuesToVtt(cues, codecId) {
  const lines = ["WEBVTT", ""];
  for (const cue of finalizeCues(cues, codecId)) {
    lines.push(`${vttTime(cue.startSeconds)} --> ${vttTime(cue.endSeconds)}`);
    lines.push(cue.text);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Convert subtitle text to WebVTT by file extension. Returns null for formats
 * that cannot be converted in-place (image-based .sup, ambiguous .sub, .ttml).
 *
 * The reading is `SubtitleFileContainer`'s: the file states how its own cues
 * are framed — SubRip by position, ASS by the `Format:` line of `[Events]` —
 * and that is a fact about the file, not about this conversion.
 *
 * @param {string} text
 * @param {string} ext - Lowercase extension including the dot, e.g. ".srt".
 * @returns {string | null}
 */
export function convertSubtitleToVtt(text, ext) {
  const clean = stripBom(text);
  const extension = String(ext ?? "").toLowerCase();
  if (extension === ".vtt" || extension === ".webvtt") {
    // Already what a browser reads. Parsing it to write it back would drop its
    // styles, its regions and its cue identifiers for nothing.
    return clean.trimStart().startsWith("WEBVTT") ? clean : `WEBVTT\n\n${clean}`;
  }
  if (!SubtitleFileContainer.detect(extension)) {
    return null;
  }
  const cues = new SubtitleFileContainer({ extension }).readCues(clean);
  return cues === null ? null : cuesToVtt(cues, extension);
}
