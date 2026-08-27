import test from "node:test";
import assert from "node:assert/strict";

import { wedgeIsCertain } from "../services/data-channel-handler.js";
import { PROBE_INTERVAL_MS } from "../services/delivery-probe.js";

const MEGABYTE = 1024 * 1024;

test("a queue draining at the rate this link was measured at is not a wedge", () => {
  // 8 MB at 16 MB/s is half a second of draining. Half a second in is normal.
  const verdict = wedgeIsCertain({
    queuedBytes: 8 * MEGABYTE,
    bytesPerSecond: 16 * MEGABYTE,
    flatForMs: 200
  });
  assert.equal(verdict.certain, false);
});

test("the counter standing still past the queue's own drain time is a wedge", () => {
  const verdict = wedgeIsCertain({
    queuedBytes: 8 * MEGABYTE,
    bytesPerSecond: 16 * MEGABYTE,
    flatForMs: 4000
  });
  assert.equal(verdict.certain, true);
  assert.equal(verdict.needMs, 500);
});

test("a big queue on a slow link is given the time it genuinely needs", () => {
  // 67 MB at 1 MB/s is 67 seconds of honest draining — the field's own numbers
  // for the wedged channel, at a rate a thin link could really be running at.
  const patient = wedgeIsCertain({
    queuedBytes: 67 * MEGABYTE,
    bytesPerSecond: MEGABYTE,
    flatForMs: 30_000
  });
  assert.equal(patient.certain, false);
  const later = wedgeIsCertain({
    queuedBytes: 67 * MEGABYTE,
    bytesPerSecond: MEGABYTE,
    flatForMs: 70_000
  });
  assert.equal(later.certain, true);
});

test("the same queue on the link the field actually had is called quickly", () => {
  // 67 MB at 18 MB/s is under four seconds. The field episode stood still for
  // 3217 s; the previous rule waited a flat 30 s before recording anything.
  const verdict = wedgeIsCertain({
    queuedBytes: 67 * MEGABYTE,
    bytesPerSecond: 18 * MEGABYTE,
    flatForMs: 5000
  });
  assert.equal(verdict.certain, true);
  assert.ok(verdict.needMs < 30_000);
});

test("a tiny queue still waits for one round of probes", () => {
  const verdict = wedgeIsCertain({
    queuedBytes: 512,
    bytesPerSecond: 16 * MEGABYTE,
    flatForMs: PROBE_INTERVAL_MS - 1
  });
  assert.equal(verdict.certain, false);
  assert.equal(verdict.needMs, PROBE_INTERVAL_MS);
});

test("nothing queued is not a wedge however long the counter has been still", () => {
  const verdict = wedgeIsCertain({
    queuedBytes: 0,
    bytesPerSecond: 16 * MEGABYTE,
    flatForMs: 600_000
  });
  assert.equal(verdict.certain, false);
  assert.equal(verdict.needMs, null);
});

test("with no rate measured the answer is that nothing can be said", () => {
  const verdict = wedgeIsCertain({
    queuedBytes: 8 * MEGABYTE,
    bytesPerSecond: 0,
    flatForMs: 600_000
  });
  assert.equal(verdict.certain, false);
  assert.equal(verdict.needMs, null);
});

test("a pause no longer than this link's own longest healthy pause is not a wedge", () => {
  // A retransmission timeout stops the accepted-byte counter dead: a full send
  // buffer accepts nothing. If this connection has already paused 3 s while
  // healthy, a 3 s pause says nothing.
  const verdict = wedgeIsCertain({
    queuedBytes: 8 * MEGABYTE,
    bytesPerSecond: 18 * MEGABYTE,
    flatForMs: 2500,
    longestHealthyFlatMs: 3000
  });
  assert.equal(verdict.certain, false);
  assert.equal(verdict.needMs, 3000);
});

test("a pause longer than any this link has shown is a wedge", () => {
  const verdict = wedgeIsCertain({
    queuedBytes: 8 * MEGABYTE,
    bytesPerSecond: 18 * MEGABYTE,
    flatForMs: 3500,
    longestHealthyFlatMs: 3000
  });
  assert.equal(verdict.certain, true);
});

test("the quiet-probe rate cannot be what the queue is divided by", () => {
  // With the browser's buffer full, the only traffic is the probe: three
  // channels, a few dozen bytes, twice a second. Dividing 8 MB by that gives
  // six hours, and the wedge would never be called. The BEST rate seen is what
  // the watcher keeps, so this case must not arise — pinned here as the
  // arithmetic that made it matter.
  const wrong = wedgeIsCertain({
    queuedBytes: 8 * MEGABYTE,
    bytesPerSecond: 360,
    flatForMs: 60_000
  });
  assert.equal(wrong.certain, false);
  assert.ok(wrong.needMs > 6 * 60 * 60 * 1000 - 1);
  const right = wedgeIsCertain({
    queuedBytes: 8 * MEGABYTE,
    bytesPerSecond: 18 * MEGABYTE,
    flatForMs: 60_000
  });
  assert.equal(right.certain, true);
});
