/** Keyframe reads preserve missing-byte facts without elapsed-time choices. */

import test from "node:test";
import assert from "node:assert/strict";
import { KeyframeTables } from "../../services/media/KeyframeTables.js";
import { BytesUnavailable } from "../../services/media/container/unavailable.js";

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

test("pending reads retain copying eligibility until the source answers", async () => {
  let answer;
  const keyframes = tables(1, () => new Promise(resolve => { answer = resolve; }));
  const waiting = keyframes.within(FILE);
  const table = keyframes.of(FILE);
  assert.equal(table.answered, false);
  answer({ times: [0, 4, 8], tolerance: 0, format: "matroska" });
  const result = await waiting;
  assert.equal(result.table, table);
  assert.equal(result.arrived, true);
  assert.equal(table.readable, true);
});

test("concurrent callers await the same table read", async () => {
  let reads = 0, answer;
  const keyframes = tables(1, () => {
    reads++;
    return new Promise(resolve => { answer = resolve; });
  });
  const first = keyframes.within(FILE), second = keyframes.within(FILE);
  answer({ times: [0, 5, 10], tolerance: 0, format: "matroska" });
  assert.equal((await first).table, (await second).table);
  assert.equal(reads, 1);
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
  assert.equal(arrived, false, "missing bytes leave copying eligibility unanswered");
  assert.equal(table.answered, false, "missing bytes say nothing about the file's keyframes");

  keyframes.readAgainIfUnanswered(FILE);
  await keyframes.read(FILE);
  assert.equal(calls, 2);
  assert.deepEqual(keyframes.of(FILE).times, [0, 4]);
});
