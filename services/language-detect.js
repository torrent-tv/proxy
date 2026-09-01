/**
 * @file Content-based subtitle language detection (proxy side).
 *
 * Uses `franc` (n-gram / trigram frequency against per-language reference
 * profiles — MIT). Runs on the proxy where the full subtitle text and
 * node_modules live, so no detection model ships to the browser. Detection is
 * restricted to a curated set of plausible subtitle languages via franc's
 * `only` option: this both maps ISO 639-3 → ISO 639-1 + English name and
 * avoids exotic false positives on short text (e.g. English mis-detected as
 * Scots). Returns null when franc is not confident (too little text, or
 * undetermined).
 */

import { franc } from "franc";

/** ISO 639-3 (franc output) → { code: ISO 639-1 / BCP-47, name }. Curated allowlist. */
const LANG_3_TO_1 = {
  eng: { code: "en", name: "English" },
  rus: { code: "ru", name: "Russian" },
  ukr: { code: "uk", name: "Ukrainian" },
  bel: { code: "be", name: "Belarusian" },
  jpn: { code: "ja", name: "Japanese" },
  kor: { code: "ko", name: "Korean" },
  cmn: { code: "zh", name: "Chinese" },
  spa: { code: "es", name: "Spanish" },
  fra: { code: "fr", name: "French" },
  deu: { code: "de", name: "German" },
  ita: { code: "it", name: "Italian" },
  por: { code: "pt", name: "Portuguese" },
  pol: { code: "pl", name: "Polish" },
  nld: { code: "nl", name: "Dutch" },
  arb: { code: "ar", name: "Arabic" },
  tur: { code: "tr", name: "Turkish" },
  vie: { code: "vi", name: "Vietnamese" },
  tha: { code: "th", name: "Thai" },
  hin: { code: "hi", name: "Hindi" },
  ind: { code: "id", name: "Indonesian" },
  zlm: { code: "ms", name: "Malay" },
  ces: { code: "cs", name: "Czech" },
  slk: { code: "sk", name: "Slovak" },
  ron: { code: "ro", name: "Romanian" },
  hun: { code: "hu", name: "Hungarian" },
  srp: { code: "sr", name: "Serbian" },
  hrv: { code: "hr", name: "Croatian" },
  bul: { code: "bg", name: "Bulgarian" },
  ell: { code: "el", name: "Greek" },
  heb: { code: "he", name: "Hebrew" },
  dan: { code: "da", name: "Danish" },
  fin: { code: "fi", name: "Finnish" },
  nob: { code: "no", name: "Norwegian" },
  swe: { code: "sv", name: "Swedish" },
  fas: { code: "fa", name: "Persian" }
};

const ONLY = Object.keys(LANG_3_TO_1);

/**
 * Best-effort detect the language of subtitle text.
 *
 * **Give this the words a viewer reads and nothing else.** franc scores letter
 * trigrams over the whole string it is handed, so anything around the words
 * competes with them. An ASS file is markup by half: measured 2026-09-01 on
 * `[HorribleSubs] Drifters - 03 [1080p].ass`, 5040 Latin characters of Aegisub
 * headers, style and font names, `Format:`/`Dialogue:` field prefixes and
 * `{\…}` override groups against 5983 Cyrillic characters of dialogue —
 * `franc(the file) = eng`, `franc(the dialogue) = rus`. The proxy had already
 * built the markup-free text and detected on the file anyway, so a Russian
 * track was offered to the viewer as English.
 *
 * `detectLanguageFromVtt` below is the safe entry point for a whole document;
 * this one is for text that is already only text.
 *
 * @param {string} text - Subtitle text with no markup left in it.
 * @returns {{ code: string, name: string } | null} Detected language, or null when uncertain.
 */
export function detectLanguage(text) {
  if (typeof text !== "string" || text.trim().length < 15) {
    return null;
  }
  // Restrict to plausible subtitle languages; require a little text.
  const iso3 = franc(text, { only: ONLY, minLength: 15 });
  if (iso3 === "und") {
    return null;
  }
  return LANG_3_TO_1[iso3] ?? null;
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
export function cueTextOfVtt(vtt) {
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
export function detectLanguageFromVtt(vtt) {
  return detectLanguage(cueTextOfVtt(vtt));
}
