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
 * @param {string} text - Decoded subtitle text (VTT/SRT/ASS — franc ignores markup well enough).
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
