/**
 * @file The wire format of a body frame.
 *
 * The browser parses these bytes, so the layout is a contract:
 * `[flags(1)][idLen(1)][requestId][payload]`. The framing was rewritten to stop
 * copying every chunk twice (75.9 ms per 13 MB segment against 40.0 on the
 * field host), and a rewrite of something a client parses needs the format
 * pinned down, not just the timing.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { encodeFrame } from "../services/data-channel-handler.js";

const requestId = Buffer.from("abc123", "ascii");

test("a body frame carries the id and the payload unchanged", () => {
  const payload = Buffer.from([1, 2, 3, 4, 250, 255]);
  const frame = encodeFrame(requestId, payload, false);

  assert.equal(frame[0], 0, "flagged as done");
  assert.equal(frame[1], requestId.length);
  assert.deepEqual(frame.subarray(2, 2 + requestId.length), requestId);
  assert.deepEqual(frame.subarray(2 + requestId.length), payload);
  assert.equal(frame.length, 2 + requestId.length + payload.length);
});

test("the done frame carries no payload", () => {
  const frame = encodeFrame(requestId, null, true);

  assert.equal(frame[0], 1);
  assert.equal(frame.length, 2 + requestId.length);
});

test("an empty payload is treated as no payload", () => {
  const frame = encodeFrame(requestId, new Uint8Array(0), false);
  assert.equal(frame.length, 2 + requestId.length);
});

test("a payload that is a view into a larger buffer is copied correctly", () => {
  // Chunks arrive as views into a bigger allocation, so copying the whole
  // underlying buffer instead of the view would send the wrong bytes at the
  // wrong length — silently.
  const backing = Buffer.alloc(64, 9);
  backing.fill(42, 16, 32);
  const view = new Uint8Array(backing.buffer, backing.byteOffset + 16, 16);

  const frame = encodeFrame(requestId, view, false);

  assert.equal(frame.length, 2 + requestId.length + 16);
  assert.deepEqual(frame.subarray(2 + requestId.length), Buffer.alloc(16, 42));
});

test("a large payload survives framing byte for byte", () => {
  const payload = Buffer.allocUnsafeSlow(64 * 1024);
  for (let at = 0; at < payload.length; at += 1) {
    payload[at] = at % 251;
  }

  const frame = encodeFrame(requestId, payload, false);

  assert.deepEqual(frame.subarray(2 + requestId.length), payload);
});
