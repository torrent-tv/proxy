/**
 * @file A subtitle track whose cues are text, and everything that follows from
 * that being true.
 *
 * Matroska: `S_TEXT/UTF8`, `S_TEXT/ASS`, `S_TEXT/SSA`, `S_TEXT/WEBVTT`
 * (RFC 9559). MP4: `tx3g`, `text`, `wvtt` (`stpp`/TTML is XML and is not text
 * for this pipeline). A file beside the film is one of these too, with no
 * container behind it.
 *
 * Two axes meet on a subtitle cue and only ONE of them is here. How a cue's
 * bytes are FRAMED is stated by the container's specification and is answered
 * by `container/`: Matroska reorders an ASS dialogue row and drops its two
 * timing fields (`matroska.org/technical/subtitles.html`), a `.ass` file states
 * its own field order in the `Format:` line of `[Events]`, an MP4 carries each
 * cue as a sample with a length prefix. What the CODEC then puts inside that
 * text — override groups in braces, `\N` and `\n` for a break, `\h` for a hard
 * space — is a fact about ASS wherever it is stored, and that is this file,
 * along with writing the cues out as WebVTT.
 *
 * The two were one function until 2.72.1, which is what showed English
 * subtitles as `21,0,Default,,0000,0000,0000,,I am the powerful Demon King`:
 * it counted commas to guess which framing it held, expected the ten fields of
 * a row in a FILE, and a Matroska block carries nine. A function that has to
 * guess the shape of its input is being called by someone who knew and did not
 * say.
 */

import { SubtitleTrack } from "./SubtitleTrack.js";
import { detectLanguage } from "../language-detect.js";

const TEXT_CODECS_MATROSKA = new Set(["S_TEXT/UTF8", "S_TEXT/ASS", "S_TEXT/SSA", "S_TEXT/WEBVTT"]);
const TEXT_FORMATS_MP4 = new Set(["tx3g", "text", "wvtt"]);

/** How a cue's text is marked up, once the container's framing is off. */
export const MarkupKind = {
  /** Sub Station Alpha and its advanced form: `{\pos(…)}`, `\N`, `\h`. */
  ASS: "ass",
  /** Nothing to strip: the text is what is shown. */
  NONE: "none"
};

/**
 * Which markup a codec's cue text carries, by any of the codec's names.
 *
 * The keys are every name this proxy has for a text subtitle codec: Matroska
 * CodecIDs (RFC 9559 §5.1.4.1.28 and the codec mappings beside it), MP4 sample
 * entry types (ISO/IEC 14496-12 §12.6, plus Apple's `tx3g`), and the file
 * extensions a subtitle shipped beside the film uses. They are listed together
 * because the ANSWER is the same for all of them — ASS is ASS whether it sits
 * in a Matroska block, in a file, or nowhere yet — and keeping three tables
 * would mean three places to forget.
 *
 * @type {Map<string, string>}
 */
const MARKUP_BY_CODEC = new Map([
  ["S_TEXT/ASS", MarkupKind.ASS],
  ["S_TEXT/SSA", MarkupKind.ASS],
  [".ass", MarkupKind.ASS],
  [".ssa", MarkupKind.ASS],
  ["S_TEXT/UTF8", MarkupKind.NONE],
  ["S_TEXT/WEBVTT", MarkupKind.NONE],
  [".srt", MarkupKind.NONE],
  [".vtt", MarkupKind.NONE],
  [".webvtt", MarkupKind.NONE],
  ["tx3g", MarkupKind.NONE],
  ["text", MarkupKind.NONE],
  ["wvtt", MarkupKind.NONE]
]);

/** How long a cue with no stated end is shown, when no cue follows it. */
const OPEN_ENDED_CUE_SECONDS = 4;

export class TextSubtitleTrack extends SubtitleTrack {
  constructor(params) {
    super(params);
    this.textCodec = params.codecId ?? "";
  }

  isTextBased() {
    return true;
  }

  /**
   * Which markup a codec's cue text carries.
   *
   * An unknown codec is answered `NONE` rather than refused: the text is then
   * shown as it is, which is wrong only in so far as some markup stays visible,
   * where a refusal would show nothing at all.
   *
   * @param {string} codecId - Matroska CodecID, MP4 sample entry type, or a
   *   file extension including the dot. Case is ignored for extensions, which
   *   arrive from file names, and kept for the others, which a spec spells.
   * @returns {string} One of {@link MarkupKind}.
   */
  static markupKindOf(codecId) {
    const name = String(codecId ?? "");
    return MARKUP_BY_CODEC.get(name) ?? MARKUP_BY_CODEC.get(name.toLowerCase()) ?? MarkupKind.NONE;
  }

