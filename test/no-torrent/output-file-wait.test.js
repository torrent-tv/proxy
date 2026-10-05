import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { waitForSessionFile, waitForRequestedFile } from "../../services/server/transcode-session-files.js";

function servingState() {
  const listeners = new Set();
  return {
    result: { kind: "warming-up" }, reads: 0, epoch: 0, wanted: true,
    seekEpoch() { return this.epoch; },
    requestStillWanted() { return this.wanted; },
    subscribeFileChange() {
      let wake;
      const changed = new Promise((resolve) => { wake = resolve; });
      listeners.add(wake);
      return { changed, release: () => listeners.delete(wake) };
    },
    async getFileStream() {
      assert.equal(listeners.size, 1, "subscribe before checking availability");
      this.reads += 1;
      return this.result;
    },
    change(result) { if (result) this.result = result; for (const wake of listeners) wake(); },
    get waiting() { return listeners.size; }
  };
}

for (const name of ["index.m3u8", "init.mp4", "segment-00001.mp4"]) {
  test(`${name} waits for a state change without polling or a hold deadline`, async () => {
    const serving = servingState();
    const pending = waitForSessionFile(serving, "output", name, { holdMs: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(serving.reads, 1);
    assert.equal(serving.waiting, 1);
    serving.change({ kind: "file", stream: "complete bytes" });
    assert.equal((await pending).stream, "complete bytes");
    assert.equal(serving.waiting, 0);
  });
}

test("publication during the first read is observed instead of being lost", async () => {
  const serving = servingState();
  const original = serving.getFileStream;
  serving.getFileStream = async function (...args) {
    const result = await original.apply(this, args);
    if (this.reads === 1) this.change({ kind: "file" });
    return result;
  };
  assert.equal((await waitForSessionFile(serving, "output", "init.mp4")).kind, "file");
  assert.equal(serving.reads, 2);
  assert.equal(serving.waiting, 0);
});

test("cancellation releases the subscription and cannot report warming or success", async () => {
  const serving = servingState();
  let cancel;
  const until = new Promise((resolve) => { cancel = resolve; });
  const pending = waitForSessionFile(serving, "output", "init.mp4", { until });
  cancel();
  assert.equal((await pending).kind, "cancelled");
  assert.equal(serving.waiting, 0);
});

test("terminal production failures wake the pending file request", async () => {
  const serving = servingState();
  const pending = waitForSessionFile(serving, "output", "init.mp4");
  await new Promise((resolve) => setImmediate(resolve));
  serving.change({ kind: "failed", message: "Damaged selected track." });
  assert.deepEqual(await pending, serving.result);
  assert.equal(serving.waiting, 0);
});

test("disconnecting a preparation request releases its wait and response listeners", async () => {
  const serving = servingState();
  const req = { raw: new EventEmitter() };
  const reply = { raw: new EventEmitter() };
  const pending = waitForRequestedFile(req, reply, serving, "output", "segment-00001.mp4", "viewer");
  await new Promise(resolve => setImmediate(resolve));
  reply.raw.emit("close");
  assert.equal((await pending).kind, "cancelled");
  assert.equal(serving.waiting, 0);
  assert.equal(req.raw.listenerCount("aborted"), 0);
  assert.equal(reply.raw.listenerCount("close"), 0);
});

test("a caller leaving during a completed file read releases that file", async () => {
  const req = { raw: new EventEmitter() };
  const reply = { raw: new EventEmitter() };
  const serving = servingState();
  let released = 0;
  serving.getFileStream = async () => {
    req.raw.emit("aborted");
    return { kind: "file", stream: { destroy() { released++; } } };
  };
  assert.equal((await waitForRequestedFile(req, reply, serving, "output", "init.mp4", "viewer")).kind, "cancelled");
  assert.equal(released, 1);
  assert.equal(serving.waiting, 0);
});
