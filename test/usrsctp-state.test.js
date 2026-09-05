/**
 * @file The usrsctp state reader's gating and command construction.
 *
 * Roadmap item 11: reads usrsctp's live association state via gdb the moment
 * a wedge is declared. Everything here is the part that decides WHEN and WITH
 * WHAT ARGUMENTS — the spawning itself is thin glue around these, the same
 * shape as the packet witness (test/packet-witness.test.js).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { createUsrsctpStateReader, SCTPSTATE_SCRIPT_PATH } from "../services/usrsctp-state.js";

class FakeChild extends EventEmitter {
  constructor(command, args) {
    super();
    this.command = command;
    this.args = args;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }

  kill() {
    // Not exercised by these tests — every fake run finishes on its own.
    return true;
  }
}

/**
 * @param {string} output - What the fake gdb writes to stdout before closing.
 * @returns {{ spawnProcess: Function, calls: Array<{ command: string, args: string[] }> }}
 */
function makeSpawn(output) {
  const calls = [];
  const spawnProcess = (command, args) => {
    calls.push({ command, args });
    const child = new FakeChild(command, args);
    setImmediate(() => {
      if (output) {
        child.stdout.emit("data", Buffer.from(output));
      }
      child.emit("close", 0);
    });
    return child;
  };
  return { spawnProcess, calls };
}

/** Wait until `check` holds, rather than for a chosen interval. */
async function waitFor(check) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    if (check()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the reading to be logged");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("the deadline is counted outside the process gdb stops", async () => {
  const { spawnProcess, calls } = makeSpawn("state=8 rwnd=95890\n");
  const lines = [];
  const reader = createUsrsctpStateReader({
    log: (message) => lines.push(message),
    spawnProcess,
    pid: 4242
  });
  const started = reader.maybeRead("test wedge");
  assert.equal(started, true);
  await waitFor(() => lines.length > 0);
  assert.equal(calls.length, 1);
  // `timeout` is a separate process, so it keeps counting while gdb holds every
  // thread of this one. A `setTimeout` here cannot fire — measured in the field
  // on 2026-09-05, where gdb held the proxy for four minutes and the guard set
  // for fifteen seconds never ran.
  assert.equal(calls[0].command, "timeout");
  assert.deepEqual(calls[0].args, [
    "-s",
    "KILL",
    "15",
    "gdb",
    "-q",
    "-batch",
    "-p",
    "4242",
    "-x",
    SCTPSTATE_SCRIPT_PATH
  ]);
  assert.match(lines[0], /state=8 rwnd=95890/);
  assert.match(lines[0], /test wedge/);
});

test("no output is reported as no reading, not silence", async () => {
  const { spawnProcess } = makeSpawn("");
  const lines = [];
  const reader = createUsrsctpStateReader({ log: (message) => lines.push(message), spawnProcess, pid: 1 });
  reader.maybeRead("empty case");
  await waitFor(() => lines.length > 0);
  assert.match(lines[0], /no reading/);
});

test("a second read is refused within the cooldown, like the packet witness", async () => {
  const { spawnProcess, calls } = makeSpawn("state=8\n");
  const lines = [];
  const reader = createUsrsctpStateReader({
    log: (message) => lines.push(message),
    spawnProcess,
    pid: 1,
    cooldownMs: 60_000
  });
  assert.equal(reader.maybeRead("first"), true);
  await waitFor(() => lines.length > 0);
  assert.equal(reader.maybeRead("second, too soon"), false);
  assert.equal(calls.length, 1);
});

test("a missing gdb is reported, not thrown", async () => {
  const lines = [];
  const spawnProcess = () => {
    throw new Error("spawn gdb ENOENT");
  };
  const reader = createUsrsctpStateReader({ log: (message) => lines.push(message), spawnProcess, pid: 1 });
  reader.maybeRead("no gdb on this host");
  await waitFor(() => lines.length > 0);
  assert.match(lines[0], /could not start gdb/);
});
