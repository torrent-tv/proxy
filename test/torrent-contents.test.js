/**
 * @file What one torrent says is in it: its pictures, what belongs to each, and
 * the order a person reads them in.
 *
 * The fixtures are real releases. `Drifters` ships twelve episodes in the root
 * with a Russian soundtrack per episode under `Rus Sound/` and a subtitle file
 * per episode under `Sub/[group]/`; the single-film shape ships one `.mkv` with
 * a dub whose name has nothing in common with it. Both are the cases the
 * pairing rules beside this were written against, and this file is about what
 * is built ON them — the grouping, the order and the leftovers.
 *
 * Measured on the survey collection, 2026-09-12, and recorded here because it
 * is what says the grouping is not an invention: 134 torrents, 44 of them with
 * more than one picture, 1357 items and 421 files paired to one. Not a single
 * file was paired to two pictures, and in all 1357 the grouping agreed with the
 * per-picture call it replaces.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { TorrentContents, contentsOf } from "../services/torrent/Contents.js";

/**
 * The Drifters torrent, as WebTorrent reports it: every path prefixed with the
 * torrent's own name, and the episodes in the order the tool that made it chose
 * — which is not the order anybody reads them in.
 *
 * @param {number[]} episodes
 * @returns {Array<{ path: string, name: string, length: number }>}
 */
function driftersFiles(episodes) {
  const files = [];
  const push = (relative, length) => {
    const name = relative.slice(relative.lastIndexOf("/") + 1);
    files.push({ path: `Drifters/${relative}`, name, length });
  };
  for (const episode of episodes) {
    const stem = `[HorribleSubs] Drifters - ${String(episode).padStart(2, "0")} [1080p]`;
    push(`Sub/[Stan WarHammer & Nesitach]/${stem}.ass`, 29_000);
    push(`Rus Sound/${stem}.mka`, 30_000_000);
    push(`${stem}.mkv`, 566_000_000);
  }
  return files;
}

test("every picture is an item, with its own sound and subtitles on it", () => {
  const contents = new TorrentContents({ files: driftersFiles([1, 2]), name: "Drifters" });

  assert.equal(contents.videoCount, 2);
  assert.equal(contents.items.length, 2);
  const [first, second] = contents.items;
  assert.match(first.name, / - 01 /);
  assert.match(second.name, / - 02 /);
  assert.deepEqual(
    first.audio.map((file) => file.name),
    ["[HorribleSubs] Drifters - 01 [1080p].mka"]
  );
  assert.deepEqual(
    first.subtitles.map((file) => file.name),
    ["[HorribleSubs] Drifters - 01 [1080p].ass"]
  );
  // The sound of episode 1 must never appear on the picture of episode 2: the
  // wrong pairing is silent everywhere downstream.
  assert.deepEqual(
    second.audio.map((file) => file.name),
    ["[HorribleSubs] Drifters - 02 [1080p].mka"]
  );
});

test("items come out in the order a person reads them, not the torrent's own", () => {
  // A real release lists its episodes 08, 06, 07, 01 — the order of whatever
  // tool made the torrent, routinely by size.
  const contents = new TorrentContents({ files: driftersFiles([8, 6, 10, 2]), name: "Drifters" });

  assert.deepEqual(
    contents.items.map((item) => item.name.match(/ - (\d+) /)[1]),
    ["02", "06", "08", "10"]
  );
});

test("runs of digits are compared as numbers, so 2 comes before 10", () => {
  const files = [
    { path: "Show/ep10.mkv", name: "ep10.mkv", length: 9 },
    { path: "Show/ep2.mkv", name: "ep2.mkv", length: 9 }
  ];
  const contents = new TorrentContents({ files, name: "Show" });

  assert.deepEqual(
    contents.items.map((item) => item.name),
    ["ep2.mkv", "ep10.mkv"]
  );
});

test("an item keeps the torrent's own index, whatever order it is read in", () => {
  const contents = new TorrentContents({ files: driftersFiles([8, 2]), name: "Drifters" });

  // Episode 2 is read first and is the fifth file of the torrent.
  assert.equal(contents.items[0].fileIndex, 5);
  assert.equal(contents.items[1].fileIndex, 2);
});

test("a file is answered for by the item it belongs to, as a picture or as a part", () => {
  const contents = new TorrentContents({ files: driftersFiles([1]), name: "Drifters" });
  const [item] = contents.items;

  assert.equal(contents.itemOf(item.fileIndex), item);
  assert.equal(contents.itemOf(item.audio[0].fileIndex), item);
  assert.equal(contents.itemOf(item.subtitles[0].fileIndex), item);
  assert.equal(contents.itemOf(404), null);
});

