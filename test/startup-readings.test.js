/**
 * @file What this host must have measured before the first viewer arrives.
 *
 * The quality offer, the number of encoders and every decision about moving one
 * are arithmetic over four figures: how fast this host encodes, how fast it
 * decodes, what a second job costs it, and what starting and stopping an
 * encoder cost. A figure nobody measured is reported as zero, and zero does not
 * read as "unknown" — it reads as "free" or "instant", and the arithmetic then
 * answers confidently and wrongly.
 *
 * Two gaps this pins, both found 2026-09-10:
 *
 * 1. three of the four ran only when the chosen encoder was SOFTWARE, and two
 *    of those three are not about the encoder at all — a host with a GPU
 *    decodes in software just the same, and what a second job costs is a
 *    property of the machine. A GPU host measured none of them;
 * 2. starting and stopping were learned only from runs that had already ENDED,
 *    so at a cold open both were zero and moving an encoder was free. Field
 *    2026-09-08: an encoder moved between two adjacent numbers every half
 *    second and produced nothing.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SoftwareEncoder } from "../services/encode/SoftwareEncoder.js";
import { NvencEncoder } from "../services/encode/NvencEncoder.js";
import { QsvEncoder } from "../services/encode/QsvEncoder.js";
import { VaapiEncoder } from "../services/encode/VaapiEncoder.js";
import { V4l2m2mEncoder } from "../services/encode/V4l2m2mEncoder.js";
import { RunCosts } from "../services/encode/run-costs.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

test("every encoder kind can say how to measure itself", () => {
  const kinds = [
    new SoftwareEncoder(),
    new NvencEncoder(),
    new QsvEncoder(),
    new VaapiEncoder("/dev/dri/renderD128"),
    new V4l2m2mEncoder()
  ];
  for (const encoder of kinds) {
    const args = encoder.benchmarkArgs(null);
    assert.ok(Array.isArray(args) && args.length >= 2, `${encoder.name} says nothing`);
    assert.ok(args.includes("-c:v"), `${encoder.name} does not name a codec`);
    assert.ok(
      args.some((arg) => String(arg).includes(encoder.name)),
      `${encoder.name} does not name itself`
    );
  }
});

test("a kind with a ladder is measured at every rung of it", () => {
  for (const encoder of [new SoftwareEncoder(), new NvencEncoder(), new QsvEncoder()]) {
    const ladder = encoder.speedLadder;
    assert.ok(ladder.values.length > 1, `${encoder.name} declares no ladder to walk`);
    const rungs = ladder.values.map((rung) => encoder.benchmarkArgs(rung).join(" "));
    assert.equal(new Set(rungs).size, ladder.values.length, `${encoder.name} gives the same arguments for different rungs`);
  }
});

test("nothing about the machine is asked only of a software encoder", () => {
  // Decoding and contention are properties of the host. Asked only where the
  // encoder was software, a host with a GPU had neither, and the quality offer
  // could not price a re-encode nor a second process.
  const server = readFileSync(path.join(HERE, "..", "server.js"), "utf8");
  for (const call of ["benchmarkDecodeCost", "benchmarkContention"]) {
    const at = server.indexOf(call);
    assert.ok(at > 0, `${call} is not called at startup at all`);
    const before = server.slice(Math.max(0, at - 200), at);
    assert.equal(
      before.includes('kind === "software"'),
      false,
      `${call} is still gated on the encoder being software`
    );
  }
});

test("the throughput benchmark is given the encoder that will actually run", () => {
  const server = readFileSync(path.join(HERE, "..", "server.js"), "utf8");
  assert.match(
    server,
    /benchmarkSoftwarePresets\(\{[^}]*encoder: videoEncoder/,
    "the benchmark is not told which encoder to measure"
  );
});

test("a start and a stop are measured before any viewer, and reach the plan", () => {
  const server = readFileSync(path.join(HERE, "..", "server.js"), "utf8");
  assert.match(server, /await measureStartAndStop\(/, "nothing measures a start at startup");
  assert.match(server, /\n    startStopCost,/, "the reading never reaches the session manager");

  const manager = readFileSync(path.join(HERE, "..", "services", "hls-session-manager.js"), "utf8");
  assert.match(
    manager,
    /noteStartupCosts\(startStopCost\)/,
    "the reading never reaches the encoding orchestrator"
  );
});

test("with a startup reading, a cold plan is not told that starting is free", () => {
  const costs = new RunCosts();
  assert.equal(costs.seconds().firstByteWaitSec, 0, "nothing measured yet is nothing");

  costs.noteStartup({ firstByteWaitSec: 0.68, killCostSec: 0.02 });
  const cold = costs.seconds();
  assert.equal(cold.firstByteWaitSec, 0.68, "the startup reading is not used");
  assert.equal(cold.killCostSec, 0.02);

  // A real run replaces it: the startup figure is where the plan starts from,
  // not where it stays.
  costs.note({ firstOutputMs: 4000, dyingMs: 300 });
  const warm = costs.seconds();
  assert.equal(warm.firstByteWaitSec, 4);
  assert.equal(warm.killCostSec, 0.3);
});
