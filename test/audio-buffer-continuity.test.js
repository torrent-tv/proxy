import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readPresentationRanges, translatePresentationRanges, walkBoxes } from "../services/encode/segment-formats/mp4-boxes.js";
import { predictPlaybackReadiness } from "../services/server/playback-readiness.js";

const evidence = JSON.parse(readFileSync(new URL("./fixtures/audio-frame-boundary.json", import.meta.url), "utf8"));
const header = Buffer.from(evidence.files["init.mp4"], "base64");

function ranges(name, shiftedFrames = 0) {
  const bytes = Buffer.from(evidence.files[name], "base64");
  let frameTicks;
  walkBoxes(bytes, (type, start) => {
    if (type === "tfhd") {
      const flags = bytes.readUIntBE(start + 1, 3);
      const at = start + 8 + ((flags & 1) ? 8 : 0) + ((flags & 2) ? 4 : 0);
      if (flags & 8) frameTicks = bytes.readUInt32BE(at);
    }
    if (type === "tfdt" && shiftedFrames) {
      assert.ok(frameTicks > 0);
      bytes.writeBigUInt64BE(bytes.readBigUInt64BE(start + 4) + BigInt(frameTicks * shiftedFrames), start + 4);
    }
  });
  return translatePresentationRanges(readPresentationRanges(Buffer.concat([header, bytes])), header, 0);
}

function state(second = ranges("segment-00172.mp4")) {
  const first = ranges("segment-00171.mp4");
  const now = 1000;
  return {
    now,
    positionSeconds: first[0].start,
    durationSeconds: second.at(-1).end,
    bufferLimitSeconds: second.at(-1).end - first[0].start,
    reserveSeconds: 0,
    lookaheadSeconds: second.at(-1).end - first[0].start,
    sources: [{ id: "source", complete: true }],
    linkReadings: [{ at: now, value: 1_000_000 }],
    tracks: [{
      id: "audio", sourceIds: ["source"], clientRanges: [
        { start: evidence.browserBufferedRanges[0][0], end: evidence.browserBufferedRanges[0][1] }
      ],
      readings: [{ at: now, value: 1 }],
      readySegmentIndices: [0, 1], segmentSizesBytes: { 0: 170000, 1: 170000 },
      segments: [
        { index: 0, startSeconds: first[0].start, endSeconds: second[0].start, mediaRanges: first },
        { index: 1, startSeconds: second[0].start, endSeconds: second.at(-1).end, mediaRanges: second }
      ]
    }]
  };
}

test("captured AAC boundary agrees with Chrome's continuous buffered range", () => {
  const input = state();
  assert.equal(predictPlaybackReadiness(input).ready, true);
  for (const segment of input.tracks[0].segments) {
    segment.mediaRanges = segment.mediaRanges.map(({ start, end }) => ({ start, end }));
  }
  assert.equal(predictPlaybackReadiness(input).reason, "no-safe-start-found");
});

test("four missing AAC frames preserve the discontinuity observed in Chrome", () => {
  assert.equal(predictPlaybackReadiness(state(ranges("segment-00172.mp4", 4))).reason, "no-safe-start-found");
});

test("a join boundary never supplies audio before the adjacent segment arrives", () => {
  const input = state();
  input.linkReadings[0].value = 1;
  assert.notEqual(predictPlaybackReadiness(input).ready, true);
});