  /**
   * The visible text of one cue: its markup taken off, nothing else touched.
   *
   * @param {string} text - The cue's text FIELD, already out of the container's
   *   framing. Handing a whole dialogue row to this is the mistake described at
   *   the top of this file.
   * @param {string} codecId
   * @returns {string} Possibly empty — a cue whose text is only a drawing
   *   command or a positioning group has nothing to show, and the caller drops
   *   it.
   */
  static plainTextOf(text, codecId) {
    const raw = String(text ?? "");
    if (TextSubtitleTrack.markupKindOf(codecId) !== MarkupKind.ASS) {
      return raw.trim();
    }
    return raw
      // An override group. Any brace content is a directive, never dialogue:
      // drawing commands, karaoke timing, positioning, font changes.
      .replace(/\{[^}]*\}/g, "")
      // Both breaks reach a player as a break. ASS distinguishes them — `\N` is
      // always a break, `\n` only where the style does not wrap — and a WebVTT
      // cue has no way to express the difference, so it takes the break.
      .replace(/\\N/g, "\n")
      .replace(/\\n/g, "\n")
      // A space the renderer may not collapse.
      .replace(/\\h/g, " ")
      .trim();
  }

  /**
   * One cue's start or end as WebVTT writes it: `hh:mm:ss.mmm`.
   *
   * @param {number} seconds
   * @returns {string}
   */
  static vttTime(seconds) {
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
   * A cue with no duration — a Matroska SimpleBlock, which subtitles rarely use
   * — is given the time until the next one IN THIS LIST, and the last such cue
   * a few seconds. Not an invention about the film: it is what a player does
   * with an open-ended cue, made explicit so every consumer agrees on it.
   *
   * @param {{ startSeconds: number, endSeconds?: number | null, text: string }[]} cues
   * @param {string} codecId
   * @returns {{ startSeconds: number, endSeconds: number, text: string }[]}
   */
  static finalizeCues(cues, codecId) {
    const result = [];
    (Array.isArray(cues) ? cues : []).forEach((cue, index) => {
      const next = cues[index + 1];
      const endSeconds =
        cue.endSeconds ?? (next ? next.startSeconds : cue.startSeconds + OPEN_ENDED_CUE_SECONDS);
      const text = TextSubtitleTrack.plainTextOf(cue.text, codecId);
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
  static cuesToVtt(cues, codecId) {
    const lines = ["WEBVTT", ""];
    for (const cue of TextSubtitleTrack.finalizeCues(cues, codecId)) {
      lines.push(`${TextSubtitleTrack.vttTime(cue.startSeconds)} --> ${TextSubtitleTrack.vttTime(cue.endSeconds)}`);
      lines.push(cue.text);
      lines.push("");
    }
    return lines.join("\n");
  }

  /**
   * The words of a WebVTT document — what a viewer reads, with everything the
   * format puts around them removed.
   *
   * A WebVTT document is a series of blocks separated by blank lines. A block
   * that holds a timing line (`00:00:12.060 --> 00:00:13.270`) is a cue, and the
   * lines after that timing line are its text; the lines before it are the cue's
   * optional identifier. A block with NO timing line is the `WEBVTT` header or a
   * `NOTE` / `STYLE` / `REGION` block, and none of those is anybody's language.
   * That one rule removes the identifiers, the timings and the headers together.
   *
   * What is left can still carry WebVTT's own inline markup — `<v Speaker>`,
   * `<i>`, `<c.yellow>` — and character references. Both are dropped: a speaker
   * name and a class name are written in whatever language the releaser's tooling
   * used, which is not the language of the film.
   *
   * @param {string} vtt - A WebVTT document.
   * @returns {string} The cue text, blocks joined by newlines.
   */
  static cueTextOfVtt(vtt) {
    if (typeof vtt !== "string") {
      return "";
    }
    const blocks = vtt.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split(/\n{2,}/);
    const spoken = [];
    for (const block of blocks) {
      const lines = block.split("\n");
      const timingAt = lines.findIndex((line) => line.includes("-->"));
      if (timingAt < 0) {
        continue;
      }
      for (const line of lines.slice(timingAt + 1)) {
        spoken.push(line);
      }
    }
    return spoken
      .join("\n")
      .replace(/<[^>]*>/g, "")
      // A character reference stands for one character and never for a word, so a
      // space in its place keeps the neighbouring words apart and adds nothing.
      .replace(/&[a-z]+;|&#\d+;|&#x[0-9a-f]+;/gi, " ")
      .trim();
  }

  /**
   * Detect the language of a WebVTT document, reading only its cue text.
   *
   * @param {string} vtt - A WebVTT document.
   * @returns {{ code: string, name: string } | null} Detected language, or null when uncertain.
   */
  static detectLanguageFromVtt(vtt) {
    return detectLanguage(TextSubtitleTrack.cueTextOfVtt(vtt));
  }

  static isTextCodec(codecId) {
    return TEXT_CODECS_MATROSKA.has(codecId) || TEXT_FORMATS_MP4.has(codecId);
  }

  /** Which markup this track's cue text carries. */
  get markupKind() {
    return TextSubtitleTrack.markupKindOf(this.textCodec);
  }

  /**
   * The visible text of one of this track's cues.
   *
   * @param {string} textField - The cue's text field, already out of its
   *   container's framing. This method knows the codec and not the container,
   *   which is why it cannot be handed a whole dialogue row.
   * @returns {string}
   */
  plainText(textField) {
    return TextSubtitleTrack.plainTextOf(textField, this.textCodec);
  }

  /**
   * This track's cues, resolved and stripped, as a player reads them.
   *
   * @param {{ startSeconds: number, endSeconds?: number | null, text: string }[]} cues
   * @returns {{ startSeconds: number, endSeconds: number, text: string }[]}
   */
  finalize(cues) {
    return TextSubtitleTrack.finalizeCues(cues, this.textCodec);
  }

  /**
   * This track's cues as a WebVTT document.
   *
   * @param {{ startSeconds: number, endSeconds?: number | null, text: string }[]} cues
   * @returns {string}
   */
  toVtt(cues) {
    return TextSubtitleTrack.cuesToVtt(cues, this.textCodec);
  }
}

export { TEXT_CODECS_MATROSKA, TEXT_FORMATS_MP4 };
