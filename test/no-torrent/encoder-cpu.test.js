/**
 * @file The CPU this proxy's FFmpeg processes used between two readings,
 * runs that started or ended between them included (torrent-tv/meta#178).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { encoderCpuBetween } from "../../services/encode/quality/encoder-cpu.js";

const reading = (takenAt, live, endedChildren, startedAt = {}) => ({
  takenAt, endedChildren,
  byPid: new Map(Object.entries(live).map(([pid, seconds]) => [Number(pid), seconds])),
  startedAt: new Map(Object.entries(startedAt).map(([pid, at]) => [Number(pid), at]))
});

test("a run that started and ended between two readings is counted, from the time the kernel kept for it", () => {
  // r41, Home Assistant: a run of one piece between readings 5 s apart, 6.65 s of CPU.
  const before = reading(0, {}, 100.0);
  const after = reading(5_000, {}, 106.65);
  const result = encoderCpuBetween(before, after);
  assert.equal(result.complete, true);
  assert.ok(Math.abs(result.seconds - 6.65) < 1e-9, String(result.seconds));
});

test("each process is counted once: still alive, started since, or ended since", () => {
  const before = reading(0, { 10: 4.0, 11: 2.0 }, 50.0);
  // 10 moved 1.5 s; 11 ended with 3.0 s in all, 1.0 s of it since; 12 started and used 0.7 s.
  const after = reading(5_000, { 10: 5.5, 12: 0.7 }, 53.0, { 12: 2_000 });
  const result = encoderCpuBetween(before, after);
  assert.equal(result.complete, true);
  assert.ok(Math.abs(result.seconds - (1.5 + 1.0 + 0.7)) < 1e-9, String(result.seconds));
});

test("what cannot be told is incomplete, never a measured zero", () => {
  assert.equal(encoderCpuBetween(reading(0, {}, null), reading(5_000, {}, null)), null, "nothing read at all");
  assert.equal(encoderCpuBetween(reading(0, { 10: 4 }, null), reading(5_000, {}, null)).complete, false, "ended, and no ended-children time");
  assert.equal(encoderCpuBetween(reading(0, {}, 50), reading(5_000, { 10: 4 }, 50, { 10: -1 })).complete, false,
    "alive before the first reading and not read in it");
  assert.equal(encoderCpuBetween(reading(0, { 10: 4 }, 50), reading(5_000, {}, 50)).complete, false,
    "gone from the reading without its time arriving in the ended children");
});
