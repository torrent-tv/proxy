/**
 * @file What a picture's name says about which episode it is, and what a whole
 * torrent's pictures are taken together.
 *
 * Every name below is taken from a release in the survey collection, except
 * where a test says it is built to reach an edge.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readEpisodeMarker } from "../services/torrent/episode-naming.js";
import { TorrentContents } from "../services/torrent/Contents.js";

test("season and episode with the episode title after them", () => {
  assert.deepEqual(readEpisodeMarker({ name: "s01e02_Murder.in.the.Mews.avi", folders: ["Season_01"] }), {
    season: 1,
    episodes: [2],
    part: null,
    special: false,
    showHint: "",
    titleHint: "Murder.in.the.Mews"
  });
});

test("a separator between the season and the episode is still one marker", () => {
  const marker = readEpisodeMarker({ name: "s03.e01_The.Mysterious.Affair.at.Styles.avi" });
  assert.equal(marker.season, 3);
  assert.deepEqual(marker.episodes, [1]);
  assert.equal(marker.titleHint, "The.Mysterious.Affair.at.Styles");
});

test("a part of one episode is its own field and leaves the title", () => {
  const marker = readEpisodeMarker({ name: "s02e01_Peril.at.End.House_Part.1.avi" });
  assert.equal(marker.part, 1);
  assert.equal(marker.titleHint, "Peril.at.End.House");
  assert.deepEqual(marker.episodes, [1]);
});

test("the show name comes before the marker and release tags after it", () => {
  const marker = readEpisodeMarker({ name: "Reacher.S04E01.1080p.rus.LostFilm.TV.mkv" });
  assert.equal(marker.season, 4);
  assert.equal(marker.showHint, "Reacher");
  assert.equal(marker.titleHint, "1080p.rus.LostFilm.TV");
});

test("one file carrying several episodes lists all of them", () => {
  assert.deepEqual(readEpisodeMarker({ name: "Show.S01E01E02.mkv" }).episodes, [1, 2]);
  assert.deepEqual(readEpisodeMarker({ name: "Show.S01E01-E03.mkv" }).episodes, [1, 2, 3]);
  assert.deepEqual(readEpisodeMarker({ name: "Show.S01E01-02.mkv" }).episodes, [1, 2]);
});

test("a claim of more episodes than a file carries is not a marker", () => {
  assert.equal(readEpisodeMarker({ name: "Show.S01E01-40.mkv" }), null);
});

test("season 0 and a name calling itself a special are specials", () => {
  assert.equal(readEpisodeMarker({ name: "Show.S00E03.mkv" }).special, true);
  assert.equal(readEpisodeMarker({ name: "Show - 05 Special.mkv" }).special, true);
  assert.equal(readEpisodeMarker({ name: "Show.S01E03.mkv" }).special, false);
});

test("the numbering anime releases use, with no season in it", () => {
  const marker = readEpisodeMarker({ name: "[HorribleSubs] Drifters - 01 [1080p].mkv" });
  assert.equal(marker.season, null);
  assert.deepEqual(marker.episodes, [1]);
  assert.equal(marker.showHint, "[HorribleSubs] Drifters");
});

test("a season stated just before the dash number is read", () => {
  const marker = readEpisodeMarker({ name: "Koukaku Kidoutai (2026) S1 - 01.mkv" });
  assert.equal(marker.season, 1);
  assert.equal(marker.showHint, "Koukaku Kidoutai (2026)");
});

test("a season folder gives the season to an episode number without one", () => {
  const marker = readEpisodeMarker({ name: "Episode.05.mkv", folders: ["Сезон 2"] });
  assert.equal(marker.season, 2);
  assert.deepEqual(marker.episodes, [5]);
});

test("names that state no episode say nothing", () => {
  for (const name of [
    "Despicable.Me.4.2024.1080p.BluRay.x264-EniaHD.mkv",
    "Movie - 2024 [1080p].mkv",
    "Mortal.Kombat.II.1080p.rus.LostFilm.TV.mkv",
    "Video.1920x1080.mkv",
    "VTS_01_1.VOB"
  ]) {
    assert.equal(readEpisodeMarker({ name }), null, name);
  }
});

/**
 * @param {string} name
 * @param {string[]} relatives
 * @returns {TorrentContents}
 */
function contents(name, relatives) {
  return new TorrentContents({
    name,
    files: relatives.map((relative) => ({
      path: `${name}/${relative}`,
      name: relative.slice(relative.lastIndexOf("/") + 1),
      length: 1
    }))
  });
}

test("one picture is a single work", () => {
  assert.equal(new TorrentContents({ name: "Film.mkv", files: [{ path: "Film.mkv", name: "Film.mkv", length: 1 }] }).shape, "single");
});

test("numbered pictures of one show are a series, and an unnumbered one stays in it", () => {
  const pack = contents("Poirot", ["Season_01/s01e01_A.avi", "Season_01/s01e02_B.avi", "Special.avi"]);
  assert.equal(pack.shape, "series");
  assert.equal(pack.items.find((item) => item.name === "Special.avi").episode, null);
});

test("pictures without numbers are not called a collection, only not known", () => {
  assert.equal(contents("Trilogy", ["One.2010.mkv", "Two.2013.mkv", "Three.2017.mkv"]).shape, "undetermined");
  assert.equal(contents("Film", ["Film.mkv", "Film.S01E01.mkv"]).shape, "undetermined");
});

test("two differently named shows are not one series", () => {
  assert.equal(contents("Mixed", ["Alpha.S01E01.mkv", "Beta.S01E01.mkv"]).shape, "undetermined");
  assert.equal(
    contents("Drifters", ["[HorribleSubs] Drifters - 01 [1080p].mkv", "[Other] Drifters - 02 [720p].mkv"]).shape,
    "series"
  );
});
