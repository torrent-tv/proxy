/**
 * @file How fast the torrents may download so that the encoders keep the
 * processor they need (torrent-tv/meta#178).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { downloadShare } from "../../services/storage/processor-share.js";

// The field file of 2026-10-11 on Home Assistant: an AVI re-encoded at 720x400
// needs 2.3 s of processor per second of film; the torrent's thread took 56-63
// % of a core at 4.5-9.8 MB/s, about 0.1 s of processor per megabyte.
const avi = { bytesPerFilmSecond: 190_000, encodeCostSec: 2.3 };
const machine = { cores: 4, availableShare: 0.75, baseDraw: 0.05, costPerMegabyte: 0.1 };

test("the download gets what the encoders leave, so that both advance at one film speed", () => {
  const { filmSpeed, bytesPerSecond, capacity } = downloadShare({ ...machine, files: [avi] });
  assert.equal(capacity, 2.95);
  // The encoder and the download together use exactly what there is.
  const used = filmSpeed * avi.encodeCostSec + bytesPerSecond / 1e6 * machine.costPerMegabyte;
  assert.ok(Math.abs(used - capacity) < 1e-9, `${used} of ${capacity}`);
  assert.ok(filmSpeed > 1, "the film is made faster than it plays");
  // A fraction of what the swarm gave in the field.
  assert.ok(bytesPerSecond < 4_500_000 / 10, `${bytesPerSecond} B/s`);
});

test("with nothing encoding the download has the whole processor", () => {
  const { bytesPerSecond } = downloadShare({ ...machine, files: [{ ...avi, encodeCostSec: 0 }] });
  assert.ok(Math.abs(bytesPerSecond - 2.95 / 0.1 * 1e6) < 1e-3);
});

test("an unmeasured price of a byte, or nothing watched, leaves the download unlimited", () => {
  assert.equal(downloadShare({ ...machine, costPerMegabyte: null, files: [avi] }).bytesPerSecond, Infinity);
  assert.equal(downloadShare({ ...machine, files: [] }).bytesPerSecond, Infinity);
});

test("several films of several torrents advance at one speed, and the download never falls below what they play", () => {
  const second = { bytesPerFilmSecond: 600_000, encodeCostSec: 0.03 };
  const { filmSpeed, bytesPerSecond } = downloadShare({ ...machine, files: [avi, second] });
  assert.ok(Math.abs(bytesPerSecond - filmSpeed * (avi.bytesPerFilmSecond + second.bytesPerFilmSecond)) < 1e-6);
  // A machine that others leave too little: the films cannot keep real time,
  // and the download still brings what they play.
  const starved = downloadShare({ ...machine, availableShare: 0.3, files: [avi, second] });
  assert.ok(starved.filmSpeed < 1);
  assert.equal(starved.bytesPerSecond, avi.bytesPerFilmSecond + second.bytesPerFilmSecond);
});
