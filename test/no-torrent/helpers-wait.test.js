/**
 * @file `helpers/wait.js`: `until` and `settle`, the two ways a check waits.
 *
 * A check that proves something DID happen waits for the event (`until`); a
 * check that proves something did NOT happen lets everything already queued run
 * (`settle`) and then looks — it never sleeps a fixed time and hopes. Nine
 * local poll loops and four local settles stood in for these.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { until, settle } from "./helpers/wait.js";

test("until resolves as soon as the check holds, and does not wait when it already does", async () => {
  const started = Date.now();
  await until(() => true, "something that already holds", { limitMs: 5_000 });
  assert.ok(Date.now() - started < 1_000, "a check that holds was waited on");
});

test("until keeps asking until the check holds", async () => {
  let asked = 0;
  await until(() => ++asked >= 4, "the fourth asking", { limitMs: 5_000 });
  assert.equal(asked, 4);
});

test("until sees a change made later by something else", async () => {
  let ready = false;
  setImmediate(() => { ready = true; });
  await until(() => ready, "the flag", { limitMs: 5_000 });
  assert.equal(ready, true);
});

test("until accepts a check that answers with a promise", async () => {
  let asked = 0;
  await until(async () => ++asked >= 2, "an asynchronous check", { limitMs: 5_000 });
  assert.ok(asked >= 2);
});

test("until rejects after the limit, and the message names what was waited for", async () => {
  const started = Date.now();
  await assert.rejects(
    until(() => false, "the segment to be written", { limitMs: 40 }),
    (error) => error instanceof Error && error.message.includes("the segment to be written")
  );
  const took = Date.now() - started;
  assert.ok(took >= 30, `gave up after ${took} ms, before its limit`);
  assert.ok(took < 3_000, `gave up after ${took} ms, long after its limit`);
});

test("until stops asking once it has given up", async () => {
  let asked = 0;
  await assert.rejects(until(() => { asked += 1; return false; }, "never", { limitMs: 30 }));
  const atRejection = asked;
  await settle(20);
  assert.equal(asked, atRejection, "the check is still being polled after the rejection");
});

test("settle returns a promise that is not already done", async () => {
  let later = false;
  const waiting = settle();
  assert.ok(waiting instanceof Promise);
  waiting.then(() => { later = true; });
  assert.equal(later, false);
  await waiting;
});

test("settle lets what is already queued run: a microtask chain and a queued immediate", async () => {
  const order = [];
  setImmediate(() => order.push("immediate"));
  Promise.resolve().then(() => order.push("microtask"));
  await settle();
  assert.deepEqual(order, ["microtask", "immediate"]);
});

test("settle(n) gives n turns, so work that queues more work n deep has finished", async () => {
  let depth = 0;
  const queueMore = () => { depth += 1; if (depth < 3) setImmediate(queueMore); };
  setImmediate(queueMore);
  await settle(3);
  assert.equal(depth, 3);
});

test("settle waits for turns of the event loop, not for a stretch of the clock", async () => {
  const started = Date.now();
  await settle(100);
  assert.ok(Date.now() - started < 1_000, "a hundred turns took a second: settle is sleeping");
});
