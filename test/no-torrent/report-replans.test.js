/**
 * @file A viewer's report plans the encoders again when it changes what they
 * are planned from: the piece the viewer stands in, or whether they play or
 * wait. Field 2026-10-12: a soundtrack the viewer was stopped for waited 59 s,
 * because only the end of a picture run planned again (torrent-tv/meta#178).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { movedForThePlan } from "../../routes/api/transcode-sessions/net-report/post.js";

const output = {};
const fourSecondPieces = (_output, seconds) => Math.floor(seconds / 4);

test("moving into another piece plans again, moving inside one does not", () => {
  const was = { seconds: 21, playing: true, waiting: false };
  assert.equal(movedForThePlan(was, { position: { seconds: 23.9 }, playing: true, waiting: false }, output, fourSecondPieces), false);
  assert.equal(movedForThePlan(was, { position: { seconds: 24.1 }, playing: true, waiting: false }, output, fourSecondPieces), true);
});

test("starting to wait or to play plans again in the same piece", () => {
  const was = { seconds: 23.9, playing: true, waiting: false };
  assert.equal(movedForThePlan(was, { position: { seconds: 23.9 }, playing: false, waiting: true }, output, fourSecondPieces), true);
});

test("a first report plans, and a report that states no position changes nothing about it", () => {
  assert.equal(movedForThePlan(null, { position: { seconds: 0 }, playing: false, waiting: true }, output, fourSecondPieces), true);
  const was = { seconds: 8, playing: true, waiting: false };
  assert.equal(movedForThePlan(was, { position: null, playing: true, waiting: false }, output, fourSecondPieces), false);
});

test("pieces nobody can name yet are not a move", () => {
  const was = { seconds: 8, playing: true, waiting: false };
  assert.equal(movedForThePlan(was, { position: { seconds: 30 }, playing: true, waiting: false }, output, () => null), false);
});
