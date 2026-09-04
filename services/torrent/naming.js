/**
 * @file What a file NAME says about a track shipped beside the video.
 *
 * A name is written by the person who made the file, and reading it costs
 * nothing. Content detection is a guess — and a guess that is measurably wrong
 * on short text (`research/subtitle-language-ass-markup-2026-09-01.md` §6) — so
 * every name we can read is one track that never has to be guessed at.
 *
 * The grammar here is the UNION of what five players already implement, and
 * every rule in it is in at least two of them. Nothing is invented. Sources,
 * all read 2026-09-01 and quoted in
 * `research/sidecar-naming-conventions-2026-09-01.md`:
 *
 * - **Jellyfin** (`Emby.Naming/ExternalFiles/ExternalPathParser.cs`,
 *   `Common/NamingOptions.cs`): the `.` delimiter, the three flag lists, tokens
 *   read from the END backwards, the last language winning, the `hi`/Hindi
 *   collision resolved by whether another language is present, and leftover
 *   text becoming the stream title.
 * - **Plex** ("Adding Local Subtitles to Your Media"): the language code is
 *   "ISO-639-1 (2-letter) or ISO-639-2/B (3-letter)", flags after it.
 * - **Kodi** (wiki, "Subtitles"): `<movie name>.<language>.<ext>`, where the
 *   language "can be an ISO 639-1 or ISO 639-2 code, a BCP 47 tag (with `-`
 *   characters replaced with `_`) or the English name of a language"; the
 *   forced flag may be separated by a dot, a space or a dash.
 * - **mpv** (`misc/language.c`): the delimiter is taken from the LAST
 *   character — `(` when the name ends `)`, `[` when it ends `]` — which covers
 *   `Movie (Russian)` and `Movie [rus]` with one rule instead of a list of
 *   bracket shapes; and BCP-47 shape, primary subtag of 2 or 3 letters.
 * - **VLC** (`src/libvlc-module.c`): the folders that mean "subtitles live
 *   here" and NOT a language — its default `sub-autodetect-path` is
 *   `./Subtitles, ./subtitles, ./Subs, ./subs`.
 *
 * Used for BOTH subtitles and soundtracks, because both are the same question
 * about the same kind of path.
 */

/**
 * One language, with every spelling a release might use for it.
 *
 * `aliases` carries: the ISO 639-1 code, BOTH ISO 639-2 sets where they differ
 * (Plex names the bibliographic set, ffmpeg and Matroska write either), the
 * English name, and — for the languages these trackers actually carry — the
 * name in Russian, because a Russian release names its folders in Russian.
 *
 * @type {Array<{ code: string, name: string, aliases: string[] }>}
 */
