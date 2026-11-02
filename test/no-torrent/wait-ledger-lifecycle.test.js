import test from "node:test";
import assert from "node:assert/strict";
import { OutputLifecycle } from "../../services/server/OutputLifecycle.js";
import { OutputCatalog } from "../../services/encode/output/OutputCatalog.js";
import { WaitLedger } from "../../services/encode/OutputWaitLedger.js";

function lifecycleFor(outputs, ledger) {
  return new OutputLifecycle({
    outputs,
    invalidateWaits() {},
    outputTimes: { logIndexAccuracy() {} },
    viewers: {
      forOutput: () => new Map(),
      outputGone() {}
    },
    encodeRuns: {
      liveRunsOf: () => [],
      forgetEncodingOfGone() {}
    },
    clearWaits: () => ledger.clear()
  });
}

function catalogFor(ledger) {
  return new OutputCatalog({
    waitIdentityStarted: (key, identity) => ledger.open(key, identity),
    waitIdentityEnded: (key, identity) => ledger.forget(key, identity)
  });
}

test("disposing one output clears only its history while another stays live", async () => {
  const ledger = new WaitLedger();
  const outputs = catalogFor(ledger);
  const first = { id: "first", outputKey: "out:first" };
  const live = { id: "live", outputKey: "out:live" };
  outputs.set(first.id, first);
  outputs.set(live.id, live);
  const liveIdentity = outputs.waitIdentity(live.id);
  ledger.note("out:first", 70, 100, 100, outputs.waitIdentity(first.id));
  ledger.note("out:live", 35, 100, 100, liveIdentity);

  await lifecycleFor(outputs, ledger).disposeSession(first.id);

  assert.equal(ledger.describe("out:first"), null);
  assert.match(ledger.describe("out:live"), /now 1 wait\(s\) median 35ms/);
  assert.equal(ledger.size, 1);
});

test("repeated output lifetimes return retained histories to baseline", async () => {
  const ledger = new WaitLedger();
  const outputs = catalogFor(ledger);
  const lifecycle = lifecycleFor(outputs, ledger);
  for (let index = 0; index < 100; index += 1) {
    const output = { id: `output-${index}`, outputKey: `out:${index}` };
    outputs.set(output.id, output);
    ledger.note(output.outputKey, index, 100, 100, outputs.waitIdentity(output.id));
    await lifecycle.disposeSession(output.id);
  }
  assert.equal(ledger.size, 0);
  ledger.forget("unknown");
  ledger.forget("unknown");
  assert.equal(ledger.size, 0);
});

test("shutdown disposes live outputs and releases all ledger owners", async () => {
  const ledger = new WaitLedger();
  const outputs = catalogFor(ledger);
  outputs.set("one", { id: "one", outputKey: "out:one" });
  outputs.set("two", { id: "two", outputKey: "out:two" });
  ledger.note("out:one", 1, 1, 1, outputs.waitIdentity("one"));
  ledger.note("out:two", 2, 1, 1, outputs.waitIdentity("two"));
  const lifecycle = new OutputLifecycle({
    ...lifecycleHost(outputs, ledger),
    cleanupTimer: null,
    budgetTimer: null,
    segmentStore: { dropAll() {} }
  });

  await lifecycle.disposeAll();

  assert.equal(outputs.size, 0);
  assert.equal(ledger.size, 0);
});

function lifecycleHost(outputs, ledger) {
  return {
    outputs,
    invalidateWaits() {},
    outputTimes: { logIndexAccuracy() {} },
    viewers: { forOutput: () => new Map(), outputGone() {} },
    encodeRuns: { liveRunsOf: () => [], forgetEncodingOfGone() {} },
    clearWaits: () => ledger.clear()
  };
}
