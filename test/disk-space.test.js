/**
 * @file One disk, one owner, three claimants.
 *
 * What these pin is the thing that was wrong: each consumer read the free space
 * as though it were alone, so three ceilings each stood for the whole disk.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { DiskSpace } from "../services/disk/DiskSpace.js";

const MEGABYTE = 1024 * 1024;

/**
 * @param {string} name
 * @param {number} held
 * @param {number} wanted
 */
function consumerOf(name, held, wanted) {
  const state = { allowed: -1 };
  return {
    state,
    consumer: {
      name,
      held: () => held,
      wanted: () => wanted,
      allow: (bytes) => {
        state.allowed = bytes;
      }
    }
  };
}

test("what everyone may hold together never exceeds what the disk has", async () => {
  const free = 100 * MEGABYTE;
  const space = new DiskSpace({ readFree: async () => free });
  const segments = consumerOf("segments", 10 * MEGABYTE, 1000 * MEGABYTE);
  const pieces = consumerOf("pieces", 20 * MEGABYTE, 1000 * MEGABYTE);
  const diagnostics = consumerOf("diagnostics", 5 * MEGABYTE, 1000 * MEGABYTE);
  space.register(segments.consumer);
  space.register(pieces.consumer);
  space.register(diagnostics.consumer);

  const { allowanceBytes } = await space.revise();

  const together = segments.state.allowed + pieces.state.allowed + diagnostics.state.allowed;
  assert.ok(together <= allowanceBytes, "the shares add up to more than the allowance");
  // Free space plus what they already hold: that pair is the ceiling they could
  // reach, which is the same statement the memory allowance makes.
  assert.equal(allowanceBytes, free + 35 * MEGABYTE);
  assert.ok(
    together <= free + 35 * MEGABYTE,
    "three consumers were between them allowed more than the disk has"
  );
});

test("when everyone's ask fits, everyone gets it and the disk never binds", async () => {
  const space = new DiskSpace({ readFree: async () => 1000 * MEGABYTE });
  const small = consumerOf("diagnostics", 0, 5 * MEGABYTE);
  const large = consumerOf("segments", 0, 500 * MEGABYTE);
  space.register(small.consumer);
  space.register(large.consumer);

  await space.revise();

  assert.equal(small.state.allowed, 5 * MEGABYTE);
  assert.equal(large.state.allowed, 500 * MEGABYTE);
});

test("when they do not fit, each is cut in proportion to what it asked", async () => {
  // The same rule memory divides by, and the same reason: a share taken from
  // whoever asked most would hand the disk to whoever grew fastest.
  const space = new DiskSpace({ readFree: async () => 200 * MEGABYTE });
  const modest = consumerOf("diagnostics", 0, 100 * MEGABYTE);
  const greedy = consumerOf("segments", 0, 300 * MEGABYTE);
  space.register(modest.consumer);
  space.register(greedy.consumer);

  await space.revise();

  assert.equal(modest.state.allowed, 50 * MEGABYTE);
  assert.equal(greedy.state.allowed, 150 * MEGABYTE);
  assert.equal(modest.state.allowed + greedy.state.allowed, 200 * MEGABYTE);
});

test("a disk that fills lowers every share, rather than keeping one taken when it was empty", async () => {
  let free = 1000 * MEGABYTE;
  const space = new DiskSpace({ readFree: async () => free });
  const segments = consumerOf("segments", 0, 10_000 * MEGABYTE);
  const pieces = consumerOf("pieces", 0, 10_000 * MEGABYTE);
  space.register(segments.consumer);
  space.register(pieces.consumer);

  await space.revise();
  const roomy = segments.state.allowed;

  free = 40 * MEGABYTE;
  await space.revise();

  assert.ok(segments.state.allowed < roomy, "the share did not follow the disk down");
  assert.ok(pieces.state.allowed < roomy, "the other share did not follow either");
});

test("what another process took is left for it, not spent", async () => {
  // Between two readings the disk lost 400 MB that none of our consumers took.
  // That is a measurement of somebody else's demand, and it is what the next
  // allowance leaves alone.
  let free = 1000 * MEGABYTE;
  const space = new DiskSpace({ readFree: async () => free });
  const only = consumerOf("segments", 0, 10_000 * MEGABYTE);
  space.register(only.consumer);

  await space.revise();
  free = 600 * MEGABYTE;
  const { allowanceBytes } = await space.revise();

  assert.equal(allowanceBytes, 200 * MEGABYTE, "the fall we did not cause was spent anyway");
});

test("a disk that cannot be read allows nothing to grow", async () => {
  const space = new DiskSpace({ readFree: async () => null });
  const segments = consumerOf("segments", 0, 500 * MEGABYTE);
  space.register(segments.consumer);

  const { freeBytes, allowanceBytes } = await space.revise();

  assert.equal(freeBytes, 0);
  assert.equal(allowanceBytes, 0);
  assert.equal(segments.state.allowed, 0, "an unreadable disk was treated as an empty one");
});

test("it says what the disk has and what each claimant may hold", async () => {
  const space = new DiskSpace({ readFree: async () => 100 * MEGABYTE });
  assert.match(space.describe(), /nothing has claimed/);
  space.register(consumerOf("segments", 4 * MEGABYTE, 8 * MEGABYTE).consumer);
  await space.revise();
  assert.match(space.describe(), /disk: 100MB free; segments 4MB of 8MB/);
});

test("it says what it decided, every pass", async () => {
  const lines = [];
  const space = new DiskSpace({
    readFree: async () => 100 * MEGABYTE,
    logger: { info: (line) => lines.push(line) }
  });
  space.register(consumerOf("segments", 4 * MEGABYTE, 8 * MEGABYTE).consumer);
  await space.revise();
  assert.equal(lines.length, 1, "a pass that decided the shares said nothing about them");
  assert.match(lines[0], /disk: 100MB free; segments 4MB of 8MB/);
});