const LANGUAGES = [
  { code: "en", name: "English", aliases: ["en", "eng", "english", "английский", "англ", "англи", "английские", "инглиш"] },
  { code: "ru", name: "Russian", aliases: ["ru", "rus", "russian", "русский", "рус", "русские", "русск"] },
  { code: "uk", name: "Ukrainian", aliases: ["uk", "ukr", "ukrainian", "українська", "укр", "украинский"] },
  { code: "be", name: "Belarusian", aliases: ["be", "bel", "belarusian", "беларуская", "белорусский"] },
  { code: "ja", name: "Japanese", aliases: ["ja", "jpn", "japanese", "японский", "яп", "японские"] },
  { code: "ko", name: "Korean", aliases: ["ko", "kor", "korean", "корейский"] },
  { code: "zh", name: "Chinese", aliases: ["zh", "chi", "zho", "chinese", "китайский"] },
  { code: "zh-Hans", name: "Chinese (Simplified)", aliases: ["chs", "hans", "simplified"] },
  { code: "zh-Hant", name: "Chinese (Traditional)", aliases: ["cht", "hant", "traditional"] },
  { code: "es", name: "Spanish", aliases: ["es", "spa", "spanish", "espanol", "español", "испанский"] },
  { code: "fr", name: "French", aliases: ["fr", "fre", "fra", "french", "francais", "français", "французский"] },
  { code: "de", name: "German", aliases: ["de", "ger", "deu", "german", "deutsch", "немецкий"] },
  { code: "it", name: "Italian", aliases: ["it", "ita", "italian", "italiano", "итальянский"] },
  { code: "pt", name: "Portuguese", aliases: ["pt", "por", "portuguese", "portugues", "português", "португальский"] },
  { code: "pl", name: "Polish", aliases: ["pl", "pol", "polish", "polski", "польский"] },
  { code: "nl", name: "Dutch", aliases: ["nl", "dut", "nld", "dutch", "nederlands", "голландский", "нидерландский"] },
  { code: "ar", name: "Arabic", aliases: ["ar", "ara", "arabic", "арабский"] },
  { code: "tr", name: "Turkish", aliases: ["tr", "tur", "turkish", "türkçe", "турецкий"] },
  { code: "vi", name: "Vietnamese", aliases: ["vi", "vie", "vietnamese", "вьетнамский"] },
  { code: "th", name: "Thai", aliases: ["th", "tha", "thai", "тайский"] },
  { code: "hi", name: "Hindi", aliases: ["hi", "hin", "hindi", "хинди"] },
  { code: "id", name: "Indonesian", aliases: ["id", "ind", "indonesian", "индонезийский"] },
  { code: "ms", name: "Malay", aliases: ["ms", "may", "msa", "malay", "малайский"] },
  { code: "cs", name: "Czech", aliases: ["cs", "cze", "ces", "czech", "чешский"] },
  { code: "sk", name: "Slovak", aliases: ["sk", "slo", "slk", "slovak", "словацкий"] },
  { code: "ro", name: "Romanian", aliases: ["ro", "rum", "ron", "romanian", "румынский"] },
  { code: "hu", name: "Hungarian", aliases: ["hu", "hun", "hungarian", "венгерский"] },
  { code: "sr", name: "Serbian", aliases: ["sr", "srp", "serbian", "српски", "сербский"] },
  { code: "hr", name: "Croatian", aliases: ["hr", "hrv", "croatian", "hrvatski", "хорватский"] },
  { code: "bs", name: "Bosnian", aliases: ["bs", "bos", "bosnian", "боснийский"] },
  { code: "sl", name: "Slovenian", aliases: ["sl", "slv", "slovenian", "словенский"] },
  { code: "bg", name: "Bulgarian", aliases: ["bg", "bul", "bulgarian", "български", "болгарский"] },
  { code: "mk", name: "Macedonian", aliases: ["mk", "mac", "mkd", "macedonian", "македонский"] },
  { code: "el", name: "Greek", aliases: ["el", "gre", "ell", "greek", "греческий"] },
  { code: "he", name: "Hebrew", aliases: ["he", "heb", "hebrew", "иврит"] },
  { code: "da", name: "Danish", aliases: ["da", "dan", "danish", "датский"] },
  { code: "fi", name: "Finnish", aliases: ["fi", "fin", "finnish", "suomi", "финский"] },
  { code: "no", name: "Norwegian", aliases: ["no", "nor", "nob", "nno", "norwegian", "норвежский"] },
  { code: "sv", name: "Swedish", aliases: ["sv", "swe", "swedish", "svenska", "шведский"] },
  { code: "et", name: "Estonian", aliases: ["et", "est", "estonian", "эстонский"] },
  { code: "lv", name: "Latvian", aliases: ["lv", "lav", "latvian", "латышский"] },
  { code: "lt", name: "Lithuanian", aliases: ["lt", "lit", "lithuanian", "литовский"] },
  { code: "fa", name: "Persian", aliases: ["fa", "per", "fas", "persian", "farsi", "персидский"] },
  { code: "ka", name: "Georgian", aliases: ["ka", "geo", "kat", "georgian", "грузинский"] },
  { code: "hy", name: "Armenian", aliases: ["hy", "arm", "hye", "armenian", "армянский"] },
  { code: "az", name: "Azerbaijani", aliases: ["az", "aze", "azerbaijani", "азербайджанский"] },
  { code: "kk", name: "Kazakh", aliases: ["kk", "kaz", "kazakh", "казахский"] },
  { code: "is", name: "Icelandic", aliases: ["is", "ice", "isl", "icelandic", "исландский"] },
  { code: "sq", name: "Albanian", aliases: ["sq", "alb", "sqi", "albanian", "албанский"] },
  { code: "eu", name: "Basque", aliases: ["eu", "baq", "eus", "basque"] },
  { code: "cy", name: "Welsh", aliases: ["cy", "wel", "cym", "welsh"] },
  { code: "ca", name: "Catalan", aliases: ["ca", "cat", "catalan", "català"] },
  { code: "gl", name: "Galician", aliases: ["gl", "glg", "galician"] },
  { code: "my", name: "Burmese", aliases: ["my", "bur", "mya", "burmese"] },
  { code: "bo", name: "Tibetan", aliases: ["bo", "tib", "bod", "tibetan"] },
  { code: "mi", name: "Maori", aliases: ["mi", "mao", "mri", "maori"] }
];