test("what belongs beside one picture is answered from what was decided once", () => {
  const contents = new TorrentContents({ files: driftersFiles([1, 2]), name: "Drifters" });
  const [first] = contents.items;

  const beside = contents.sidecarsOf(first.fileIndex);
  assert.deepEqual(beside.audio, first.audio);
  assert.deepEqual(beside.subtitles, first.subtitles);
  // Asked about a file that is not a picture, the answer is nothing rather than
  // the item that file happens to sit in: the question is "what goes beside
  // this picture", and a soundtrack is not one.
  assert.deepEqual(contents.sidecarsOf(first.audio[0].fileIndex), {
    audio: [],
    subtitles: [],
    images: []
  });
});

test("a torrent with one picture takes the dub whose name has nothing in common", () => {
  const files = [
    { path: "Film/Film.2024.1080p.mkv", name: "Film.2024.1080p.mkv", length: 4_000_000_000 },
    { path: "Film/Rus Sound/dub.mka", name: "dub.mka", length: 30_000_000 }
  ];
  const contents = new TorrentContents({ files, name: "Film" });

  assert.equal(contents.items.length, 1);
  assert.deepEqual(
    contents.items[0].audio.map((file) => file.name),
    ["dub.mka"]
  );
  assert.deepEqual(contents.leftovers, []);
});

test("what belongs to no picture is listed as such, and nothing is lost", () => {
  // `.nfo` is the release's own note and belongs to nothing. A `.txt` would
  // NOT do here: the pairing layer counts it among the subtitle formats, and a
  // torrent with one picture takes every sidecar there is.
  const files = [
    { path: "Film/Film.mkv", name: "Film.mkv", length: 9 },
    { path: "Film/release.nfo", name: "release.nfo", length: 1 },
    { path: "Film/Screens/unrelated.jpg", name: "unrelated.jpg", length: 1 }
  ];
  const contents = new TorrentContents({ files, name: "Film" });

  assert.deepEqual(
    contents.leftovers.map((file) => file.relativePath),
    ["release.nfo", "Screens/unrelated.jpg"]
  );
  const accounted =
    contents.items.length +
    contents.items.reduce(
      (count, item) => count + item.audio.length + item.subtitles.length + item.images.length,
      0
    ) +
    contents.leftovers.length;
  assert.equal(accounted, files.length);
});

test("a torrent whose metadata has not arrived says it holds nothing", () => {
  const contents = new TorrentContents({ files: [], name: "" });

  assert.deepEqual(contents.items, []);
  assert.deepEqual(contents.leftovers, []);
  assert.equal(contents.videoCount, 0);
  assert.equal(contents.itemOf(0), null);
});

test("the answer is worked out once per torrent, and again when its files arrive", () => {
  const torrent = { name: "Drifters", files: [] };

  const empty = contentsOf(torrent);
  assert.equal(contentsOf(torrent), empty, "asking twice must not work it out twice");

  // A magnet has no files until its metadata lands, which happens exactly once.
  torrent.files = driftersFiles([1]);
  const full = contentsOf(torrent);
  assert.notEqual(full, empty);
  assert.equal(full.items.length, 1);
  assert.equal(contentsOf(torrent), full);
});

test("folders order before names, so seasons stay together", () => {
  const files = [
    { path: "Show/Season 2/ep 1.mkv", length: 9 },
    { path: "Show/Season 10/ep 1.mkv", length: 9 },
    { path: "Show/Season 1/ep 2.mkv", length: 9 },
    { path: "Show/Season 1/ep 1.mkv", length: 9 }
  ];
  const contents = new TorrentContents({ files, name: "Show" });

  assert.deepEqual(
    contents.items.map((item) => item.relativePath),
    ["Season 1/ep 1.mkv", "Season 1/ep 2.mkv", "Season 2/ep 1.mkv", "Season 10/ep 1.mkv"]
  );
});

test("every file is described by what it is, in the order a person reads them", () => {
  // What the browser is given. It used to answer this itself — a list of video
  // extensions in its parser and a second, shorter pair inside its picker —
  // against this one, and the three had already diverged.
  const files = [
    { path: "Film/notes.nfo", length: 1 },
    { path: "Film/cover.jpg", length: 2 },
    { path: "Film/film.mkv", length: 9 },
    { path: "Film/Rus Sound/dub.mka", length: 3 },
    { path: "Film/Sub/film.ass", length: 1 }
  ];
  const contents = new TorrentContents({ files, name: "Film" });

  assert.deepEqual(
    contents.files().map((file) => [file.relativePath, file.kind]),
    [
      ["cover.jpg", "image"],
      ["film.mkv", "video"],
      ["notes.nfo", "other"],
      ["Rus Sound/dub.mka", "audio"],
      ["Sub/film.ass", "subtitle"]
    ]
  );
  assert.deepEqual(
    contents.files().map((file) => file.fileIndex),
    [1, 2, 0, 3, 4],
    "the torrent's own numbers travel with them"
  );
});
