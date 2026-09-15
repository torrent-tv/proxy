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
 * The least text, in characters, that supports an answer of each language.
 *
 * MEASURED, not chosen — `research/franc-boundary-2026-09-02.md`. Method:
 * Wikipedia extracts per language (deliberately NOT the UDHR, which is what
 * franc's own profiles are built from and would read optimistically), 120
 * windows cut at random from them at each length of a ladder from 40 to 1300
 * characters, and the figure recorded is the shortest length from which franc
 * answered correctly in at least 95 % of trials AND kept doing so at every
 * longer length measured.
 *
 * Why it is per language rather than one number: the answer is not equally hard
 * to reach, and the spread is fivefold. Greek and Korean settle at 40
 * characters because their script settles it; English needs 130; Russian and
 * Czech need 650, because each competes with neighbours in this very list for
 * the same trigrams — Russian with Bulgarian, Serbian and Ukrainian, Czech with
 * Slovak.
 *
 * Two languages are deliberately ABSENT. Swedish and Chinese did not settle
 * anywhere in the ladder on the corpora collected, so no figure for them is
 * measured and none is invented; they take the fallback below.
 *
 * A language with no entry gets the WORST measured figure. That is the
 * conservative reading and it is still a measurement rather than a guess: it
 * says "no better than the hardest language we have measured".
 *
 * @type {Record<string, number>}
 */
const LEAST_TEXT = {
  bel: 100,
  bul: 80,
  ces: 650,
  deu: 200,
  ell: 40,
  eng: 130,
  fra: 80,
  heb: 60,
  ita: 160,
  kor: 40,
  nld: 130,
  pol: 200,
  por: 200,
  rus: 650,
  spa: 100,
  srp: 100,
  tur: 160,
  ukr: 250
};

/** The worst measured figure, used for any language not in the table. */
const LEAST_TEXT_WORST = Math.max(...Object.values(LEAST_TEXT), 0);

/** franc's own floor: below this it is not asked at all. */
const FRANC_FLOOR = 15;

/** One space between words, nothing else — the form every figure above is in. */
function normalise(text) {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

/**
 * franc's answer for this text, or null when it has none.
 *
 * @param {string} text
 * @returns {string | null} ISO 639-3.
 */
function ask(text) {
  if (text.length < FRANC_FLOOR) {
    return null;
  }
  const iso3 = franc(text, { only: ONLY, minLength: FRANC_FLOOR });
  return iso3 === "und" ? null : iso3;
}

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
  const words = normalise(text);
  if (words.length < FRANC_FLOOR) {
    return null;
  }
  const candidate = ask(words);
  if (candidate === null) {
    return null;
  }
  // Enough text to support THIS answer. The figure is the language's own,
  // because the languages are not alike: Russian shares its trigrams with
  // Bulgarian, Serbian and Ukrainian and needs several times what English does.
  if (words.length < (LEAST_TEXT[candidate] ?? LEAST_TEXT_WORST)) {
    return null;
  }
  // And an answer that does not survive losing half the text was an accident of
  // where the text happened to stop, not a reading of it. Free — franc costs
  // about 2 ms whatever the size, measured — and it needs no figure of its own,
  // because the test is taken on the text in hand.
  const middle = Math.floor(words.length / 2);
  if (ask(words.slice(0, middle)) !== candidate || ask(words.slice(middle)) !== candidate) {
    return null;
  }
  return LANG_3_TO_1[candidate] ?? null;
}