/** alias → { code, name }. Built once. */
const BY_ALIAS = new Map();
for (const language of LANGUAGES) {
  for (const alias of language.aliases) {
    BY_ALIAS.set(alias.toLowerCase(), { code: language.code, name: language.name });
  }
}

/**
 * Words that appear where a language would and are NOT one.
 *
 * Two kinds, and both are needed. A folder can say only that a KIND of track
 * lives in it — VLC's own default search path is `./Subtitles, ./subtitles,
 * ./Subs, ./subs`, and a Russian release writes the same thing in Russian. And
 * a name can carry a technical word that happens to sit where a language token
 * does. Today `Subs/` is safe only because no such word happens to be in the
 * language table; that is an accident, and this makes it a statement.
 */
const NEUTRAL_WORDS = new Set([
  "sub", "subs", "subtitle", "subtitles", "subtitulos", "sous", "titres",
  "sound", "audio", "dub", "dubs", "dubbed", "track", "tracks", "voice",
  "субтитры", "субтитр", "суб", "сабы", "саб", "титры",
  "звук", "звуковая", "звуковые", "дорожка", "дорожки", "аудио",
  "озвучка", "озвучание", "перевод", "переводы", "дубляж"
]);

/** Flags, per Jellyfin's `NamingOptions` and mpv's `language.c`. */
const FORCED_FLAGS = new Set(["forced", "foreign"]);
const HEARING_IMPAIRED_FLAGS = new Set(["sdh", "cc", "hi"]);
const DEFAULT_FLAGS = new Set(["default"]);

/**
 * Look up one bare token as a language.
 *
 * @param {string} token
 * @returns {{ code: string, name: string } | null}
 */
export function lookupLanguage(token) {
  if (typeof token !== "string") {
    return null;
  }
  return BY_ALIAS.get(token.trim().toLowerCase()) ?? null;
}

/**
 * Is this a word that names a KIND of track rather than a language?
 *
 * @param {string} token
 * @returns {boolean}
 */
export function isNeutralWord(token) {
  return typeof token === "string" && NEUTRAL_WORDS.has(token.trim().toLowerCase());
}

/**
 * Read one token as a language tag, keeping a region or script subtag.
 *
 * Kodi writes BCP-47 with `_` where the standard has `-` (its own example is
 * `The Matrix.zh_yue.srt`), so both separators are accepted. The whole tag is
 * KEPT — `pt-BR` against `pt-PT` is a distinction a viewer can see — while the
 * lookup is done on the primary subtag alone. Per BCP-47 and mpv's reading of
 * it: the primary subtag is 2 or 3 letters, later subtags are 1 to 8
 * alphanumerics.
 *
 * @param {string} token
 * @returns {{ code: string, name: string } | null}
 */
