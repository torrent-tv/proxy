/**
 * @file How long a session waits for the file's keyframe table.
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
import { HlsSessionManager } from "../services/hls-session-manager.js";

/**
 * @param {number} budgetMs
 * @returns {HlsSessionManager}
 */
function manager(budgetMs) {
  return new HlsSessionManager({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090,
    keyframeTableBudgetMs: budgetMs
  });
}

const FILE = { sourceKey: "torrent:abc", fileIndex: 0, logName: "a.mkv" };

test("a table that arrives inside the budget is the answer", async () => {
  const sessions = manager(1_000);
  sessions.getContainerKeyframes = async () => ({ times: [0, 4, 8], tolerance: 0, format: "matroska" });

  const answer = await sessions.readKeyframeTableWithin(FILE);

  assert.deepEqual(answer.times, [0, 4, 8]);
  assert.equal(answer.arrived, true, "the file has answered, so what it said may be written onto it");
});

test("a table that has not arrived gives up on copying rather than on the session", async () => {
  const sessions = manager(60);
  // The bytes it needs are still coming off the swarm. On the field host this
  // is a torrent with one peer: the read was still waiting after two minutes.
  sessions.getContainerKeyframes = () => new Promise(() => {});

  const startedAt = Date.now();
  const answer = await sessions.readKeyframeTableWithin(FILE);
  const waited = Date.now() - startedAt;

  assert.equal(answer.times, null, "no table, so this session cannot copy the picture");
  assert.equal(
    answer.arrived,
    false,
    "and it says the file has NOT answered — an absence written onto the file would make " +
      "a passing shortage of bytes look like a property of the bytes"
  );
  assert.ok(waited < 2_000, `the wait ended at the bound, not at the read (${waited}ms)`);
});

test("the read goes on after the budget, so the next session of the file gets the copy", async () => {
  const sessions = manager(40);
  let reads = 0;
  let answerLate = null;
  sessions.getContainerKeyframes = () => {
    reads += 1;
    return new Promise((resolve) => {
      answerLate = resolve;
    });
  };

  const first = await sessions.readKeyframeTableWithin(FILE);
  assert.equal(first.arrived, false);

  answerLate({ times: [0, 5, 10], tolerance: 0, format: "matroska" });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const second = await sessions.readKeyframeTableWithin(FILE);
  assert.deepEqual(second.times, [0, 5, 10], "the late answer was kept, not thrown away");
  assert.equal(second.arrived, true);
  assert.equal(reads, 1, "and it was not read a second time");
});

test("a read that fails is not turned into a bounded wait's silence", async () => {
  const sessions = manager(1_000);
  sessions.getContainerKeyframes = async () => {
    throw new Error("the head is not downloaded");
  };

  await assert.rejects(
    () => sessions.readKeyframeTableWithin(FILE),
    /the head is not downloaded/,
    "a read that threw is a different thing from a read that is still running"
  );
});
