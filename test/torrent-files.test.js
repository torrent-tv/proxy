/**
 * @file Which files of a torrent are one video file's sound and subtitles.
 *
 * The case these were written against is a real torrent, and every name below
 * is copied from it: `Drifters`, twelve episodes as `.mkv` in the root, twelve
 * Russian soundtracks as `.mka` under `Rus Sound/`, twelve subtitle files under
 * `Sub/[Stan WarHammer & Nesitach]/`, all sharing one base name per episode.
 *
 * The rule that matters most is the one about a torrent with SEVERAL videos: a
 * sidecar is taken only when its name pairs with this episode's, because a
 * wrong pairing would put the sound of episode 2 over the picture of episode 7
 * and nothing downstream could notice.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  baseNameOf,
  bracketTokensOf,
  countVideoFiles,
  extensionOf,
  matchSidecarFiles,
  namesPair,
  splitTorrentPath
} from "../services/torrent/files.js";

/**
 * The Drifters torrent, as WebTorrent reports it: every path prefixed with the
 * torrent's own name.
 *
 * @param {number} episodes
 * @returns {Array<{ path: string, name: string, length: number }>}
 */
function driftersFiles(episodes = 3) {
  const files = [];
  const push = (relative, length) => {
    const name = relative.slice(relative.lastIndexOf("/") + 1);
    files.push({ path: `Drifters/${relative}`, name, length });
  };
  for (let episode = 1; episode <= episodes; episode += 1) {
    const stem = `[HorribleSubs] Drifters - ${String(episode).padStart(2, "0")} [1080p]`;
    push(`Sub/[Stan WarHammer & Nesitach]/${stem}.ass`, 29_000);
    push(`Rus Sound/${stem}.mka`, 30_000_000);
    push(`${stem}.mkv`, 566_000_000);
  }
  return files;
}

test("a path is split into folders and a name, with the torrent's own name removed", () => {
  const split = splitTorrentPath("Drifters/Rus Sound/[HorribleSubs] Drifters - 02 [1080p].mka", "Drifters");
  assert.deepEqual(split.folders, ["Rus Sound"]);
  assert.equal(split.name, "[HorribleSubs] Drifters - 02 [1080p].mka");
});

test("a path that does not begin with the torrent name is left alone", () => {
  const split = splitTorrentPath("Sub/x.ass", "Drifters");
  assert.deepEqual(split.folders, ["Sub"]);
  assert.equal(split.name, "x.ass");
});

test("extension and base name", () => {
  assert.equal(extensionOf("[HorribleSubs] Drifters - 02 [1080p].mka"), ".mka");
  assert.equal(extensionOf("no-extension"), "");
  assert.equal(extensionOf(".hidden"), "");
  assert.equal(baseNameOf("a.b.mkv"), "a.b");
});

test("bracketed groups are read in order", () => {
  assert.deepEqual(
    bracketTokensOf("[HorribleSubs] Drifters - 02 [1080p]"),
    ["HorribleSubs", "1080p"]
  );
  assert.deepEqual(bracketTokensOf("nothing here"), []);
});

test("equal base names pair, whatever folder each sits in", () => {
  assert.equal(
    namesPair("[HorribleSubs] Drifters - 02 [1080p].mka", "[HorribleSubs] Drifters - 02 [1080p].mkv"),
    true
  );
  assert.equal(
    namesPair("[HorribleSubs] Drifters - 03 [1080p].mka", "[HorribleSubs] Drifters - 02 [1080p].mkv"),
    false
  );
});

test("a shared release hash pairs two differently named files", () => {
  assert.equal(namesPair("Ep01_rus [A1B2C3D4].mka", "[Group] Ep 01 [A1B2C3D4].mkv"), true);
  assert.equal(namesPair("Ep01_rus [11112222].mka", "[Group] Ep 01 [A1B2C3D4].mkv"), false);
});

test("the sound and the subtitles of THIS episode are found, and no other's", () => {
  const files = driftersFiles(3);
  // Episode 2's picture: index 5 in the list built above.
  const videoIndex = files.findIndex((file) => file.name === "[HorribleSubs] Drifters - 02 [1080p].mkv");
  const matched = matchSidecarFiles({
    files,
    videoIndex,
    torrentName: "Drifters",
    videoCount: countVideoFiles(files)
  });

  assert.equal(matched.audio.length, 1);
  assert.equal(matched.audio[0].name, "[HorribleSubs] Drifters - 02 [1080p].mka");
  assert.deepEqual(matched.audio[0].folders, ["Rus Sound"]);
  assert.equal(matched.audio[0].extension, ".mka");
  // A `.mka` is Matroska, so its own track table can be read — which is the
  // whole reason no new container class was needed for a separate soundtrack.
  assert.equal(matched.audio[0].declaresTracks, true);

  assert.equal(matched.subtitles.length, 1);
  assert.equal(matched.subtitles[0].name, "[HorribleSubs] Drifters - 02 [1080p].ass");
  assert.deepEqual(matched.subtitles[0].folders, ["Sub", "[Stan WarHammer & Nesitach]"]);
});