export function parseLanguageTag(token) {
  if (typeof token !== "string") {
    return null;
  }
  const trimmed = token.trim();
  if (trimmed.length === 0 || isNeutralWord(trimmed)) {
    return null;
  }
  const whole = lookupLanguage(trimmed);
  if (whole) {
    return whole;
  }
  const parts = trimmed.split(/[-_]/);
  if (parts.length < 2) {
    return null;
  }
  const primary = lookupLanguage(parts[0]);
  if (!primary || !/^[A-Za-z]{2,3}$/.test(parts[0])) {
    return null;
  }
  for (const subtag of parts.slice(1)) {
    if (!/^[A-Za-z0-9]{1,8}$/.test(subtag)) {
      return null;
    }
  }
  const base = primary.code.split("-")[0];
  return { code: [base, ...parts.slice(1)].join("-"), name: primary.name };
}

/**
 * Split a base name into the tokens a language or a flag could be.
 *
 * The delimiter follows mpv: `.` normally, but `(` when the name ends with `)`
 * and `[` when it ends with `]`, so `Movie (Russian)` and `Movie [rus]` need no
 * rule of their own. `_` is accepted alongside `.` because releases on these
 * trackers use it interchangeably (`Avatar_The_Last_Airbender_S02E01_1080p_rus`),
 * and neither character occurs inside a language code or a flag word.
 *
 * A trailing flag separated by a space or a dash is peeled off the last token,
 * which is Kodi's rule for the forced flag: it "can use a '.' (dot), ' '
 * (space) or '-' (dash) to separate them from the name of the movie and
 * language of the subtitles".
 *
 * @param {string} baseName - File name with its extension already removed.
 * @returns {string[]} Tokens in name order.
 */
export function tokenizeName(baseName) {
  const text = String(baseName ?? "").trim();
  if (text.length === 0) {
    return [];
  }
  // A bracketed tail is a token of its own; what comes BEFORE it is still split
  // the ordinary way, so `Film.rus [1080p]` yields `rus` rather than `.rus`.
  const bracketed = /^(.*)[([]([^()[\]]*)[)\]]$/.exec(text);
  const head = bracketed ? bracketed[1] : text;
  const tail = bracketed ? splitTrailingFlags(bracketed[2]) : [];
  const parts = head.split(/[._]/);
  const last = parts.pop() ?? "";
  return [...parts, ...splitTrailingFlags(last), ...tail];
}

/**
 * Peel flag words off the end of one token when a space or a dash separates
 * them — `"English Forced"` is two tokens, `"English"` is one.
 *
 * @param {string} token
 * @returns {string[]}
 */
function splitTrailingFlags(token) {
  let text = String(token ?? "").trim();
  const flags = [];
  for (;;) {
    // Only a trailing FLAG is peeled. The token is otherwise left exactly as it
    // is, because a dash is also what BCP-47 puts between subtags: splitting
    // `pt-BR` here would destroy the region before anything could read it.
    const match = /^(.*\S)[ -]+([A-Za-z]+)$/.exec(text);
    if (!match) {
      break;
    }
    const candidate = match[2].toLowerCase();
    if (!FORCED_FLAGS.has(candidate) && !HEARING_IMPAIRED_FLAGS.has(candidate) && !DEFAULT_FLAGS.has(candidate)) {
      break;
    }
    flags.unshift(match[2]);
    text = match[1];
  }
  return [text, ...flags].filter((word) => word.length > 0);
}

/**
 * @typedef {object} SidecarNameReading
 * @property {{ code: string, name: string } | null} language
 * @property {boolean} isForced
 * @property {boolean} isHearingImpaired
 * @property {boolean} isDefault
 * @property {string | null} title - Text that is neither a language nor a flag.
 */

