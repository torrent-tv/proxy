/**
 * @file One budget: one owner, one policy, a share per resource.
 *
 * What it replaced was two owners applying one rule to two readings — memory
 * divided inside the torrent thread, disk divided on the main one, neither able
 * to see the other. The claimants TRADE ACROSS RESOURCES: pieces that do not
 * fit in memory are spilled to disk, so how much memory the piece store is
 * given decides how much disk it needs. Field 2026-08-31: 14 400 MB spilled in
 * fifty minutes while the memory store held 312-424 MB.
 *
 * And "disk" is not one resource. Measured on the addon host 2026-09-05,
 * `/tmp` is the overlay filesystem and `/data` is ext4 on the nvme — two
 * devices, so one figure divided between claimants on both gives each a share
 * of a disk it does not write to.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { MachineBudget } from "../../services/storage/MachineBudget.js";

const MEGABYTE = 1024 * 1024;

/**
 * @param {{ name: string, resource: string, held?: number, wanted: number, minimum?: number }} shape
 * @returns {{ claimant: object, allowed: () => number }}
 */
function claimantOf({ name, resource, held = 0, wanted, minimum }) {
  let allowed = 0;
  return {
    claimant: {
      name,
      resource,
      minimum,
      held: () => held,
      wanted: () => wanted,
      allow: (bytes) => {
        allowed = bytes;
      }
    },
    allowed: () => allowed
  };
}

test("each resource is divided on its own — a share of memory is not a share of disk", async () => {
  const budget = new MachineBudget({ logger: { info: () => {}, warn: () => {} } });
  budget.defineResource({ name: "memory", readFree: () => 100 * MEGABYTE });
  budget.defineResource({ name: "disk:tmp", readFree: () => 10 * MEGABYTE });

  const pieces = claimantOf({ name: "pieces in memory", resource: "memory", wanted: Number.MAX_SAFE_INTEGER });
  const segments = claimantOf({ name: "segments", resource: "disk:tmp", wanted: Number.MAX_SAFE_INTEGER });
  budget.register(pieces.claimant);
  budget.register(segments.claimant);

  await budget.revise();

  assert.equal(pieces.allowed(), 100 * MEGABYTE, "memory is divided from what memory has");
  assert.equal(segments.allowed(), 10 * MEGABYTE, "and disk from what that disk has");
});

test("two devices are two resources — one is not cut to pay for the other", async () => {
  const budget = new MachineBudget({ logger: { info: () => {}, warn: () => {} } });
  budget.defineResource({ name: "disk:66305", readFree: () => 8 * MEGABYTE });
  budget.defineResource({ name: "disk:68", readFree: () => 80 * MEGABYTE });

  // The shape on the addon host: segments and spill on the overlay, the
  // evidence on the nvme.
  const segments = claimantOf({ name: "segments", resource: "disk:68", wanted: Number.MAX_SAFE_INTEGER });
  const spill = claimantOf({ name: "spilled pieces", resource: "disk:68", wanted: Number.MAX_SAFE_INTEGER });
  const evidence = claimantOf({ name: "diagnostics", resource: "disk:66305", wanted: Number.MAX_SAFE_INTEGER });
  for (const one of [segments, spill, evidence]) {
    budget.register(one.claimant);
  }

  await budget.revise();

  assert.equal(evidence.allowed(), 8 * MEGABYTE, "the evidence gets the disk it actually writes to, whole");
  assert.equal(segments.allowed() + spill.allowed(), 80 * MEGABYTE, "and the other device is divided among its own");
});

test("a fixed ceiling is the operator's, and it binds", async () => {
  const budget = new MachineBudget({
    policy: { kind: "fixed", bytes: 5 * MEGABYTE },
    logger: { info: () => {}, warn: () => {} }
  });
  budget.defineResource({ name: "disk", readFree: () => 1000 * MEGABYTE });
  const segments = claimantOf({ name: "segments", resource: "disk", wanted: Number.MAX_SAFE_INTEGER });
  budget.register(segments.claimant);

  await budget.revise();

  assert.equal(segments.allowed(), 5 * MEGABYTE, "a disk with a gigabyte free is still capped at what was asked for");
});

test("a share of free is the operator's too", async () => {
  const budget = new MachineBudget({
    policy: { kind: "share", share: 0.25 },
    logger: { info: () => {}, warn: () => {} }
  });
  budget.defineResource({ name: "disk", readFree: () => 40 * MEGABYTE });
  const segments = claimantOf({ name: "segments", resource: "disk", held: 0, wanted: Number.MAX_SAFE_INTEGER });
  budget.register(segments.claimant);

  await budget.revise();

  assert.equal(segments.allowed(), 10 * MEGABYTE);
});

test("a floor lifts a policy that would allow less, and cannot invent room", async () => {
  const budget = new MachineBudget({
    policy: { kind: "fixed", bytes: MEGABYTE, floors: { disk: 6 * MEGABYTE } },
    logger: { info: () => {}, warn: () => {} }
  });
  budget.defineResource({ name: "disk", readFree: () => 4 * MEGABYTE });
  const segments = claimantOf({ name: "segments", resource: "disk", wanted: Number.MAX_SAFE_INTEGER });
  budget.register(segments.claimant);

  await budget.revise();

  assert.equal(
    segments.allowed(),
    4 * MEGABYTE,
    "the floor lifts the ceiling above the fixed one, but never past what the machine has"
  );
});

test("a resource that cannot be read allows nothing to grow", async () => {
  const budget = new MachineBudget({ logger: { info: () => {}, warn: () => {} } });
  budget.defineResource({ name: "disk", readFree: () => null });
  const segments = claimantOf({ name: "segments", resource: "disk", held: 0, wanted: Number.MAX_SAFE_INTEGER });
  budget.register(segments.claimant);

  await budget.revise();

  assert.equal(segments.allowed(), 0, "unreadable is not the same as unbounded");
});

test("a claimant below its own minimum says so", async () => {
  const said = [];
  const budget = new MachineBudget({ logger: { info: () => {}, warn: (line) => said.push(line) } });
  budget.defineResource({ name: "memory", readFree: () => MEGABYTE });
  budget.register(claimantOf({
    name: "pieces in memory", resource: "memory", wanted: Number.MAX_SAFE_INTEGER, minimum: 64 * MEGABYTE
  }).claimant);

  await budget.revise();

  assert.equal(said.length, 1, "working below what it needs is a fault of the machine, and invisible otherwise");
  assert.match(said[0], /below the 64MB it needs/);
});
