/**
 * @file A run starts once what FFmpeg opens with is copied, and copies nobody
 * places a run for go back (torrent-tv/meta#178).
 *
 * Field 2026-10-12, a seek back on an AVI: the encoder was started only after
 * its whole input, 126.5 MB, had been copied in 16.3 s, beside a copy for the
 * position the viewer had left, and the picture stood 33 s. What is checked:
 * the answer comes before the stretch of film is copied, a read inside the
 * stretch waits for it, a released input drops its stretch, a stretch that
 * cannot be copied fails the read waiting for it, and an input
 * prepared or held for a start the plan does not place is withdrawn. Storage
 * is a fake; nothing here reaches a torrent.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { admitOriginalInput } from "../../services/encode/OriginalInput.js";
import { EncodeInputs } from "../../services/encode/EncodeInputs.js";
import { handleEncodeInputGet } from "../../routes/encode-input/get.js";

// A file of 400 bytes whose byte n is n % 251; a header of ten bytes at 0 and
// a stretch of film of 300 bytes at 100.
const FILE = Buffer.from(Array.from({ length: 400 }, (_, index) => index % 251));
const sources = [{ sourceKey: "film", fileIndex: 0, timeShiftSeconds: 0,
  input: { original: true, fileLength: FILE.length, ranges: [[0, 9], [100, 399]], selections: [] } }];

/** A reader whose answers wait until the check lets each one go. */
function gatedReader({ refuseAt = null } = {}) {
  const asked = [];
  const waiting = [];
  const readRanges = (_source, list) => {
    asked.push(list.map(range => [...range]));
    return new Promise(resolve => waiting.push(() =>
      resolve(list.some(([start]) => start === refuseAt) ? null : list.map(([start, end]) => FILE.subarray(start, end + 1)))));
  };
  const next = async () => {
    while (waiting.length === 0) await setImmediate();
    waiting.shift()();
    await setImmediate();
  };
  return { asked, readRanges, next };
}