/**
 * Read the language and the flags a sidecar's file name states.
 *
 * Two readings, and which one applies depends on whether the picture's name is
 * known — this is Jellyfin's own safeguard, and without it a name is dangerous
 * to read. Jellyfin parses only the part of the name that FOLLOWS the video's
 * name, because everything before it belongs to the film: `Movie.It.Follows.
 * 2014.srt` would otherwise be read as Italian.
 *
 * 1. **The name begins with the video's name.** Everything after it is the
 *    releaser speaking about this track, so every token in it is read, the last
 *    language token wins, and what is neither language nor flag is the title.
 * 2. **It does not** (or the video is unknown). Then tokens are read from the
 *    END backwards and reading STOPS at the first token that is neither a flag
 *    nor a language — mpv's rule, and the only safe one when the boundary
 *    between the film's name and the track's description is not known.
 *
 * @param {string} baseName - The sidecar's file name, extension removed.
 * @param {string} [videoBaseName] - The picture's file name, extension removed.
 * @returns {SidecarNameReading}
 */
/**
 * Whether a sidecar's base name continues the video's base name — and continues
 * it at a token boundary.
 *
 * The boundary is the whole of the rule's safety. Without it, "begins with the
 * video's name" pairs `Film.20.rus.srt` with `Film.2.mkv`: measured, and the
 * grammar then reports the leftover `0` as the track's title, which is the tell
 * that the remainder is a fragment of another film's name rather than anything
 * a releaser wrote about this track.
 *
 * The delimiters are the ones every surveyed player splits on — `.`, `_`, `-`,
 * space — plus mpv's bracket rule, so `Movie (Russian).srt` and `Movie [rus].srt`
 * are read as continuations too.
 *
 * @param {string} base - The sidecar's base name.
 * @param {string} video - The picture's base name.
 * @returns {boolean}
 */
