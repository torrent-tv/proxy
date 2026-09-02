import test from "node:test";
import assert from "node:assert/strict";

import {
  describeMemory,
  readingIsWorthWriting,
  summariseMappings,
  watchedFigures
} from "../services/memory-report.js";
import {
  budgetForNewStore,
  SharedPieceStore,
  totalStoreBudgetBytes
} from "../services/piece-store/shared-piece-store.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
      {
        name: "a film",
        residentBytes: 504 * MEGABYTE,
        committedBytes: 504 * MEGABYTE,
        spilledBytes: 0,
        budgetBytes: 512 * MEGABYTE
      }
    ]
  });
  // The figures the kernel's own kill line quoted, so the two can be compared.
  assert.match(measured, /rss=2366MB/);
  assert.match(measured, /1 torrent store\(s\) holding 504MB, committed 504MB of 512MB allowed/);
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

test("holding and having taken are separate figures, and the line says both", () => {
  // The shape that hid 650 MB on 2026-08-28: eighteen pieces held, sixty-four
  // slots taken and never given back, and a line that only mentioned the first.
  const line = describeMemory({
    process: { rss: 893 * MEGABYTE, heapUsed: 29 * MEGABYTE, heapTotal: 34 * MEGABYTE, external: 11 * MEGABYTE, arrayBuffers: 7 * MEGABYTE },
    availableBytes: 2287 * MEGABYTE,
    availableMeasured: true,
    anonymousBytes: 870 * MEGABYTE,
    diskFreeBytes: 12000 * MEGABYTE,
    stores: [
      {
        name: "a film",
        residentBytes: 144 * MEGABYTE,
        committedBytes: 512 * MEGABYTE,
        spilledBytes: 2904 * MEGABYTE,
        budgetBytes: 512 * MEGABYTE
      }
    ]
  });
  assert.match(line, /holding 144MB, committed 512MB of 512MB allowed, 2904MB spilled to disk/);
  assert.match(line, /anon=870MB/);
  assert.match(line, /12000MB free on disk$/);
});

test("a thread's reading leaves out what belongs to the process", () => {
  // `rss` and the kernel's rollup are process-wide and are read once, on the
  // main thread. What the torrent worker can say — and the only place it can be
  // said — is its own isolate, where the piece pool actually lives.
  const line = describeMemory({
    scope: "thread",
    label: "torrent worker",
    process: { rss: 893 * MEGABYTE, heapUsed: 12 * MEGABYTE, heapTotal: 20 * MEGABYTE, external: 530 * MEGABYTE, arrayBuffers: 512 * MEGABYTE },
    stores: [
      {
        name: "a film",
        residentBytes: 144 * MEGABYTE,
        committedBytes: 512 * MEGABYTE,
        spilledBytes: 0,
        budgetBytes: 512 * MEGABYTE
      }
    ]
  });
  assert.match(line, /^memory \(torrent worker\): heap=12MB\/20MB/);
  assert.match(line, /arrayBuffers=512MB/);
  assert.doesNotMatch(line, /rss=/);
  assert.doesNotMatch(line, /machine has/);
});

