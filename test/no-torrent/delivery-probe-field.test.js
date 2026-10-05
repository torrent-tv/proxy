import test from "node:test";
import assert from "node:assert/strict";

import { createDeliveryProbe, PROBE_INTERVAL_MS } from "../../services/transport/delivery-probe.js";

// The probe service run end to end, against channels that only record what is
// sent and a peer whose echoes this file writes. The shapes are the field's of
// 2026-09-28 (research/stalled-channel-recovery-2026-10-04.md in meta): two
// connections on one proxy, one healthy and idle, one wedged.

const LABELS = ["proxy", "proxy-control", "proxy-fast"];

/**
 * A connection with three channels and a peer that echoes on its own cadence.
 *
 * `peer.delivering` decides whether the probes reach the far end; while it is
 * false the far end goes on echoing — the reverse direction keeps working in a
 * wedge — but the newest number it has seen stays where it stopped.
 *
 * @param {import("node:test").TestContext} t
 * @param {{ rttMs?: number }} [options]
 */
function connection(t, { rttMs = 6 } = {}) {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  const lines = [];
  const captures = [];
  const probe = createDeliveryProbe({
    log: (line) => lines.push(line),
    readDelivery: () => ({ bytesPerSecond: 3_000_000, rttMs }),
    getTransportSnapshot: () => ({ remote: "peer" }),
    witness: {
      maybeCapture: (trigger) => {
        captures.push({ at: Date.now(), trigger });
        return true;
      }
    }
  });
  // The far end's own clock and how long a probe takes to become a fact there:
  // half the crossing, and the page handling the message. The page reports
  // when it saw each probe and when it sent the report, on its own clock — the
  // timestamps the verdict used to turn into a one-way delay.
  const PEER_CLOCK_OFFSET_MS = 37;
  const HANDLING_MS = 4;
  const peer = { delivering: true, seen: 0, seenAt: 0, channelBytes: 0, loopLagMs: 0, visibility: "visible" };
  const channels = LABELS.map((label) => ({
    label,
    sendMessage(message) {
      const { seq, sentAt } = JSON.parse(message);
      if (peer.delivering && seq > peer.seen) {
        peer.seen = seq;
        peer.seenAt = sentAt + rttMs / 2 + HANDLING_MS + PEER_CLOCK_OFFSET_MS;
      }
    },
    bufferedAmount: () => 0
  }));
  for (const channel of channels) {
    probe.attach("s1", "s1", channel.label, channel);
  }
  const echo = () =>
    probe.noteEcho("s1", {
      type: "probe-echo",
      seen: Object.fromEntries(LABELS.map((label) => [label, peer.seen])),
      seenAt: Object.fromEntries(LABELS.map((label) => [label, peer.seenAt])),
      sentAt: Date.now() + PEER_CLOCK_OFFSET_MS,
      report: {
        visibility: peer.visibility,
        loopLagMs: peer.loopLagMs,
        transportBytesReceived: peer.channelBytes,
        channels: Object.fromEntries(LABELS.map((label) => [label, { messages: 0, bytes: peer.channelBytes }])),
        pending: 0
      }
    });
  t.after(() => probe.dispose());
  return {
    peer,
    lines,
    captures,
    /**
     * Run the clock, echoing every `echoEveryMs` — composed just before the
     * probe of that instant arrives, which is the latest a healthy report can
     * be.
     */
    run(ms, echoEveryMs = PROBE_INTERVAL_MS) {
      for (let elapsed = 0; elapsed < ms; elapsed += echoEveryMs) {
        t.mock.timers.tick(echoEveryMs - 1);
        echo();
        t.mock.timers.tick(1);
      }
    },
    verdicts(fromMs = 0) {
      return lines
        .filter((line) => line.startsWith("[dc-probe]"))
        .map((line) => ({ verdict: line.split(" ")[2], at: Date.parse(line.match(/at=(\S+)/)[1]) }))
        .filter((entry) => entry.at >= fromMs);
    }
  };
}

