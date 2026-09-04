/**
 * @file The name grammar, checked against the forms its sources document.
 *
 * Every case here is an example one of the five surveyed players either prints
 * in its own documentation or handles in its own source. The survey and the
 * quotes are `research/sidecar-naming-conventions-2026-09-01.md`; the roadmap
 * item is 67.
 *
 * The rule these checks exist to hold: what the person who made the file wrote
 * is read, and nothing is guessed at. A token becomes a language only by being
 * in the table.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  isNeutralWord,
  languageFromFolderNames,
  lookupLanguage,
  nameFollows,
  parseLanguageTag,
  readSidecarName,
  sidecarNaming,
  tokenizeName
} from "../services/torrent/naming.js";

/**
 * Read a whole path against a known picture, the way the pairing does.
 *
 * `code` is `"und"` where nothing was read, which is the shape the browser is
 * given: a track that states no language is not a track with no language.
 *
 * @param {string} name - The sidecar's file name.
 * @param {string} [video] - The picture's file name.
 * @param {string} [relativePath] - The path, for the folders above the file.
 * @returns {{ code: string, group: string | null, isForced: boolean, isHearingImpaired: boolean, isDefault: boolean }}
 */
function readPath(name, video = "Film.mkv", relativePath = name) {
  const folders = String(relativePath).split("/").slice(0, -1);
  const naming = sidecarNaming({ folders, fileName: name, videoName: video });
  return { ...naming, code: naming.code ?? "und", group: naming.releaser };
}

/** Read a name against a known picture, the way the loader does. */
function read(name, video = "Film.mkv") {
  return readPath(name, video);
}

test("the dot-separated suffix, which is what every library writes", () => {
  // Plex: "Movie_Name (Release Date).[Language_Code].ext", the code being
  // "ISO-639-1 (2-letter) or ISO-639-2/B (3-letter)".
  assert.equal(read("Film.en.srt").code, "en");
  assert.equal(read("Film.eng.srt").code, "en");
  assert.equal(read("Film.ru.srt").code, "ru");
  assert.equal(read("Film.rus.srt").code, "ru");
  // Kodi's own example: "The Matrix.English.srt".
  assert.equal(read("Film.English.srt").code, "en");
  assert.equal(read("Film.Russian.srt").code, "ru");
});

test("both ISO 639-2 sets, because the two disagree for about twenty languages", () => {
  // Plex names the bibliographic set; ffmpeg and Matroska write either.
  for (const [bibliographic, terminological, code] of [
    ["ger", "deu", "de"], ["fre", "fra", "fr"], ["cze", "ces", "cs"],
    ["chi", "zho", "zh"], ["dut", "nld", "nl"], ["gre", "ell", "el"],
    ["per", "fas", "fa"], ["ice", "isl", "is"], ["may", "msa", "ms"],
    ["rum", "ron", "ro"], ["slo", "slk", "sk"], ["alb", "sqi", "sq"],
    ["arm", "hye", "hy"], ["baq", "eus", "eu"], ["bur", "mya", "my"],
    ["geo", "kat", "ka"], ["mac", "mkd", "mk"], ["mao", "mri", "mi"],
    ["tib", "bod", "bo"], ["wel", "cym", "cy"]
  ]) {
    assert.equal(lookupLanguage(bibliographic)?.code, code, bibliographic);
    assert.equal(lookupLanguage(terminological)?.code, code, terminological);
  }
});

test("a BCP-47 tag keeps its region, and Kodi's underscore form is accepted", () => {
  // Kodi: "a BCP 47 tag (with - characters replaced with _)"; its own example
  // is "The Matrix.zh_yue.srt".
  assert.deepEqual(parseLanguageTag("pt-BR"), { code: "pt-BR", name: "Portuguese" });
  assert.deepEqual(parseLanguageTag("pt_BR"), { code: "pt-BR", name: "Portuguese" });
  assert.deepEqual(parseLanguageTag("zh_yue"), { code: "zh-yue", name: "Chinese" });
  assert.deepEqual(parseLanguageTag("en-US"), { code: "en-US", name: "English" });
  assert.equal(read("Film.pt-BR.srt").code, "pt-BR");
  // A region is kept, so pt-BR and pt-PT stay apart on screen.
  assert.notEqual(read("Film.pt-BR.srt").code, read("Film.pt-PT.srt").code);
});

test("a tag whose primary subtag is not a language is not a language", () => {
  assert.equal(parseLanguageTag("web-dl"), null);
  assert.equal(parseLanguageTag("x-264"), null);
  assert.equal(parseLanguageTag("Upscale"), null);
});