test("the picture itself is never its own sidecar", () => {
  const files = driftersFiles(1);
  const videoIndex = files.findIndex((file) => file.name.endsWith(".mkv"));
  const matched = matchSidecarFiles({ files, videoIndex, torrentName: "Drifters", videoCount: 1 });
  assert.equal(matched.audio.some((entry) => entry.fileIndex === videoIndex), false);
});

test("a torrent with one picture takes every sidecar, however it is named", () => {
  const files = [
    { path: "Film/Film.2019.1080p.mkv", name: "Film.2019.1080p.mkv", length: 5_000_000_000 },
    { path: "Film/Rus.mka", name: "Rus.mka", length: 300_000_000 },
    { path: "Film/subs/forced.srt", name: "forced.srt", length: 4_000 }
  ];
  const matched = matchSidecarFiles({
    files,
    videoIndex: 0,
    torrentName: "Film",
    videoCount: countVideoFiles(files)
  });
  assert.deepEqual(matched.audio.map((entry) => entry.name), ["Rus.mka"]);
  assert.deepEqual(matched.subtitles.map((entry) => entry.name), ["forced.srt"]);
});

test("a torrent with several pictures does NOT take a sidecar that names none of them", () => {
  const files = [
    { path: "Pack/Ep01.mkv", name: "Ep01.mkv", length: 100 },
    { path: "Pack/Ep02.mkv", name: "Ep02.mkv", length: 100 },
    { path: "Pack/Sound/Something Else.mka", name: "Something Else.mka", length: 100 }
  ];
  const matched = matchSidecarFiles({
    files,
    videoIndex: 0,
    torrentName: "Pack",
    videoCount: countVideoFiles(files)
  });
  assert.deepEqual(matched.audio, []);
});

test("files of no interest are ignored", () => {
  const files = [
    { path: "X/film.mkv", name: "film.mkv", length: 100 },
    { path: "X/film.nfo", name: "film.nfo", length: 10 },
    { path: "X/cover.jpg", name: "cover.jpg", length: 10 }
  ];
  const matched = matchSidecarFiles({ files, videoIndex: 0, torrentName: "X", videoCount: 1 });
  assert.deepEqual(matched.audio, []);
  assert.deepEqual(matched.subtitles, []);
  assert.deepEqual(
    matched.images,
    [],
    "a stray cover is not THIS film's cover: the one-video relaxation does not reach images, " +
      "because showing the wrong poster is a visible mistake where showing none is nothing"
  );
});

test("a contact sheet named by the video's whole name is paired with it", () => {
  // The shape a pack of a hundred videos actually ships: one sheet per video,
  // named `<video file name>.jpg`. Its BASE name is `c0930.com_chijyo0073.wmv`,
  // which no base-name rule would match against the video's `c0930…`.
  const files = [
    { path: "P/c0930.com_chijyo0073.wmv", name: "c0930.com_chijyo0073.wmv", length: 900 },
    {
      path: "P/Скринлисты/c0930.com_chijyo0073.wmv.jpg",
      name: "c0930.com_chijyo0073.wmv.jpg",
      length: 90
    },
    { path: "P/other.wmv", name: "other.wmv", length: 900 },
    { path: "P/Скринлисты/other.wmv.jpg", name: "other.wmv.jpg", length: 90 }
  ];

  const matched = matchSidecarFiles({ files, videoIndex: 0, torrentName: "P", videoCount: 2 });

  assert.equal(matched.images.length, 1, "its own sheet, and not the other video's");
  assert.equal(matched.images[0].fileIndex, 1);
  assert.deepEqual(matched.images[0].folders, ["Скринлисты"]);
});

test("a cover named like the film is paired with it, whatever its extension", () => {
  const files = [
    { path: "X/Film.2019.mkv", name: "Film.2019.mkv", length: 100 },
    { path: "X/Film.2019.png", name: "Film.2019.png", length: 10 },
    { path: "X/Film.2019.webp", name: "Film.2019.webp", length: 10 }
  ];

  const matched = matchSidecarFiles({ files, videoIndex: 0, torrentName: "X", videoCount: 1 });

  assert.deepEqual(
    matched.images.map((image) => image.name).sort(),
    ["Film.2019.png", "Film.2019.webp"]
  );
});

test("a raw elementary stream is recognised but declares no tracks of its own", () => {
  const files = [
    { path: "X/film.mkv", name: "film.mkv", length: 100 },
    { path: "X/film.ac3", name: "film.ac3", length: 100 }
  ];
  const matched = matchSidecarFiles({ files, videoIndex: 0, torrentName: "X", videoCount: 1 });
  assert.equal(matched.audio.length, 1);
  assert.equal(matched.audio[0].declaresTracks, false);
});

test("pictures are counted, and nothing else is", () => {
  assert.equal(countVideoFiles(driftersFiles(12)), 12);
  assert.equal(countVideoFiles([{ name: "a.mka" }, { name: "b.srt" }]), 0);
});
