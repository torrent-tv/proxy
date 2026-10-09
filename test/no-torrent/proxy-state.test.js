/**
 * @file What the proxy tells the server about itself is sent when it changes
 * (torrent-tv/meta#36).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { ProxyStateReporter } from "../../services/transport/proxy-state.js";

test("a change is described and sent; an unchanged description is not sent again", async () => {
  const sent = [];
  let load = 0.5;
  const reporter = new ProxyStateReporter({ describe: async () => ({ metrics: { cpuLoad: load }, holds: [] }), send: (state) => sent.push(state) });
  await reporter.changed();
  await reporter.changed();
  assert.equal(sent.length, 1);
  load = 0.7;
  await reporter.changed();
  assert.deepEqual(sent.map((state) => state.metrics.cpuLoad), [0.5, 0.7]);
});

test("changes during a description are joined into one more after it", async () => {
  const sent = [];
  let release;
  let described = 0;
  const reporter = new ProxyStateReporter({
    describe: () => { described += 1; return described === 1 ? new Promise((resolve) => { release = () => resolve({ n: 1 }); }) : { n: described }; },
    send: (state) => sent.push(state)
  });
  const first = reporter.changed();
  void reporter.changed();
  void reporter.changed();
  release();
  await first;
  assert.equal(described, 2);
  assert.deepEqual(sent, [{ n: 1 }, { n: 2 }]);
});

test("a new connection hears the state even when it has not changed, and a failed description sends nothing", async () => {
  const sent = [];
  let fail = false;
  const reporter = new ProxyStateReporter({
    describe: async () => { if (fail) throw new Error("worker gone"); return { holds: [] }; },
    send: (state) => sent.push(state)
  });
  await reporter.changed();
  await reporter.resend();
  assert.equal(sent.length, 2);
  fail = true;
  await reporter.changed();
  assert.equal(sent.length, 2);
});
