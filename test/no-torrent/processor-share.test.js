/**
 * @file How fast the torrents may download so that the encoders keep the
 * processor they need (torrent-tv/meta#178). Every figure is a share of the
 * whole machine.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { downloadShare } from "../../services/storage/processor-share.js";

// The AVI of the field check of 2026-10-11 on Home Assistant: 2 362 982 400
// bytes over 8 136 s of film, re-encoded at 720x400 at 2.49x (the machine's
// 1/2.49 s per second of film), 73 % of the machine left by others, this
// process drawing 0.6 % doing nothing priced, and the torrent thread's 52 ms of
// one core per megabyte on four cores.
const avi = { bytesPerFilmSecond: 2_362_982_400 / 8136, encodeCostSec: 1 / 2.49 };
const machine = { availableShare: 0.73, baseDraw: 0.006, costPerMegabyte: 0.052 / 4 };

test("the processor the proxy has is a share of the machine, less what it draws doing nothing priced", () => {
  assert.equal(downloadShare({ ...machine, files: [avi] }).capacity, 0.73 - 0.006);
  assert.equal(downloadShare({ ...machine, baseDraw: 0, files: [avi] }).capacity, 0.73);
});

test("the download gets what the encoders leave, so that both advance at one film speed", () => {
  const { filmSpeed, bytesPerSecond, capacity } = downloadShare({ ...machine, files: [avi] });
  // The encoder and the download together use exactly what there is.
  const used = filmSpeed * avi.encodeCostSec + bytesPerSecond / 1e6 * machine.costPerMegabyte;
  assert.ok(Math.abs(used - capacity) < 1e-12, `${used} of ${capacity}`);
  assert.ok(filmSpeed > 1, "the film is made faster than it plays");
  assert.ok(Math.abs(bytesPerSecond - filmSpeed * avi.bytesPerFilmSecond) < 1e-6);
  // Well below the 6-8 MB/s the swarm gave in the field.
  assert.ok(bytesPerSecond < 1_000_000, `${bytesPerSecond} B/s`);
});

test("with nothing encoding the download has the whole share", () => {
  const { bytesPerSecond } = downloadShare({ ...machine, files: [{ ...avi, encodeCostSec: 0 }] });
  assert.ok(Math.abs(bytesPerSecond - (0.73 - 0.006) / machine.costPerMegabyte * 1e6) < 1e-3);
});

test("an unmeasured price of a byte, or nothing watched, leaves the download unlimited", () => {
  assert.equal(downloadShare({ ...machine, costPerMegabyte: null, files: [avi] }).bytesPerSecond, Infinity);
  assert.equal(downloadShare({ ...machine, files: [] }).bytesPerSecond, Infinity);
});

test("several films of several torrents advance at one speed, and the download never falls below what they play", () => {
  const second = { bytesPerFilmSecond: 600_000, encodeCostSec: 0.003 };
  const { filmSpeed, bytesPerSecond } = downloadShare({ ...machine, files: [avi, second] });
  assert.ok(Math.abs(bytesPerSecond - filmSpeed * (avi.bytesPerFilmSecond + second.bytesPerFilmSecond)) < 1e-6);
  // A machine that others leave too little: the films cannot keep real time,
  // and the download still brings what they play.
  const starved = downloadShare({ ...machine, availableShare: 0.3, files: [avi, second] });
  assert.ok(starved.filmSpeed < 1);
  assert.equal(starved.bytesPerSecond, avi.bytesPerFilmSecond + second.bytesPerFilmSecond);
});