test("the flags, with the spellings Jellyfin and mpv accept", () => {
  assert.equal(read("Film.en.forced.srt").isForced, true);
  assert.equal(read("Film.en.foreign.srt").isForced, true);
  assert.equal(read("Film.en.sdh.srt").isHearingImpaired, true);
  assert.equal(read("Film.en.cc.srt").isHearingImpaired, true);
  assert.equal(read("Film.default.srt").isDefault, true);
  // Jellyfin's own extended example: several flags on one file.
  const both = read("Film.default.en.forced.ass");
  assert.equal(both.code, "en");
  assert.equal(both.isDefault, true);
  assert.equal(both.isForced, true);
});

test("Kodi separates the forced flag with a dot, a space or a dash", () => {
  // "The forced flag can be either upper, lower or mixed case in the filename
  // and can use a '.' (dot), ' ' (space) or '-' (dash) to separate them".
  assert.equal(read("Film.English.Forced.srt").isForced, true);
  assert.equal(read("Film.English Forced.srt").isForced, true);
  assert.equal(read("Film.English-Forced.srt").isForced, true);
  assert.equal(read("Film.English Forced.srt").code, "en");
});

test("hi is Hindi alone and hearing-impaired beside another language", () => {
  // Jellyfin: "`hi` by itself will resolve as a Hindi language track, while
  // `hi` in conjunction with another language identifier … will use the other
  // language and tag it as hearing impaired."
  const hindi = read("Film.hi.srt");
  assert.equal(hindi.code, "hi");
  assert.equal(hindi.isHearingImpaired, false);

  const impaired = read("Film.en.hi.srt");
  assert.equal(impaired.code, "en");
  assert.equal(impaired.isHearingImpaired, true);
});

test("the last language in the name wins", () => {
  // Jellyfin: "If multiple languages are defined within the filename the last
  // one will be used and the others ignored."
  assert.equal(read("Film.en.ru.srt").code, "ru");
  assert.equal(read("Film.ru.en.srt").code, "en");
});

test("a bracketed tail is read, and only through the table", () => {
  // mpv takes `(` as the delimiter when the name ends `)`, `[` when it ends `]`.
  assert.equal(read("Film (Russian).srt").code, "ru");
  assert.equal(read("Film [rus].srt").code, "ru");
  // And the case from the test torrents that a shape-based rule would ruin.
  assert.equal(read("Gibo no Toiki - 01 (Upscale).ass").code, "und");
  assert.equal(read("[HorribleSubs] Drifters - 03 [1080p].ass").code, "und");
  // A bracketed tail does not stop the rest of the name being read.
  assert.equal(read("Film.rus [1080p].srt").code, "ru");
  assert.equal(read("Film.en.forced [x264].srt").code, "en");
  assert.equal(read("Film.en.forced [x264].srt").isForced, true);
});

test("leftover text is the track's title", () => {
  // Jellyfin: "Any arbitrary text not parsable to a language or flag will be
  // combined and used as the title of the stream."
  const info = read("Film.English Commentary.en.srt");
  assert.equal(info.code, "en");
  assert.equal(info.group, "English Commentary");
  // The underscore form this project already read, unchanged.
  assert.equal(read("Film_rus_AT_Team.srt").code, "ru");
  assert.equal(read("Film_rus_AT_Team.srt").group, "AT Team");
});

test("a leftover that only describes the encode is not a title", () => {
  // Jellyfin keeps every leftover word, and on a tidy library that is right.
  // A torrent is not tidy: this would read as "Russian (1080p)".
  assert.equal(read("Film.1080p.rus.srt").code, "ru");
  assert.equal(read("Film.1080p.rus.srt").group, null);
  assert.equal(read("Film.WEB-DL.x264.eng.srt").group, null);
});

test("the film's own name is never mined for a language", () => {
  // Jellyfin parses only what follows the video's name, and this is why: `It`
  // is Italian, and `Follows` is not a flag, so a reader that walked the whole
  // name would call this Italian.
  assert.equal(readPath("It.Follows.2014.srt", "It.Follows.2014.mkv").code, "und");
  // With no picture to measure against, reading stops at the first token that
  // is neither a flag nor a language — mpv's rule.
  assert.equal(readPath("It.Follows.2014.srt", "").code, "und");
  assert.equal(readPath("It.Follows.2014.rus.srt", "").code, "ru");
});

