/**
 * @file Each run's processor and speed, second by second, said once a minute
 * with how far its seconds sit from their middle (torrent-tv/meta#180, phase 1).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { describeRuns, runSecondsBetween } from "../../services/storage/processor-report.js";

/**
 * @param {number} at
 * @param {Array<[number, number, string, number | null]>} runs - pid, CPU seconds, label, film made.
 */
function reading(at, runs) {
  return {
    at,
    ffmpeg: new Map(runs.map(([pid, cpu]) => [pid, cpu])),
    runs: new Map(runs.map(([pid, , label, film]) => [pid, { label, film }]))
  };
}

test("a second of a run: the cores its ffmpeg used and the film it made per second", () => {
  const seconds = runSecondsBetween(reading(0, [[7, 10, "v #1..#5", 4]]), reading(1000, [[7, 11.5, "v #1..#5", 5.2]]));
  const second = seconds.get(7);
  assert.equal(second.label, "v #1..#5");
  assert.equal(second.cores, 1.5);
  assert.ok(Math.abs(second.speed - 1.2) < 1e-9);
});

test("a run present at one end only, or whose counter went back, says nothing", () => {
  const seconds = runSecondsBetween(reading(0, [[7, 10, "a", 1], [8, 5, "b", 1]]), reading(1000, [[8, 4, "b", 2], [9, 1, "c", 1]]));
  assert.equal(seconds.size, 0);
});

test("a run whose film is unknown says its processor alone", () => {
  const seconds = runSecondsBetween(reading(0, [[7, 10, "a", null]]), reading(1000, [[7, 10.5, "a", 3]]));
  assert.deepEqual(seconds.get(7), { label: "a", cores: 0.5, speed: null });
});

test("the minute's line: the median second and the median distance to it", () => {
  const line = describeRuns(new Map([
    [7, { label: "v #1..#5", cores: [1.5, 1.6, 1.4, 3.0], speed: [1.2, 1.1, 1.3] }],
    [8, { label: "a #1..#1", cores: [0.1], speed: [150] }]
  ]));
  // Cores: middle (1.5 + 1.6) / 2 = 1.55, distances 0.05 0.05 0.15 1.45 → 0.10.
  assert.equal(line, "v #1..#5 cores 1.55 (scatter 0.10), speed 1.20x (scatter 0.10) over 4s");
});

test("a run with no speed read says n/a, and nothing is said when no run lasted two seconds", () => {
  assert.equal(describeRuns(new Map([[7, { label: "v", cores: [1, 1], speed: [] }]])), "v cores 1.00 (scatter 0.00), speed n/a over 2s");
  assert.equal(describeRuns(new Map()), "");
});
