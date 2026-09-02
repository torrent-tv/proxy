/**
 * @file What a proxy says about itself, and what the pool scores it on.
 */

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";

import { availableMemoryBytes, collectHealthMetrics } from "../services/health-collector.js";

test("free memory is what could be given out, not what is idle this instant", () => {
  const available = availableMemoryBytes();
  assert.ok(Number.isFinite(available) && available > 0);

  // On Linux this reads the kernel's own `MemAvailable`, and it is at least
  // `os.freemem()` by construction: the kernel keeps free memory low on purpose
  // and fills the rest with cache, which it hands back the moment anything
  // asks. The old reading was `os.freemem()`, so a host with 4 GB of cache and
  // 200 MB genuinely free reported itself nearly full while it had 4.2 GB to
  // give — and that figure weighs 0.4 of every proxy's score.
  if (os.platform() === "linux") {
    assert.ok(
      available >= os.freemem(),
      `MemAvailable ${available} is below freemem ${os.freemem()}, which cannot be`
    );
  }
});

test("the health report is three bounded numbers", () => {
  const metrics = collectHealthMetrics();
  assert.ok(metrics.cpuLoad >= 0);
  assert.ok(metrics.memFree > 0 && metrics.memFree <= 1);
  assert.ok(Number.isInteger(metrics.uptime) && metrics.uptime >= 0);
  // Three decimals, so a value that has not really moved does not produce a
  // different message on every poll.
  assert.equal(metrics.memFree, Math.round(metrics.memFree * 1000) / 1000);
});