test("the input is answered once the header is copied, and a read in the stretch waits for the stretch", async () => {
  const reader = gatedReader();
  const admitting = admitOriginalInput({ sources, reserve: async () => () => {}, readRanges: reader.readRanges });
  await reader.next();
  const input = await admitting;
  assert.deepEqual(reader.asked, [[[0, 9]], [[100, 399]]],
    "the answer comes once the header is copied, with the stretch asked for in one read and not yet copied");
  assert.equal(input.deferredBytes, 300);
  assert.deepEqual([...input.read(0, 2, 5).bytes], [...FILE.subarray(2, 6)], "the header is read at once");
  assert.equal(input.waitedBefore(Date.now()), 0, "a read of the header waited for nothing");
  let answered = null;
  const reading = Promise.resolve(input.read(0, 150, 160, true)).then(answer => { answered = answer; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(answered, null, "the stretch is not copied yet: the read waits");
  await reader.next();
  await reading;
  assert.ok(input.waitedBefore(Date.now()) >= 19, "and the wait is recorded, so a run's open can leave it out");
  assert.deepEqual([...answered.bytes], [...FILE.subarray(150, 161)], "the bytes asked for, from the copied stretch");
  assert.equal(await input.whole, true);
  assert.equal(reader.asked.length, 2, "one read for the header, one for the stretch");
  input.release();
});

test("a released input drops its stretch when the read of it returns", async () => {
  const reader = gatedReader();
  const admitting = admitOriginalInput({ sources, reserve: async () => () => {}, readRanges: reader.readRanges });
  await reader.next();
  const input = await admitting;
  const waiting = input.read(0, 120, 130, true);
  input.release();
  await reader.next();
  assert.equal(await waiting, null, "a read waiting on a released input is refused");
  assert.equal(await input.whole, false);
  assert.equal(input.copyFailed(), false, "a release is not a failed copy");
  assert.equal(reader.asked.length, 2, "nothing more is asked for");
});

test("a stretch that cannot be copied fails the read waiting for it, and the route says so", async () => {
  const reader = gatedReader({ refuseAt: 100 });
  const admitting = admitOriginalInput({ sources, reserve: async () => () => {}, readRanges: reader.readRanges });
  await reader.next();
  const input = await admitting;
  const req = { raw: { socket: { remoteAddress: "127.0.0.1" } }, method: "GET",
    params: { token: "1", fileIndex: "0" }, headers: { range: "bytes=250-" } };
  const reply = { status: 200, headers: {}, code(status) { this.status = status; return this; },
    header(name, value) { this.headers[name] = value; return this; }, send(body) { this.body = body; return this; } };
  const answering = handleEncodeInputGet(req, reply, { inputOf: () => input, refused: () => assert.fail("not a byte outside the input") });
  await reader.next();
  const answered = await answering;
  assert.equal(answered.status, 503);
  assert.match(answered.body.error, /could not be copied/);
  assert.equal(input.copyFailed(), true);
  assert.equal(await input.whole, false);
  input.release();
});

const packetSource = { sourceKey: "source", fileIndex: 0, input: { ranges: [[0, 1]], tracks: [{
  track: { type: "video", codecId: "vp8", width: 64, height: 64 },
  packets: [{ pts: 0, duration: 1, keyframe: true, ranges: [[0, 1]] }]
}] } };
const output = { id: "output" };

test("an input being prepared for a start the plan does not place is withdrawn, and one it places is kept", async () => {
  let settle, changed = 0;
  const lines = [];
  const inputs = new EncodeInputs({ resolve: async () => ({ kind: "result", sources: [packetSource] }),
    readRanges: () => new Promise(resolve => { settle = resolve; }), reviseBudget: async () => inputs.allow(100),
    changed: () => changed++, failed: error => { throw error; }, log: line => lines.push(line) });
  inputs.take(output, 7, 7);
  await setImmediate();
  inputs.withdrawUnplaced(output, new Set([7]));
  assert.equal(inputs.held(), 2, "a start the plan places keeps its copy");
  inputs.withdrawUnplaced(output, new Set([30, 29]));
  assert.ok(lines.some(line => line.includes("withdrawn: the plan places no run there")));
  settle([Buffer.from("ab")]);
  await setImmediate();
  assert.equal(inputs.held(), 0, "the copy that finished after it was withdrawn gives its memory back");
  assert.equal(changed, 0, "and is not announced as ready");
});

test("an input held for a start the plan does not place goes back", async () => {
  const inputs = new EncodeInputs({ resolve: async () => ({ kind: "result", sources: [packetSource] }),
    readRanges: async () => [Buffer.from("ab")], reviseBudget: async () => inputs.allow(100),
    changed: () => {}, failed: error => { throw error; } });
  inputs.take(output, 7, 7);
  await setImmediate();
  await setImmediate();
  assert.equal(inputs.held(), 2);
  inputs.withdrawUnplaced(output, new Set([30]));
  assert.equal(inputs.held(), 0);
  assert.equal(inputs.take(output, 7, 7), null, "taken again, it is prepared afresh");
  inputs.forget(output);
});

test("an input whose stretch is not all downloaded waits for the bytes instead of starting a run", async () => {
  // Field 2026-10-12, a cold MKV: the first piece was answered once its header
  // was copied, the read of its stretch found pieces missing, and the run was
  // refused for good. The answer waits for every byte, as one read used to.
  let downloaded = [[0, 9]];
  const lines = [];
  const inputs = new EncodeInputs({ resolve: async () => ({ kind: "result", sources }),
    heldRanges: async () => downloaded,
    readRanges: async (_source, list) => list.map(([start, end]) => FILE.subarray(start, end + 1)),
    reviseBudget: async () => inputs.allow(1000), changed: () => {}, failed: error => { throw error; },
    log: line => lines.push(line) });
  assert.equal(inputs.take(output, 0, 0), null);
  for (let turn = 0; turn < 5; turn++) await setImmediate();
  assert.ok(lines.some(line => line.includes("needs-bytes")), "it waits for the bytes");
  assert.equal(inputs.take(output, 0, 0), null, "and answers nothing meanwhile");
  downloaded = [[0, 9], [100, 399]];
  inputs.bytesChanged();
  for (let turn = 0; turn < 5; turn++) await setImmediate();
  const ready = inputs.take(output, 0, 0);
  assert.equal(ready?.kind, "result", "once they are here it is answered");
  ready.release();
});

test("a stretch copied whole is told about while its bytes are held, so a soundtrack can be walked from it", async () => {
  // r61 (torrent-tv/meta#178): the soundtrack walked the clusters the
  // picture's input had already copied, a second time through the torrent thread.
  const told = [];
  const inputs = new EncodeInputs({ resolve: async () => ({ kind: "result", sources }),
    readRanges: async (_source, list) => list.map(([start, end]) => FILE.subarray(start, end + 1)),
    reviseBudget: async () => inputs.allow(1000), changed: () => {}, failed: error => { throw error; },
    stretchCopied: (copiedFor, from, to, input) => told.push({ copiedFor, from, to, bytes: [...input.read(0, 200, 203).bytes] }) });
  inputs.take(output, 3, 3);
  for (let turn = 0; turn < 8; turn++) await setImmediate();
  const ready = inputs.take(output, 3, 3);
  assert.equal(ready?.kind, "result");
  assert.deepEqual(told, [{ copiedFor: output, from: 3, to: 3, bytes: [...FILE.subarray(200, 204)] }],
    "told once, with the stretch readable");
  ready.release();
});

test("a stretch released before it is copied is not told about", async () => {
  const told = [];
  let settle = null;
  const inputs = new EncodeInputs({ resolve: async () => ({ kind: "result", sources }),
    readRanges: async (_source, list) => list.length === 1 && list[0][0] === 100
      ? new Promise(resolve => { settle = () => resolve(list.map(([start, end]) => FILE.subarray(start, end + 1))); })
      : list.map(([start, end]) => FILE.subarray(start, end + 1)),
    reviseBudget: async () => inputs.allow(1000), changed: () => {}, failed: error => { throw error; },
    stretchCopied: () => told.push(true) });
  inputs.take(output, 3, 3);
  for (let turn = 0; turn < 8; turn++) await setImmediate();
  const ready = inputs.take(output, 3, 3);
  assert.equal(ready?.kind, "result");
  ready.release();
  settle();
  for (let turn = 0; turn < 4; turn++) await setImmediate();
  assert.deepEqual(told, []);
});
