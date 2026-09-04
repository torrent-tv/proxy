/**
 * @file What a torrent's own names say about a track shipped as its own file.
 *
 * The rule worth pinning is the releaser one, because getting it wrong invents
 * an author. In the field case — `[HorribleSubs] Drifters - 02 [1080p].mka` in
 * `Rus Sound/`, beside `[HorribleSubs] Drifters - 02 [1080p].mkv` — the dub
 * carries the picture's own brackets and nothing else, so there is nothing
 * truthful to say about who made it. The subtitles of the same release sit in
 * `Sub/[Stan WarHammer & Nesitach]/`, a bracket the picture does not carry, and
 * that one IS their author.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  languageFromFolderNames,
  releaserFrom,
  sidecarNaming
} from "../services/torrent/naming.js";
/**
 * Read a whole path, the way the pairing does. `code` is `"und"` where nothing
 * was read, and `group` is what the browser calls the releaser.
 *
 * @param {string} relativePath
 * @param {string} [videoName]
 * @returns {{ code: string, group: string | null }}
 */
function readPath(relativePath, videoName = "") {
  const parts = String(relativePath).split("/");
  const naming = sidecarNaming({
    folders: parts.slice(0, -1),
    fileName: parts[parts.length - 1],
    videoName
  });
  return { ...naming, code: naming.code ?? "und", group: naming.releaser };
}


const VIDEO_NAME = "[HorribleSubs] Drifters - 02 [1080p].mkv";

test("a folder naming a language is read, whole segment or word", () => {
  assert.equal(languageFromFolderNames(["ENG"])?.code, "en");
  assert.equal(languageFromFolderNames(["Rus Sound"])?.code, "ru");
  assert.equal(languageFromFolderNames(["Sub", "Russian"])?.code, "ru");
  assert.equal(languageFromFolderNames([])?.code, undefined);
});

test("the innermost folder answers first", () => {
  assert.equal(languageFromFolderNames(["Russian", "English Dub"])?.code, "en");
});

test("a two-letter word inside a longer folder name is not taken for a language", () => {
  // "No" is Norwegian as a whole segment, but a word in `No Subs` is a word.
  assert.equal(languageFromFolderNames(["No Subs"]), null);
  assert.equal(languageFromFolderNames(["no"])?.code, "no");
});

test("a bracket the picture also carries is not the sidecar's author", () => {
  assert.equal(
    releaserFrom({
      folders: ["Rus Sound"],
      fileName: "[HorribleSubs] Drifters - 02 [1080p].mka",
      videoName: VIDEO_NAME
    }),
    null
  );
});

test("a bracket only the sidecar carries is its author", () => {
  assert.equal(
    releaserFrom({
      folders: ["Sub", "[Stan WarHammer & Nesitach]"],
      fileName: "[HorribleSubs] Drifters - 02 [1080p].ass",
      videoName: VIDEO_NAME
    }),
    "Stan WarHammer & Nesitach"
  );
});

test("a bracket describing the encode is never an author", () => {
  for (const token of ["1080p", "x264", "HEVC", "WEB-DL", "AAC", "5.1", "10bit", "78EFD746", "RUS"]) {
    assert.equal(
      releaserFrom({ folders: [], fileName: `Film [${token}].mka`, videoName: "Other.mkv" }),
      null,
      `[${token}] should not be read as a releaser`
    );
  }
});

test("the innermost folder is preferred to the file name", () => {
  assert.equal(
    releaserFrom({ folders: ["[TeamA]"], fileName: "[TeamB] ep.ass", videoName: "ep.mkv" }),
    "TeamA"
  );
});

test("language and author together, for the field case", () => {
  assert.deepEqual(
    sidecarNaming({
      folders: ["Rus Sound"],
      fileName: "[HorribleSubs] Drifters - 02 [1080p].mka",
      videoName: VIDEO_NAME
    }),
    { code: "ru", name: "Russian", releaser: null, isForced: false, isHearingImpaired: false, isDefault: false }
  );
  assert.deepEqual(
    sidecarNaming({
      folders: ["Sub", "[Stan WarHammer & Nesitach]"],
      fileName: "[HorribleSubs] Drifters - 02 [1080p].ass",
      videoName: VIDEO_NAME
    }),
    {
      code: null,
      name: null,
      releaser: "Stan WarHammer & Nesitach",
      isForced: false,
      isHearingImpaired: false,
      isDefault: false
    }
  );
});

test("a subtitle file takes its author from the folder the release put it in", () => {
  const info = readPath("Sub/[Stan WarHammer & Nesitach]/[HorribleSubs] Drifters - 02 [1080p].ass", VIDEO_NAME);
  assert.equal(info.group, "Stan WarHammer & Nesitach");
});

test("the picture's own release group is never reported as the translator", () => {
  const info = readPath("Sub/[HorribleSubs] Drifters - 02 [1080p].ass", VIDEO_NAME);
  assert.equal(info.group, null);
});

test("the language of a subtitle folder is read where the whole segment is not a language", () => {
  const info = readPath("Rus Sub/ep.srt", "ep.mkv");
  assert.equal(info.code, "ru");
});

test("what the rules answer with nothing to go on", () => {
  const info = readPath("ep.srt");
  assert.equal(info.code, "und");
  assert.equal(info.group, null);
});