test("a store's allowance follows the machine, and never passes its reservation", async () => {
  // The defect: a store created on an idle machine kept an idle machine's
  // allowance for life and went on growing into memory the host no longer had.
  const directory = await mkdtemp(path.join(os.tmpdir(), "budget-revision-"));
  const store = new SharedPieceStore(1024, {
    path: directory,
    name: "revision",
    memoryBytes: 64 * 1024
  });
  try {
    const born = store.stats().budgetBytes;
    assert.ok(born > 0);

    // The machine fills up: the ceiling comes down and growth stops there.
    const lowered = store.reviseGrowthCeiling(8 * 1024);
    assert.ok(lowered.ceilingBytes < born, "a busier machine buys fewer slots");
    assert.equal(store.stats().budgetBytes, lowered.ceilingBytes, "the line says what is allowed now");

    // The machine empties again: the ceiling may rise, but never above the
    // reservation, because `maxByteLength` was fixed from it and `grow()`
    // cannot pass it.
    const raised = store.reviseGrowthCeiling(1024 * 1024 * 1024);
    assert.equal(raised.ceilingBytes, born, "the reservation is the hard limit");
  } finally {
    await new Promise((resolve) => store.destroy(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("the line says how far the heap is from the ceiling it is killed for reaching", () => {
  // The worker died three times for reaching 2240 MB while its own line said
  // "heap=30MB" and nothing said what 30 MB was 30 MB of.
  const line = describeMemory({
    scope: "thread",
    label: "torrent worker",
    process: {
      rss: 2549 * MEGABYTE,
      heapUsed: 1800 * MEGABYTE,
      heapTotal: 1904 * MEGABYTE,
      external: 40 * MEGABYTE,
      arrayBuffers: 20 * MEGABYTE,
      heapLimit: 2240 * MEGABYTE
    },
    stores: []
  });
  assert.match(line, /heap=1800MB\/1904MB of 2240MB allowed/);

  const withoutLimit = describeMemory({
    scope: "thread",
    label: "torrent worker",
    process: { rss: 0, heapUsed: 12 * MEGABYTE, heapTotal: 20 * MEGABYTE, external: 0, arrayBuffers: 0 },
    stores: []
  });
  assert.match(withoutLimit, /heap=12MB\/20MB external=/, "an unknown ceiling is left out, not printed as zero");
});

test("a reading is written when it moved, or when the silence has gone on long enough", () => {
  const changeBytes = 25 * MEGABYTE;
  const quietMs = 60_000;
  const still = {
    watchedBytes: 100 * MEGABYTE,
    lastWrittenBytes: 100 * MEGABYTE,
    sinceWrittenMs: 1_000,
    changeBytes,
    quietMs
  };

  assert.equal(readingIsWorthWriting(still), false, "a second of nothing is not worth a line");
  assert.equal(
    readingIsWorthWriting({ ...still, sinceWrittenMs: 60_000 }),
    true,
    "a quiet minute is still written, so a healthy session reads as it always did"
  );
  // The rise that killed the worker: 818 MB to 2203 MB inside one old sample.
  assert.equal(
    readingIsWorthWriting({ ...still, watchedBytes: 130 * MEGABYTE }),
    true,
    "growth of a quarter of a gigabyte cannot wait for the minute to be up"
  );
  assert.equal(
    readingIsWorthWriting({ ...still, watchedBytes: 70 * MEGABYTE }),
    true,
    "memory given back is as interesting as memory taken"
  );
  assert.equal(
    readingIsWorthWriting({ ...still, quietMs: 0 }),
    true,
    "no quiet interval means every reading is written, which is the process scope"
  );
});

/**
 * The shape of the anonymous memory, not only its size. Three shapes, three
 * different diagnoses of the same number — see `summariseMappings`.
 */
const SMAPS = [
  "aaaad4000000-aaaad4c00000 r-xp 00000000 fe:01 1234    /usr/local/bin/node",
  "Size:              12288 kB",
  "Rss:               12000 kB",
  "aaaae0000000-aaaae4000000 rw-p 00000000 00:00 0       [heap]",
  "Size:              65536 kB",
  "Rss:               40960 kB",
  "ffff80000000-ffff80400000 rw-p 00000000 00:00 0 ",
  "Size:               4096 kB",
  "Rss:                4096 kB",
  "ffff81000000-ffff81400000 rw-p 00000000 00:00 0 ",
  "Size:               4096 kB",
  "Rss:                4096 kB",
  "ffff82000000-ffff82100000 rw-p 00000000 00:00 0 ",
  "Size:               1024 kB",
  "Rss:                 512 kB",
  "ffff83000000-ffff84000000 rw-p 00000000 00:00 0 ",
  "Size:              16384 kB",
  "Rss:                   0 kB",
  ""
].join("\n");

test("the mappings are grouped by the shape that names the cause", () => {
  const summary = summariseMappings(SMAPS);
  assert.equal(summary.heapBytes, 40960 * 1024, "the allocator's break-managed arena stands alone");
  assert.equal(summary.largeCount, 2, "two anonymous mappings of four megabytes");
  assert.equal(summary.largeBytes, 8192 * 1024);
  assert.equal(summary.largestBytes, 4096 * 1024);
  assert.equal(summary.smallCount, 1);
  assert.equal(summary.smallBytes, 512 * 1024);
  assert.equal(summary.fileBytes, 12000 * 1024, "the executable is not a leak");
});

test("a mapping that is reserved but untouched costs nothing and is not counted", () => {
  // The 16 MB mapping above has Rss 0: address space, not memory. Counting it
  // would put tens of gigabytes of V8's reservations into the reading.
  assert.equal(summariseMappings(SMAPS).largeCount, 2);
});

test("no /proc, or nothing readable, is answered with zeroes rather than a throw", () => {
  const empty = summariseMappings("");
  assert.equal(empty.heapBytes, 0);
  assert.equal(empty.largeCount, 0);
  assert.deepEqual(summariseMappings(null), empty);
});

test("the mapping shape is said in the line, and left out when it is not known", () => {
  const withShape = describeMemory({
    process: { rss: 900 * MEGABYTE, heapUsed: 27 * MEGABYTE, heapTotal: 30 * MEGABYTE, external: 6 * MEGABYTE, arrayBuffers: 2 * MEGABYTE },
    availableBytes: 800 * MEGABYTE,
    availableMeasured: true,
    anonymousBytes: 870 * MEGABYTE,
    mappings: summariseMappings(SMAPS),
    stores: []
  });
  assert.match(withShape, /mappings=\[heap 40MB, 2 anon ≥2MB = 8MB \(largest 4MB\), 1 anon <2MB = 1MB, files 12MB\]/);

  const withoutShape = describeMemory({
    process: { rss: 900 * MEGABYTE, heapUsed: 27 * MEGABYTE, heapTotal: 30 * MEGABYTE, external: 6 * MEGABYTE, arrayBuffers: 2 * MEGABYTE },
    availableBytes: 800 * MEGABYTE,
    availableMeasured: true,
    anonymousBytes: 870 * MEGABYTE,
    stores: []
  });
  assert.ok(!withoutShape.includes("mappings="), "an unread breakdown is absent, not zeroed");
});

test("a thread's line is earned by any of its three figures, not by the heap alone", () => {
  // 2026-09-02, the session that ended in two out-of-memory kills: the worker's
  // heap stood at 33-45 MB for the whole of it while its buffers went from 130
  // to 950 MB. Watching the heap alone, nothing ever earned a line and every
  // reading of the quantity that grew came out on the quiet minute.
  const before = watchedFigures("thread", {
    rss: 0, heapTotal: 38 * MEGABYTE, external: 14 * MEGABYTE, arrayBuffers: 130 * MEGABYTE
  });
  const after = watchedFigures("thread", {
    rss: 0, heapTotal: 38 * MEGABYTE, external: 14 * MEGABYTE, arrayBuffers: 515 * MEGABYTE
  });
  assert.equal(before.heap, after.heap, "the heap is what did NOT move");

  const moved = Object.entries(after).some(([name, bytes]) => readingIsWorthWriting({
    watchedBytes: bytes,
    lastWrittenBytes: before[name],
    sinceWrittenMs: 1_000,
    changeBytes: 25 * MEGABYTE,
    quietMs: 60_000
  }));
  assert.equal(moved, true, "buffers growing by 385 MB earns a line of its own");

  assert.deepEqual(
    Object.keys(watchedFigures("process", { rss: 5, heapTotal: 1, external: 2, arrayBuffers: 3 })),
    ["rss"],
    "a process is killed for its resident memory and watches that"
  );
});

test("figures a caller reads for itself land on the same line as the memory", () => {
  const line = describeMemory({
    scope: "thread",
    label: "torrent worker",
    process: {
      rss: 0, heapUsed: 34 * MEGABYTE, heapTotal: 46 * MEGABYTE,
      external: 54 * MEGABYTE, arrayBuffers: 393 * MEGABYTE, heapLimit: 0
    },
    stores: [],
    extra: "piece buffers 21544 let go, 21482 collected, 62 still alive against 53 the store holds"
  });
  assert.match(line, /arrayBuffers=393MB/);
  assert.match(line, /62 still alive against 53 the store holds$/);
  assert.doesNotMatch(
    describeMemory({
      scope: "thread",
      process: { rss: 0, heapUsed: 1, heapTotal: 2, external: 3, arrayBuffers: 4, heapLimit: 0 }
    }),
    /;\s*$/,
    "nothing to add leaves no dangling separator"
  );
});
