/**
 * @file The arithmetic that turns two readings of the machine into shares.
 *
 * The readings themselves are files this host may or may not have; what is
 * tested here is what is DERIVED from them, because that is where a wrong
 * number would quietly become a wrong conclusion about why an encoder is slow.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { readProcessCpuSeconds, readSystemCpu, sampleHost, shareOfMachine } from "../services/host-load.js";

test("a process using one core of four for a second reports a quarter of the machine", () => {
  const before = { takenAt: 1_000, processCpuSeconds: 10, system: null };
  const after = { takenAt: 2_000, processCpuSeconds: 11, system: null };
  const share = shareOfMachine(before, after, 4);
  assert.equal(share?.elapsedSec, 1);
  assert.equal(share?.processShare, 0.25);
});

test("a process using every core reports the whole machine", () => {
  const share = shareOfMachine(
    { takenAt: 0, processCpuSeconds: 0, system: null },
    { takenAt: 2_000, processCpuSeconds: 8, system: null },
    4
  );
  assert.equal(share?.processShare, 1);
});

test("waiting for a disk is counted apart from working", () => {
  const before = { takenAt: 0, processCpuSeconds: null, system: { busySeconds: 100, idleSeconds: 900, iowaitSeconds: 10 } };
  const after = { takenAt: 1_000, processCpuSeconds: null, system: { busySeconds: 101, idleSeconds: 902, iowaitSeconds: 11 } };
  const share = shareOfMachine(before, after, 4);
  assert.equal(share?.systemShare, 0.25);
  assert.equal(share?.iowaitShare, 0.25);
});

test("two readings taken at the same instant say nothing rather than dividing by zero", () => {
  assert.equal(shareOfMachine({ takenAt: 5, processCpuSeconds: 1, system: null }, { takenAt: 5, processCpuSeconds: 2, system: null }, 4), null);
});

test("a missing reading leaves that share unknown, not zero", () => {
  const share = shareOfMachine(
    { takenAt: 0, processCpuSeconds: null, system: null },
    { takenAt: 1_000, processCpuSeconds: 1, system: null },
    4
  );
  assert.equal(share?.processShare, null);
  assert.equal(share?.systemShare, null);
});

test("a process that does not exist reports nothing at all", async () => {
  assert.equal(await readProcessCpuSeconds(0), null);
  assert.equal(await readProcessCpuSeconds(-1), null);
  // A pid far above any real one on this machine.
  assert.equal(await readProcessCpuSeconds(4_000_000), null);
});

test("on a host without /proc the readings are null and the sampler still answers", async () => {
  // This runs on Linux in CI and on Windows here; both must be safe. What is
  // asserted is the SHAPE — a reading is either a number or null, never a throw.
  const system = await readSystemCpu();
  assert.ok(system === null || typeof system.busySeconds === "number");
  const sample = await sampleHost(null);
  assert.equal(typeof sample.takenAt, "number");
  assert.equal(sample.processCpuSeconds, null);
});
