/**
 * @file What an encoder is told to read.
 *
 * The encoder's own read of its source is the one read that tracks where the
 * viewer is (`reader=playback`), and the only one sized in seconds of playback
 * (`windowBytes`). Both travel on the input address. When the address stopped
 * being kept on the session and started being built per run, both were left
 * off it: every encoder read looked to the stream route like a probe, and the
 * read window fell back to the reader's default.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { encoderInputs } from "../../services/encode/run-inputs.js";

const BASE = "http://127.0.0.1:9090";

function file(fileIndex) {
  return {
    fileIndex,
    streamUrl(baseUrl, { sessionId = "" } = {}) {
      const url = new URL("/stream", `${baseUrl}/`);
      url.searchParams.set("fileIndex", String(fileIndex));
      if (sessionId) {
        url.searchParams.set("session", sessionId);
      }
      return url;
    }
  };
}

test("the picture's read says it is the playback read, with its window", () => {
  const picture = file(0);
  const { inputUrl } = encoderInputs({
    picture,
    soundtrack: picture,
    carries: "video-only",
    audioSeparate: true,
    sessionId: "aaaaaaaabbbbcccc",
    readWindowBytes: 32_000_000,
    baseUrl: BASE
  });
  const url = new URL(inputUrl);
  assert.equal(url.searchParams.get("reader"), "playback");
  assert.equal(url.searchParams.get("windowBytes"), "32000000");
  assert.equal(url.searchParams.get("session"), "aaaaaaaabbbbcccc");
});

test("with no window measured the read states neither parameter", () => {
  const picture = file(0);
  const { inputUrl } = encoderInputs({
    picture,
    soundtrack: picture,
    carries: "muxed",
    audioSeparate: false,
    sessionId: "aaaaaaaabbbbcccc",
    readWindowBytes: 0,
    baseUrl: BASE
  });
  const url = new URL(inputUrl);
  assert.equal(url.searchParams.get("windowBytes"), null);
  assert.equal(url.searchParams.get("reader"), null, "exactly as before: both are set together or neither");
});

test("a soundtrack in its own file is read directly by its rendition, and is a second input only when muxed", () => {
  const picture = file(0);
  const dub = file(3);
  const rendition = encoderInputs({
    picture, soundtrack: dub, carries: "audio-only", audioSeparate: true,
    sessionId: "s", readWindowBytes: 1000, baseUrl: BASE
  });
  assert.equal(new URL(rendition.inputUrl).searchParams.get("fileIndex"), "3");
  assert.equal(rendition.audioInputUrl, "");
  const muxed = encoderInputs({
    picture, soundtrack: dub, carries: "muxed", audioSeparate: false,
    sessionId: "s", readWindowBytes: 1000, baseUrl: BASE
  });
  assert.equal(new URL(muxed.inputUrl).searchParams.get("fileIndex"), "0");
  assert.equal(new URL(muxed.audioInputUrl).searchParams.get("fileIndex"), "3");
});
