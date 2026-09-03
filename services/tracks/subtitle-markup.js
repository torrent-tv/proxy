/**
 * @file The markup a subtitle codec puts INSIDE the text of one cue, and how to
 * take it off. One axis of variation, and only one.
 *
 * Nothing here knows which container the text came out of. That is the other
 * axis and it belongs to `container/`: how a cue's bytes are framed is stated by
 * the CONTAINER's specification, not by the subtitle format's. Matroska
 * reorders an ASS dialogue row and drops its two timing fields
 * (`matroska.org/technical/subtitles.html`); a `.ass` file states its own field
 * order in the `Format:` line of `[Events]`; an MP4 carries each cue as a sample
 * with a length prefix. Every one of those is a fact about the container.
 *
 * What IS a fact about ASS, wherever it is stored: override groups in braces,
 * `\N` and `\n` for a line break, `\h` for a hard space. That is this file.
 *
 * The two were mixed in one function until 2.72.1, which is what broke English
 * subtitles on an embedded ASS track: the function counted commas to guess
 * which framing it had been handed, expected ten fields — the shape of a row in
 * a FILE — and a Matroska block carries nine. Every field of the row was then
 * shown to the viewer as if it were dialogue. A function that has to guess the
 * shape of its input is being called by someone who knew and did not say.
 */

/** How a cue's text is marked up, once the container's framing is off. */
export const MarkupKind = {
  /** Sub Station Alpha and its advanced form: `{\pos(…)}`, `\N`, `\h`. */
  ASS: "ass",
  /** Nothing to strip: the text is what is shown. */
  NONE: "none"
};

/**
 * Which markup a codec's cue text carries.
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

/**
 * The markup kind of a codec, by any of its names.
 *
 * An unknown codec is answered `NONE` rather than refused: the text is then
 * shown as it is, which is wrong only in so far as some markup stays visible,
 * where a refusal would show nothing at all.
 *
 * @param {string} codecId - Matroska CodecID, MP4 sample entry type, or a file
 *   extension including the dot. Case is ignored for extensions, which arrive
 *   from file names, and kept for the others, which are spelled by a spec.
 * @returns {string} One of {@link MarkupKind}.
 */
export function markupKindOf(codecId) {
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
 * @returns {string} Possibly empty — a cue whose text is only a drawing command
 *   or a positioning group has nothing to show, and the caller drops it.
 */
export function plainCueText(text, codecId) {
  const raw = String(text ?? "");
  if (markupKindOf(codecId) !== MarkupKind.ASS) {
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