export function nameFollows(base, video) {
  if (video.length === 0 || base.length < video.length) {
    return false;
  }
  if (!base.toLowerCase().startsWith(video.toLowerCase())) {
    return false;
  }
  if (base.length === video.length) {
    return true;
  }
  return /^[._\-\s([]/.test(base.slice(video.length));
}

export function readSidecarName(baseName, videoBaseName = "") {
  const reading = {
    language: null,
    isForced: false,
    isHearingImpaired: false,
    isDefault: false,
    title: null
  };
  const base = String(baseName ?? "").trim();
  if (base.length === 0) {
    return reading;
  }

  const video = String(videoBaseName ?? "").trim();
  const followsVideo = nameFollows(base, video);
  const text = followsVideo ? base.slice(video.length) : base;
  const tokens = tokenizeName(text);
  if (tokens.length === 0) {
    return reading;
  }

  const leftovers = [];
  let sawHiToken = false;
  // Backwards: the LAST language in the name is the one that counts, which is
  // Jellyfin's documented rule and what its parser does by walking this way.
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    const word = token.trim().toLowerCase();
    if (word.length === 0) {
      continue;
    }
    if (FORCED_FLAGS.has(word)) {
      reading.isForced = true;
      continue;
    }
    if (DEFAULT_FLAGS.has(word)) {
      reading.isDefault = true;
      continue;
    }
    // `hi` is both Hindi and "hearing impaired". Which it is depends on whether
    // another language is named — Jellyfin: "`hi` by itself will resolve as a
    // Hindi language track, while `hi` in conjunction with another language
    // identifier … will use the other language and tag it as hearing impaired."
    // It cannot be settled here, because the other language may still be to the
    // left, so it is remembered and settled below.
    if (word === "hi") {
      sawHiToken = true;
      continue;
    }
    if (HEARING_IMPAIRED_FLAGS.has(word)) {
      reading.isHearingImpaired = true;
      continue;
    }
    const language = parseLanguageTag(token);
    if (language) {
      if (reading.language === null) {
        reading.language = language;
      }
      continue;
    }
    if (!followsVideo) {
      break;
    }
    leftovers.unshift(token.trim());
  }

  if (sawHiToken) {
    if (reading.language === null) {
      reading.language = lookupLanguage("hi");
    } else {
      reading.isHearingImpaired = true;
    }
  }

  const title = leftovers.filter((part) => part.length > 0).join(" ").trim();
  reading.title = title.length > 0 ? title : null;
  return reading;
}

/**
 * The language a path's FOLDERS state, looking from the innermost outwards.
 *
 * A whole segment is tried first (`ENG`, `Russian`, `рус`), then its words —
 * which is what reads `Rus Sound` as Russian. A word is only accepted from a
 * multi-word segment when it is at least three letters, because two-letter
 * codes are also ordinary words (`no`, `id`, `it`) and a folder called
 * `No Subs` does not mean Norwegian.
 *
 * A segment made only of words that name a KIND of track — `Subs`, `Субтитры` —
 * states no language and is skipped rather than searched, so a future table
 * entry cannot turn one into a language by accident.
 *
 * @param {string[]} folders - Folders above the file, outermost first.
 * @returns {{ code: string, name: string } | null}
 */
export function languageFromFolderNames(folders) {
  const segments = Array.isArray(folders) ? folders : [];
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = String(segments[index] ?? "").trim();
    if (segment.length === 0 || isNeutralWord(segment)) {
      continue;
    }
    const whole = parseLanguageTag(segment);
    if (whole) {
      return whole;
    }
    const words = segment.split(/[^\p{L}]+/u).filter((word) => word.length >= 3);
    for (const word of words) {
      const found = lookupLanguage(word);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reading a whole sidecar path: its name AND the folders above it.
//
// This half used to live in the browser (`subtitle-utils.js`), which is also
// where the pairing was decided — two answers about the same file, computed on
// two sides, compared nowhere. Measured 2026-09-04 over the 115 torrents in
// `Dropbox/trn`: 1249 video files, 1239 pairings agreed and 10 did not, every
// one of the ten a `<video base>.<language>.<ext>` name that the browser paired
// and the proxy did not. The proxy warms what it paired and the browser offers
// what it paired, so a disagreement reached the viewer as a track nobody had
// warmed — a wait of 27.7 s in the field measurement of 2026-08-31.
// ---------------------------------------------------------------------------

/**
 * Remove the file extension from a name.
 *
 * @param {string} name
 * @returns {string}
 */
export function stripExtension(name) {
  const text = typeof name === "string" ? name : "";
  const dot = text.lastIndexOf(".");
  return dot > 0 ? text.slice(0, dot) : text;
}

/**
 * The bracketed groups of a name, in order.
 *
 * @param {string} text
 * @returns {string[]}
 */
function bracketTokens(text) {
  const source = typeof text === "string" ? text : "";
  const tokens = [];
  for (const match of source.matchAll(/\[([^\]]+)\]/g)) {
    const token = match[1].trim();
    if (token.length > 0) {
      tokens.push(token);
    }
  }
  return tokens;
}

/**
 * Bracketed groups that describe the ENCODE rather than a team — resolution,
 * codec, source, audio format, bit depth. A releaser's name is what is left
 * after these are set aside.
 *
 * @param {string} token
 * @returns {boolean}
 */
function isTechnicalToken(token) {
  const text = String(token ?? "").trim().toLowerCase();
  if (text.length === 0) {
    return true;
  }
  // A release hash: `[78EFD746]`. It identifies the file, not its author.
  if (/^[0-9a-f]{4,10}$/.test(text) && /\d/.test(text)) {
    return true;
  }
  if (/^\d{3,4}[pi]$/.test(text) || /^\d{3,4}x\d{3,4}$/.test(text)) {
    return true;
  }
  if (/^(x|h)\.?26[45]$/.test(text) || /^(hevc|avc|av1|vp9|xvid|divx)$/.test(text)) {
    return true;
  }
  if (/^(aac|ac3|eac3|dts(-?hd)?|flac|mp3|opus|truehd|atmos|pcm|\d\.\d)$/.test(text)) {
    return true;
  }
  if (/^(web-?rip|web-?dl|bd-?rip|blu-?ray|hdtv|dvd-?rip|remux|hdr\d*|dv|sdr|\d{1,2}bit)$/.test(text)) {
    return true;
  }
  // A bracket that names a language names a language, not a team; and one that
  // names the KIND of track (`[Subs]`) names neither.
  return lookupLanguage(text) !== null || isNeutralWord(text);
}

/**
 * What is left of a name after the language and the flags, as a TITLE — or
 * nothing, when what is left only describes the encode.
 *
 * Jellyfin keeps every leftover word ("Any arbitrary text not parsable to a
 * language or flag will be combined and used as the title of the stream"), and
 * on its own library that is right, because the part it reads is what the owner
 * deliberately appended. A torrent is not that tidy: `Film.1080p.rus.srt` beside
 * `Film.mkv` leaves `1080p`, and a track labelled "Russian (1080p)" is worse
 * than one labelled "Russian".
 *
 * @param {string | null} title
 * @returns {string | null}
 */
function titleOf(title) {
  if (typeof title !== "string") {
    return null;
  }
  const words = title.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) {
    return null;
  }
  // ALL of it, or none. A word is only weighed on its own when it stands on its
  // own: inside a phrase, a word that happens to name a language is part of the
  // phrase — `English Commentary` is a title, and dropping `English` from it
  // would leave a label nobody wrote.
  return words.every((word) => isTechnicalToken(word)) ? null : words.join(" ");
}

/**
 * Who made a track that ships as its own file, when the torrent says so.
 *
 * The rule that keeps this honest: a bracketed group is only a releaser of the
 * SIDECAR when it is not also in the video's own name. In the field case that
 * settles it — a Russian dub named exactly like the picture,
 * `[HorribleSubs] Drifters - 02 [1080p].mka`, sitting in `Rus Sound/` — every
 * bracket it carries is the picture's, and attributing the dub to HorribleSubs
 * would be inventing an author. The subtitles of the same release, in
 * `Sub/[Stan WarHammer & Nesitach]/`, carry a bracket the video does not, and
 * that one IS their author.
 *
 * The innermost folder is looked at before the file name, because that is where
 * a release puts the team when several of them contributed.
 *
 * @param {object} params
 * @param {string[]} params.folders - Folders above the file, innermost last.
 * @param {string} params.fileName
 * @param {string} [params.videoName] - The picture's own file name.
 * @returns {string | null}
 */
export function releaserFrom({ folders, fileName, videoName = "" }) {
  const shared = new Set(
    bracketTokens(stripExtension(String(videoName ?? ""))).map((token) => token.toLowerCase())
  );
  const sources = [...(Array.isArray(folders) ? folders : [])].reverse();
  sources.push(stripExtension(String(fileName ?? "")));
  for (const source of sources) {
    for (const token of bracketTokens(source)) {
      if (shared.has(token.toLowerCase()) || isTechnicalToken(token)) {
        continue;
      }
      return token;
    }
  }
  return null;
}

/**
 * Language, flags and releaser for a track that ships as its own file.
 *
 * Reading order, and the reason for it: the FILE NAME first, then the folders.
 * All five players surveyed read the name
 * (`research/sidecar-naming-conventions-2026-09-01.md`); only VLC and Kodi treat
 * a folder as a place rather than as a statement about language. A name is also
 * per-file where a folder is per-group, so where both speak the name is the more
 * specific of the two.
 *
 * A soundtrack is named by the same conventions a subtitle is — Jellyfin's own
 * example set carries `Film.en.ac3` and `Film.german.ac3` beside `Film.de.srt` —
 * so it is the same grammar over the same path.
 *
 * @param {object} params
 * @param {string[]} params.folders
 * @param {string} params.fileName
 * @param {string} [params.videoName]
 * @returns {{ code: string | null, name: string | null, releaser: string | null,
 *   isForced: boolean, isHearingImpaired: boolean, isDefault: boolean }}
 */
export function sidecarNaming({ folders, fileName, videoName = "" }) {
  const fromName = readSidecarName(
    stripExtension(String(fileName ?? "")),
    stripExtension(String(videoName ?? ""))
  );
  const language = fromName.language ?? languageFromFolderNames(folders);
  return {
    code: language?.code ?? null,
    name: language?.name ?? null,
    releaser: titleOf(fromName.title) ?? releaserFrom({ folders, fileName, videoName }),
    isForced: fromName.isForced,
    isHearingImpaired: fromName.isHearingImpaired,
    isDefault: fromName.isDefault
  };
}
