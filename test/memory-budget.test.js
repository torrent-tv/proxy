import test from "node:test";
import assert from "node:assert/strict";

import { describeMemory } from "../services/memory-report.js";
import {
  budgetForNewStore,
  totalStoreBudgetBytes
} from "../services/piece-store/shared-piece-store.js";

const MEGABYTE = 1024 * 1024;
const GIGABYTE = 1024 * MEGABYTE;

test("the whole of the torrent stores is bounded, not each one of them", () => {
  // The failure this replaces: the budget was per torrent, so two torrents took
  // two of it. Whatever the machine has, the total is one budget.
  const available = 8 * GIGABYTE;
  const alone = budgetForNewStore(available, 1);
  const withThree = budgetForNewStore(available, 3);
  assert.equal(alone, totalStoreBudgetBytes(available));
  assert.ok(withThree < alone, "a third store must not be given a first store's share");
  assert.ok(withThree * 3 <= totalStoreBudgetBytes(available) + 3);
});

test("the budget is a share of what the machine can give, capped", () => {
  // A quarter of two gigabytes is under the ceiling and is what is taken.
  assert.equal(totalStoreBudgetBytes(2 * GIGABYTE), 512 * MEGABYTE);
  // A quarter of one gigabyte is 256 MB — below the ceiling, so not capped.
  assert.equal(totalStoreBudgetBytes(GIGABYTE), 256 * MEGABYTE);
  // And it never exceeds the ceiling however much is free.
  assert.equal(totalStoreBudgetBytes(64 * GIGABYTE), 512 * MEGABYTE);
});

test("a machine with almost nothing left still gets a workable floor", () => {
  // Refusing to serve is worse than exceeding the share, and the memory line
  // says plainly what is held either way.
  const tiny = budgetForNewStore(32 * MEGABYTE, 4);
  assert.equal(tiny, 64 * MEGABYTE);
});

test("the memory line says bytes, and names what it could not measure", () => {
  const usage = {
    rss: 2422628 * 1024,
    heapUsed: 180 * MEGABYTE,
    heapTotal: 220 * MEGABYTE,
    external: 900 * MEGABYTE,
    arrayBuffers: 850 * MEGABYTE
  };
  const measured = describeMemory({
    process: usage,
    availableBytes: 1900 * MEGABYTE,
    availableMeasured: true,
    stores: [
      { name: "a film", residentBytes: 504 * MEGABYTE, budgetBytes: 512 * MEGABYTE }
    ]
  });
  // The figures the kernel's own kill line quoted, so the two can be compared.
  assert.match(measured, /rss=2366MB/);
  assert.match(measured, /1 torrent store\(s\) holding 504MB of 512MB allowed/);
  assert.match(measured, /machine has 1900MB available$/);

  const estimated = describeMemory({
    process: usage,
    availableBytes: 1900 * MEGABYTE,
    availableMeasured: false,
    stores: []
  });
  assert.match(estimated, /no torrent stores/);
  assert.match(estimated, /estimated — \/proc\/meminfo could not be read/);
});
