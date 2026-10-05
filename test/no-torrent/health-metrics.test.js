/**
 * @file What a proxy says about itself, and what the pool scores it on.
 */

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";

import { collectHealthMetrics } from "../../services/transport/health-collector.js";
import { availableMemory, availableMemoryBytes } from "../../services/storage/machine-memory.js";

test("free memory is what could be given out, not what is idle this instant", () => {
  const available = availableMemory();
  assert.ok(Number.isFinite(available.bytes) && available.bytes > 0);

  // On Linux this is the kernel's own `MemAvailable`, not `os.freemem()`: the
  // kernel keeps free memory low on purpose and fills the rest with cache, which
  // it hands back the moment anything asks. The old reading was `os.freemem()`,
  // so a host with 4 GB of cache and 200 MB genuinely free reported itself nearly
  // full while it had 4.2 GB to give — and that figure weighs 0.4 of every
  // proxy's score. Asked of the reading itself: comparing it with a second
  // reading taken a moment later measures whatever else the machine was doing.
  if (os.platform() === "linux") {
    assert.equal(available.measured, true, "the kernel's own estimate was not read");
  }
});

test("the health report is three bounded numbers", () => {
  const metrics = collectHealthMetrics({ availableMemoryBytes });
  assert.ok(metrics.cpuLoad >= 0);
  assert.ok(metrics.memFree > 0 && metrics.memFree <= 1);
  assert.ok(Number.isInteger(metrics.uptime) && metrics.uptime >= 0);
  // Three decimals, so a value that has not really moved does not produce a
  // different message on every poll.
  assert.equal(metrics.memFree, Math.round(metrics.memFree * 1000) / 1000);
});
