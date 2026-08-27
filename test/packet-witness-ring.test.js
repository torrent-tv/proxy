import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  adoptOrphanRingFiles,
  createPacketWitness,
  WITNESS_RING_BASENAME
} from "../services/packet-witness.js";

/**
 * A stand-in for a spawned tcpdump: it records how it was called and stays
 * "running" until something kills it.
 */
class FakeChild extends EventEmitter {
  constructor(command, args) {
    super();
    this.command = command;
    this.args = args;
    this.killed = false;
    this.signals = [];
  }

  kill(signal) {
    this.signals.push(signal);
    if (!this.killed) {
      this.killed = true;
      // A real child exits asynchronously, which is what the code must wait for.
      setImmediate(() => this.emit("close", 0, signal));
    }
    return true;
  }
}

/**
 * @returns {{ spawnProcess: Function, children: FakeChild[], rings: FakeChild[] }}
 */
function makeSpawn() {
  const children = [];
  const spawnProcess = (command, args) => {
    const child = new FakeChild(command, args);
    children.push(child);
    if (args.includes("--version")) {
      // The availability probe: answer at once, like a present tcpdump.
      setImmediate(() => child.emit("spawn"));
    }
    return child;
  };
  return {
    spawnProcess,
    children,
    get rings() {
      return children.filter((child) => !child.args.includes("--version"));
    }
  };
}

/**
 * Wait until `check` holds, rather than for a chosen interval.
 *
 * A fixed sleep passes alone and fails in a full run — the defect roadmap item
 * 51 names — and the work here is several awaits deep (probe, stop, readdir,
 * copy, restart), so its duration is whatever the machine is busy with.
 *
 * @param {() => boolean | Promise<boolean>} check
 * @param {string} what
 * @returns {Promise<void>}
 */
async function waitFor(check, what) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (await check()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Let every already-queued microtask and immediate run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function withDir(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "witness-ring-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the ring runs while a channel is open and stops with the last one", async () => {
  await withDir(async (dir) => {
    const spawn = makeSpawn();
    const witness = createPacketWitness({
      log: () => {},
      dir,
      port: 9090,
      spawnProcess: spawn.spawnProcess
    });

    witness.holdRing();
    witness.holdRing();
    await waitFor(() => spawn.rings.length === 1, "the ring to start");
    assert.equal(spawn.rings.length, 1, "a second channel must not start a second ring");
    assert.equal(spawn.rings[0].killed, false);

    witness.releaseRing();
    await settle();
    assert.equal(spawn.rings[0].killed, false, "one channel left still wants the ring");

    witness.releaseRing();
    await waitFor(() => spawn.rings[0].killed, "the ring to stop");
  });
});

test("a channel that opens and closes while the ring is starting leaves nothing running", async () => {
  await withDir(async (dir) => {
    const spawn = makeSpawn();
    const witness = createPacketWitness({
      log: () => {},
      dir,
      port: 9090,
      spawnProcess: spawn.spawnProcess
    });
    // Release before the availability probe has resolved — the start is still
    // in flight. Without the second look after the await this leaves a tcpdump
    // nobody holds and nobody will ever stop.
    witness.holdRing();
    witness.releaseRing();
    await waitFor(
      () => spawn.rings.every((child) => child.killed),
      "any ring started mid-flight to be stopped"
    );
    const alive = spawn.rings.filter((child) => !child.killed);
    assert.deepEqual(alive, [], "no ring may outlive the channels that wanted it");
  });
});

test("the ring's files are removed once nobody is being served", async () => {
  await withDir(async (dir) => {
    const spawn = makeSpawn();
    const witness = createPacketWitness({
      log: () => {},
      dir,
      port: 9090,
      spawnProcess: spawn.spawnProcess
    });
    witness.holdRing();
    await waitFor(() => spawn.rings.length === 1, "the ring to start");
    await writeFile(path.join(dir, `${WITNESS_RING_BASENAME}0`), "pcap");
    witness.releaseRing();
    await waitFor(async () => (await readdir(dir)).length === 0, "the ring files to be removed");
  });
});

test("a wedge keeps the ring's history, and the ring keeps recording afterwards", async () => {
  await withDir(async (dir) => {
    const spawn = makeSpawn();
    const lines = [];
    const witness = createPacketWitness({
      log: (message) => lines.push(message),
      dir,
      port: 9090,
      spawnProcess: spawn.spawnProcess
    });
    witness.holdRing();
    await waitFor(() => spawn.rings.length === 1, "the ring to start");
    await writeFile(path.join(dir, `${WITNESS_RING_BASENAME}0`), "before-the-freeze");
    await writeFile(path.join(dir, `${WITNESS_RING_BASENAME}1`), "also-before");

    const started = witness.maybeCapture({
      sessionId: "68296f7d-0000-0000-0000-000000000000",
      tag: "68296f7d",
      label: "proxy",
      remote: { address: "2001:db8::1", port: 61649 },
      queuedBytes: 67_372_267,
      stuckForMs: 4000
    });
    assert.equal(started, true);
    await waitFor(
      async () => (await readdir(dir)).filter((name) => name.includes(".before")).length === 2,
      "both ring files to be copied aside"
    );

    const kept = (await readdir(dir)).filter((name) => name.includes(".before"));
    assert.equal(kept.length, 2, "both ring files must be kept, not just the finished one");
    assert.ok(kept.every((name) => name.startsWith("packet-witness.68296f7d.")));
    // Stopped to flush, then started again: two ring processes over the episode.
    await waitFor(() => spawn.rings.length >= 2, "the ring to resume after the copy");
    assert.equal(spawn.rings.at(-1).killed, false);
    assert.ok(lines.some((line) => line.includes("kept 2 ring file(s)")));

    // End the tail capture: it would otherwise sit out its whole window, and
    // its timer would hold this process open.
    for (const child of spawn.children) {
      child.kill("SIGTERM");
    }
    await settle();
  });
});

test("dispose stops the ring and clears its files", async () => {
  await withDir(async (dir) => {
    const spawn = makeSpawn();
    const witness = createPacketWitness({
      log: () => {},
      dir,
      port: 9090,
      spawnProcess: spawn.spawnProcess
    });
    witness.holdRing();
    await waitFor(() => spawn.rings.length === 1, "the ring to start");
    await writeFile(path.join(dir, `${WITNESS_RING_BASENAME}0`), "pcap");
    await witness.dispose();
    assert.equal(spawn.rings.at(-1).killed, true);
    assert.deepEqual(await readdir(dir), []);
  });
});

test("ring files left by a killed process are kept, not deleted by the next one", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, `${WITNESS_RING_BASENAME}0`), "the seconds before the crash");
    await writeFile(path.join(dir, `${WITNESS_RING_BASENAME}2`), "and these");
    const adopted = await adoptOrphanRingFiles(dir);
    assert.equal(adopted.length, 2);
    const left = await readdir(dir);
    assert.equal(left.filter((name) => name.startsWith(WITNESS_RING_BASENAME)).length, 0);
    assert.ok(left.every((name) => name.startsWith("packet-witness.orphan.")));
  });
});
