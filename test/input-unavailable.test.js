/**
 * @file Telling "the data is not here yet" from "this cannot be encoded".
 *
 * A run that dies because its input went away used to condemn the whole
 * session: state `failed`, and every request for the playlist answered 500
 * from then on. But the torrent can be added again and the pieces downloaded
 * again, so the data being gone is a wait, not a verdict — measured 2026-08-06,
 * a torrent evicted mid-seek killed a session whose swarm was right there and
 * whose data would have come back in seconds.
 *
 * The classification is what decides which of the two happened, so it is tested
 * on the exact messages the field produced.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { isInputUnavailable } from "../services/hls-session-manager.js";

test("the messages the field produced when data went away are all temporary", () => {
  for (const message of [
    "[http @ 0x7f99b19f00] Error reading HTTP response: End of file",
    "File 0 not found in torrent:17c46f5c36b94865858bfeaa412693c097328a50.",
    "File 5 not found in magnet:8d3b6c2e74df473e3649521f927ae33b20cd9e67.",
    "Unknown source 9711bbde2debdcd0d1fbd8cf88d68fd9612e5d31.",
    "[in#0/matroska,webm @ 0x7f9005f340] Read error at pos. 138556 (0x21d3c)",
    "Server returned 503 Service Unavailable",
    "Input/output error"
  ]) {
    assert.equal(isInputUnavailable(message), true, `should be retried: ${message}`);
  }
});

test("a real encoding failure is not mistaken for one", () => {
  for (const message of [
    "Cannot write moov atom before AC3 packets. Set the delay_moov flag to fix this.",
    "Could not write header (incorrect codec parameters ?): Invalid argument",
    "Unknown encoder 'h264_v4l2m2m'",
    "ffmpeg exited with code 1"
  ]) {
    assert.equal(isInputUnavailable(message), false, `should stay terminal: ${message}`);
  }
});

test("nothing at all is not a reason to retry for ever", () => {
  assert.equal(isInputUnavailable(""), false);
  assert.equal(isInputUnavailable(undefined), false);
  assert.equal(isInputUnavailable(null), false);
});
