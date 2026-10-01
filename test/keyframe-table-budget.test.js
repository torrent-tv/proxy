/**
 * @file How long anybody waits for the file's keyframe table.
 *
 * With the table a picture is copied; without it the whole picture is
 * re-encoded, which on a weak host is the difference between almost free and
 * more than the machine has. Until 2.76.1 there was no bound on that wait at
 * all, and the file comes off a torrent — so the bytes the table lives in may
 * still be arriving, and a session could sit there for as long as they took.
 *
 * Measured on the addon host 2026-09-04 over fifteen torrents
 * (`research/keyframe-table-read-2026-09-04.md`): every read whose bytes were
 * there finished within 8.8 s, while reads on swarms of one to four peers were
 * still waiting at 60-121 s. The bound sits between those two, and what it must
 * do is pinned here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { KeyframeTables } from "../services/media/KeyframeTables.js";
import { BytesUnavailable } from "../services/media/container/unavailable.js";

const QUIET = { info: () => {}, warn: () => {} };

/**
 * @param {number} budgetMs
 * @param {(params: object) => Promise<object | null>} readTable
 * @returns {KeyframeTables}
 */
function tables(budgetMs, readTable) {
  return new KeyframeTables({ readTable, budgetMs, logger: QUIET });
}

const FILE = { sourceKey: "torrent:abc", fileIndex: 0, logName: "a.mkv" };

test("a table that arrives inside the budget is the answer", async () => {
  const keyframes = tables(1_000, async () => ({ times: [0, 4, 8], tolerance: 0, format: "matroska" }));

  const { table, arrived } = await keyframes.within(FILE);

  assert.deepEqual(table.times, [0, 4, 8]);
  assert.equal(arrived, true, "the file has answered, so the picture may be copied");
  assert.equal(table.readable, true);
});

test("a table that has not arrived gives up on copying rather than on the session", async () => {
  // The bytes it needs are still coming off the swarm. On the field host this
  // is a torrent with one peer: the read was still waiting after two minutes.
  const keyframes = tables(60, () => new Promise(() => {}));

  const startedAt = Date.now();
  const { table, arrived } = await keyframes.within(FILE);
  const waited = Date.now() - startedAt;

  assert.equal(table.readable, false, "no table, so this session cannot copy the picture");
  assert.equal(
    table.answered,
    false,
    "and the file has NOT answered — an absence recorded as an answer would make a passing " +
      "shortage of bytes look like a property of the bytes"
  );
  assert.equal(arrived, false);
  assert.ok(waited < 2_000, `the wait ended at the bound, not at the read (${waited}ms)`);
});

test("the read goes on after the budget, so the next session of the file gets the copy", async () => {
  let reads = 0;
  let answerLate = null;
  const keyframes = tables(40, () => {
    reads += 1;
    return new Promise((resolve) => {
      answerLate = resolve;
    });
  });

  const first = await keyframes.within(FILE);
  assert.equal(first.arrived, false);

  answerLate({ times: [0, 5, 10], tolerance: 0, format: "matroska" });
  // Every microtask this resolution queues, and not a chosen ten milliseconds.
  // `setImmediate` runs after the whole microtask queue of this turn, so the
  // answer has been taken in by the time it fires — where the ten milliseconds
  // were a guess about how long that takes on whatever machine is running.
  // Asking the reader again instead would have counted as another read, which
  // is the very thing the last assertion here is about.
  await new Promise((resolve) => { setImmediate(resolve); });

  const second = await keyframes.within(FILE);
  assert.deepEqual(second.table.times, [0, 5, 10], "the late answer was kept, not thrown away");
  assert.equal(second.arrived, true);
  assert.equal(reads, 1, "and it was not read a second time");
});

test("a read that fails is not turned into a bounded wait's silence", async () => {
  const keyframes = tables(1_000, async () => {
    throw new Error("the head is not downloaded");
  });

  await assert.rejects(
    () => keyframes.read(FILE),
    /the head is not downloaded/,
    "a read that threw is a different thing from a read that is still running"
  );
});

test("bytes not downloaded yet are a table that has not arrived, and the next arrival reads again", async () => {
  let calls = 0;
  const keyframes = tables(1_000, async () => {
    calls += 1;
    if (calls === 1) {
      throw new BytesUnavailable(100, 199, 0);
    }
    return { times: [0, 4], tolerance: 0, format: "matroska" };
  });

  const { table, arrived } = await keyframes.within(FILE);
  assert.equal(arrived, false, "the opening goes on and re-encodes; it is not failed over a shortage of bytes");
  assert.equal(table.answered, false, "missing bytes say nothing about the file's keyframes");

  keyframes.readAgainIfUnanswered(FILE);
  await keyframes.read(FILE);
  assert.equal(calls, 2);
  assert.deepEqual(keyframes.of(FILE).times, [0, 4]);
});