test("an idle healthy connection is not called stopped (2026-09-28, 35cff221)", (t) => {
  // rtt 6 ms, every queue empty, nothing but probes crossing. The verdict that
  // compared a one-way delay of 6-54 ms with an allowance of 3 ms printed
  // `association-stopped` on this connection every five seconds.
  const link = connection(t);
  link.run(60_000);
  // From the first echo on: before it there is nothing to judge.
  const named = new Set(link.verdicts(PROBE_INTERVAL_MS).map((entry) => entry.verdict));
  assert.deepEqual([...named], ["flowing"], `every probe was delivered: ${link.lines.at(-1)}`);
  assert.equal(link.captures.length, 0);
});

test("a wedge is called stopped within seconds and reaches the witness (2026-09-28, 10b53a7e)", (t) => {
  // Probe 1464 was the last the peer saw; echoes went on arriving for the
  // whole minute. The old verdict read `flowing` on every line.
  const link = connection(t, { rttMs: 26 });
  link.run(30_000);
  const wedgedAt = Date.now();
  link.peer.delivering = false;
  link.run(30_000);
  const after = link.verdicts(wedgedAt);
  const firstStop = after.find((entry) => entry.verdict === "association-stopped");
  assert.ok(firstStop, `the wedge must be named: ${link.lines.at(-1)}`);
  assert.ok(firstStop.at - wedgedAt <= 2_000, `named ${firstStop.at - wedgedAt} ms after the last delivery`);
  assert.equal(after.at(-1).verdict, "association-stopped", "and it stays named while nothing arrives");
  assert.equal(link.captures.length, 1, "one capture per wedge");
  assert.ok(link.captures[0].at - wedgedAt <= 3_000, `captured ${link.captures[0].at - wedgedAt} ms in`);
});

test("delivery resuming clears the verdict and arms the next capture", (t) => {
  const link = connection(t);
  link.run(10_000);
  link.peer.delivering = false;
  link.run(10_000);
  assert.equal(link.captures.length, 1);
  const resumedAt = Date.now();
  link.peer.delivering = true;
  link.run(10_000);
  assert.equal(link.verdicts(resumedAt).at(-1).verdict, "flowing");
  link.peer.delivering = false;
  link.run(10_000);
  assert.equal(link.captures.length, 2, "a second wedge is a second capture");
});

test("a hidden tab answering late is read as flowing (field 2026-09-03 loop delays)", (t) => {
  // A hidden tab echoes about once a second and reports its own event loop as
  // late — 681 → 1881 ms in the field. Every probe still reaches it.
  const link = connection(t);
  link.run(10_000);
  link.peer.visibility = "hidden";
  link.peer.loopLagMs = 681;
  link.run(5_000, 1_000);
  link.peer.loopLagMs = 1881;
  const hiddenAt = Date.now();
  link.run(30_000, 2_000);
  const named = new Set(link.verdicts(hiddenAt).map((entry) => entry.verdict));
  assert.deepEqual([...named], ["flowing"], `every probe is delivered: ${link.lines.at(-1)}`);
});

test("late reports while film is still arriving are read as flowing", (t) => {
  // A hidden tab reports every three seconds and says beforehand that its loop
  // is that late; the far end's channel byte counter says film is crossing.
  const link = connection(t);
  link.run(10_000);
  link.peer.visibility = "hidden";
  link.peer.loopLagMs = 3_000;
  link.run(1_000);
  const lateAt = Date.now();
  for (let index = 0; index < 20; index += 1) {
    link.peer.channelBytes += 4_000_000;
    link.run(3_000, 3_000);
  }
  const named = new Set(link.verdicts(lateAt).map((entry) => entry.verdict));
  assert.deepEqual([...named], ["flowing"], `film is arriving: ${link.lines.at(-1)}`);
});
