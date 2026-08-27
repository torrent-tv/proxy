/**
 * @file The packet witness's gating rules and command construction.
 *
 * Roadmap item 10: a send queue wedged longer than ~30 s must start a bounded
 * tcpdump on its own, because the 2026-08-24 episode proved no counter above
 * the wire can name the cause. Everything here is the part that decides WHEN
 * and WITH WHAT ARGUMENTS — the spawning itself is thin glue around these.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTcpdumpArgs,
  createPacketWitness,
  isWitnessCapture,
  isWitnessRingFile,
  normalizeRemoteAddress,
  shouldStartCapture,
  WITNESS_RING_FILE_MB,
  WITNESS_RING_FILES,
  WITNESS_RTO_CEILING_SECONDS,
  WITNESS_TAIL_SECONDS
} from "../services/packet-witness.js";

test("an IPv4 literal survives unchanged", () => {
  assert.equal(normalizeRemoteAddress("192.168.178.57"), "192.168.178.57");
});

test("an IPv6 literal survives unchanged", () => {
  assert.equal(
    normalizeRemoteAddress("2001:1c00:a603:2100:a129:a1a1:7f07:3f0b"),
    "2001:1c00:a603:2100:a129:a1a1:7f07:3f0b"
  );
});

test("a zone suffix is stripped", () => {
  assert.equal(normalizeRemoteAddress("fe80::2aca:8001:3ba6:f16f%18"), "fe80::2aca:8001:3ba6:f16f");
});

test("hostnames, garbage and shell text are rejected", () => {
  assert.equal(normalizeRemoteAddress("homeassistant.local"), null);
  assert.equal(normalizeRemoteAddress("8.8.8.8; rm -rf /"), null);
  assert.equal(normalizeRemoteAddress("999.1.1.1"), null);
  assert.equal(normalizeRemoteAddress(""), null);
  assert.equal(normalizeRemoteAddress(undefined), null);
  assert.equal(normalizeRemoteAddress(42), null);
});

test("the tcpdump command line is bounded and filtered to one peer", () => {
  const args = buildTcpdumpArgs({
    host: "2001:db8::1",
    port: 9090,
    filePrefix: "/data/packet-witness.e2b5ef39.1787600000.pcap"
  });
  assert.deepEqual(args, [
    "-n",
    "-S",
    "-s",
    "128",
    "-i",
    "any",
    "-w",
    "/data/packet-witness.e2b5ef39.1787600000.pcap",
    "-C",
    String(WITNESS_RING_FILE_MB),
    "-W",
    String(WITNESS_RING_FILES),
    "udp",
    "and",
    "port",
    "9090",
    "and",
    "host",
    "2001:db8::1"
  ]);
});

test("rotation is by size, so the ring files cannot collapse onto one name", () => {
  // `-G` with a name carrying no strftime field overwrote a single file, which
  // is why both field captures held 28 s instead of the intended 120.
  const args = buildTcpdumpArgs({ port: 9090, filePrefix: "/data/ring.pcap" });
  assert.equal(args.includes("-G"), false);
  assert.equal(args[args.indexOf("-C") + 1], String(WITNESS_RING_FILE_MB));
});

test("with no peer named the ring records every peer on the port", () => {
  const args = buildTcpdumpArgs({ port: 9090, filePrefix: "/data/ring.pcap" });
  assert.equal(args.includes("host"), false);
  assert.deepEqual(args.slice(-4), ["udp", "and", "port", "9090"]);
});

test("the tail outlasts three retransmission timeouts", () => {
  assert.equal(WITNESS_TAIL_SECONDS, WITNESS_RTO_CEILING_SECONDS * 3);
  // A zero-window probe is due once per timeout, so a window shorter than the
  // ceiling could not tell silence from a probe that had not come round yet.
  assert.ok(WITNESS_TAIL_SECONDS > WITNESS_RTO_CEILING_SECONDS);
});

test("ring files are told apart from the copies kept as evidence", () => {
  assert.equal(isWitnessRingFile("packet-witness-ring.pcap"), true);
  assert.equal(isWitnessRingFile("packet-witness-ring.pcap3"), true);
  assert.equal(isWitnessRingFile("packet-witness.e2b5ef39.1787600000.before1.pcap"), false);
  assert.equal(isWitnessCapture("packet-witness-ring.pcap3"), false);
  assert.equal(isWitnessCapture("packet-witness.e2b5ef39.1787600000.before1.pcap"), true);
  assert.equal(isWitnessCapture("packet-witness.e2b5ef39.1787600000.tail.pcap1"), true);
});

test("one capture runs at a time", () => {
  assert.equal(shouldStartCapture({ running: true, lastStartedAt: Date.now() }), false);
});

test("the first capture of a process is always allowed", () => {
  assert.equal(shouldStartCapture({ running: false, lastStartedAt: 0, now: 1000 }), true);
});

test("a capture within the cooldown is refused, one after it is allowed", () => {
  const state = { running: false, lastStartedAt: 10_000 };
  assert.equal(shouldStartCapture({ ...state, now: 10_000 + 599_999 }), false);
  assert.equal(shouldStartCapture({ ...state, now: 10_000 + 600_000 }), true);
});

test("capture files are recognised by name, rotations included", () => {
  assert.equal(isWitnessCapture("packet-witness.e2b5ef39.1787600000.pcap"), true);
  assert.equal(isWitnessCapture("packet-witness.e2b5ef39.1787600000.pcap20260825T120000"), true);
  assert.equal(isWitnessCapture("core.WorkerThread.81.1787600000"), false);
  assert.equal(isWitnessCapture("proxy.log"), false);
  assert.equal(isWitnessCapture("../packet-witness.x.pcap"), false);
});

test("a trigger without a usable remote endpoint is refused without touching anything", () => {
  const lines = [];
  const witness = createPacketWitness({
    log: (message) => lines.push(message),
    dir: "",
    port: 9090
  });
  const started = witness.maybeCapture({
    sessionId: "e2b5ef39-0000",
    tag: "e2b5ef39",
    label: "proxy",
    remote: null,
    queuedBytes: 160_000_000,
    stuckForMs: 31_000
  });
  assert.equal(started, false);
  assert.deepEqual(lines, []);
});