test("a folder states a language, or a kind of track, or a team", () => {
  assert.equal(languageFromFolderNames(["RUS"])?.code, "ru");
  assert.equal(languageFromFolderNames(["Rus Sub"])?.code, "ru");
  assert.equal(languageFromFolderNames(["subs", "eng"])?.code, "en");
  // VLC's own default search path — a place, not a language.
  for (const folder of ["Subs", "subs", "Subtitles", "subtitles"]) {
    assert.equal(languageFromFolderNames([folder]), null, folder);
    assert.equal(isNeutralWord(folder), true, folder);
  }
  // A team's bracket is not a language either.
  assert.equal(languageFromFolderNames(["Sub", "[Stan WarHammer & Nesitach]"]), null);
});

test("a Russian release names its folders in Russian", () => {
  assert.equal(languageFromFolderNames(["Субтитры"]), null);
  assert.equal(languageFromFolderNames(["Рус"])?.code, "ru");
  assert.equal(languageFromFolderNames(["Русские субтитры"])?.code, "ru");
  assert.equal(languageFromFolderNames(["Английские субтитры"])?.code, "en");
  assert.equal(languageFromFolderNames(["Рус Звук"])?.code, "ru");
  assert.equal(languageFromFolderNames(["Японские"])?.code, "ja");
});

test("the shapes the real test torrents carry still read as they did", () => {
  // Measured 2026-09-01 over the 112 torrents in Dropbox/trn.
  assert.equal(readPath("Enjo Kouhai_01.rus.ass", "Enjo Kouhai_01.mp4", "Enjo Kouhai/rus/Enjo Kouhai_01.rus.ass").code, "ru");
  assert.equal(readPath("Enjo Kouhai_01.chi.ass", "Enjo Kouhai_01.mp4", "Enjo Kouhai/chi/Enjo Kouhai_01.chi.ass").code, "zh");
  const drifters = readPath(
    "[HorribleSubs] Drifters - 03 [1080p].ass",
    "[HorribleSubs] Drifters - 03 [1080p].mkv",
    "Sub/[Stan WarHammer & Nesitach]/[HorribleSubs] Drifters - 03 [1080p].ass"
  );
  assert.equal(drifters.code, "und");
  assert.equal(drifters.group, "Stan WarHammer & Nesitach");
});

test("a soundtrack is read by the same grammar", () => {
  // Jellyfin's own example set: Film.en.ac3 beside Film.german.ac3.
  assert.equal(sidecarNaming({ folders: [], fileName: "Film.en.ac3", videoName: "Film.mkv" }).code, "en");
  assert.equal(sidecarNaming({ folders: [], fileName: "Film.german.ac3", videoName: "Film.mkv" }).code, "de");
  // The field case: the folder says Russian and the file carries only the
  // picture's own brackets.
  const dub = sidecarNaming({
    folders: ["Rus Sound"],
    fileName: "[HorribleSubs] Drifters - 02 [1080p].mka",
    videoName: "[HorribleSubs] Drifters - 02 [1080p].mkv"
  });
  assert.equal(dub.code, "ru");
  assert.equal(dub.releaser, null);
});

test("tokenizing is stable on names with nothing to say", () => {
  assert.deepEqual(tokenizeName(""), []);
  assert.deepEqual(readSidecarName("").language, null);
  assert.deepEqual(readSidecarName("Film", "Film").language, null);
});

test("a name continues the video's only at a token boundary", () => {
  // The rule that makes "begins with the video's name" safe. Without it
  // `Film.20.rus.srt` reads as belonging to `Film.2.mkv` — measured 2026-09-04
  // against the browser's own rule, which had no boundary — and the grammar
  // then reports the leftover `0` as the track's title, which is the tell that
  // the remainder is a fragment of another film's name.
  assert.equal(nameFollows("Film.2", "Film.2"), true, "the same name continues itself");
  assert.equal(nameFollows("Film.2.rus", "Film.2"), true);
  assert.equal(nameFollows("Film.20.rus", "Film.2"), false, "another film, one digit longer");
  assert.equal(nameFollows("Film_rus", "Film"), true);
  assert.equal(nameFollows("Film-rus", "Film"), true);
  assert.equal(nameFollows("Film rus", "Film"), true);
  // mpv's bracket forms.
  assert.equal(nameFollows("Film (Russian)", "Film"), true);
  assert.equal(nameFollows("Film [rus]", "Film"), true);
  // Nothing to measure against, and nothing to continue.
  assert.equal(nameFollows("Film.rus", ""), false);
  assert.equal(nameFollows("Fil", "Film"), false);
});
