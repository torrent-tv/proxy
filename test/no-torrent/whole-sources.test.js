/**
 * A file held whole does not bring its torrent back to be steered or measured.
 *
 * Field 2026-10-04: one viewer watching one whole file, and the torrent removed
 * and added again 671 times in two hours — once for every poll that asked for
 * the download figures after each removal. The rule that stops it is a lookup,
 * and these checks hold it to what it is for. No torrent is started here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createWholeSources } from "../../services/torrent/worker/whole-sources.js";
import { wholeFileStats } from "../../services/torrent/worker/whole-file-stats.js";

const HASH = "08ada5a7a6183aae1e09d831df6748d566095a10";

function lookupOver(held) {
  return createWholeSources({ find: (infoHash, fileIndex) => held.get(`${infoHash}/${fileIndex}`) ?? null });
}

test("a file held whole is found by its source key and index", () => {
  const whole = lookupOver(new Map([[`${HASH}/0`, { length: 129241752 }]]));
  assert.deepEqual(whole.fileOf(`torrent:${HASH}`, 0), { length: 129241752 });
  assert.equal(whole.fileOf(`torrent:${HASH.toUpperCase()}`, 0)?.length, 129241752, "the key's case does not matter");
  assert.equal(whole.fileOf(`torrent:${HASH}`, 1), null, "another file of the torrent is not");
  assert.equal(whole.fileOf("magnet:?xt=urn:btih:abc", 0), null, "a key that names no infohash finds nothing");
  assert.equal(whole.fileOf(`torrent:${HASH}`, -1), null);
});

const DESCRIPTION = {
  infoHash: HASH,
  name: "Sintel",
  pieceLength: 131072,
  files: [
    { index: 0, name: "Sintel.mp4", path: "Sintel/Sintel.mp4", length: 10 },
    { index: 1, name: "Sintel.en.srt", path: "Sintel/Sintel.en.srt", length: 20 },
    { index: 2, name: "poster.jpg", path: "Sintel/poster.jpg", length: 30 }
  ]
};

test("a source is whole only once it was described and every file is held", () => {
  const held = new Map([[`${HASH}/0`, { length: 10 }], [`${HASH}/1`, { length: 20 }]]);
  const whole = lookupOver(held);
  assert.equal(whole.isWhole(`torrent:${HASH}`), false, "not described yet");
  whole.remember(`torrent:${HASH}`, DESCRIPTION);
  assert.equal(whole.isWhole(`torrent:${HASH}`), false, "one of three is missing");
  assert.equal(whole.describe(`torrent:${HASH}`), null, "and it is not described as whole");
  held.set(`${HASH}/2`, { length: 30 });
  assert.equal(whole.isWhole(`torrent:${HASH}`), true);
  // Opening the film is answered without its torrent, files and all: a
  // destroyed torrent empties its own list, so it cannot be the answer.
  assert.deepEqual(whole.describe(`torrent:${HASH}`), DESCRIPTION);
  // Removed for space: the torrent has work again, and the answer says so.
  held.delete(`${HASH}/1`);
  assert.equal(whole.isWhole(`torrent:${HASH}`), false);
  assert.equal(whole.describe(`torrent:${HASH}`), null);
});

test("a description with no files is not remembered", () => {
  const whole = lookupOver(new Map());
  whole.remember(`torrent:${HASH}`, { ...DESCRIPTION, files: [] });
  assert.equal(whole.isWhole(`torrent:${HASH}`), false);
});

test("the figures of a whole file say everything is here and nothing is arriving", () => {
  const stats = wholeFileStats(129241752);
  assert.equal(stats.fileProgress, 1);
  assert.equal(stats.fileDownloaded, 129241752);
  assert.equal(stats.fileLength, 129241752);
  assert.equal(stats.downloadSpeed, 0);
  assert.equal(stats.numPeers, 0);
  // Readiness reads anything not "missing" as held, so the whole span counts.
  assert.deepEqual(stats.residence, [{ start: 0, end: 129241752, location: "whole-file" }]);
  assert.equal(stats.supply, null, "no swarm, so no supply to describe");
  assert.deepEqual(wholeFileStats(0).residence, [], "an empty file holds no span");
});
