/**
 * @file What every encoder kind must state about itself, and the properties of
 * its arguments that a field failure paid for.
 *
 * Deliberately NOT a transcription of the argument lists: a test written by
 * copying the code cannot fail when the code is wrong. What is stated here is
 * what must hold for ANY kind, including one added later, plus the two
 * kind-specific facts that were learned by running the thing on real hardware.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Encoder } from "../services/encode/Encoder.js";
import { NvencEncoder } from "../services/encode/NvencEncoder.js";
import { QsvEncoder } from "../services/encode/QsvEncoder.js";
import { SoftwareEncoder } from "../services/encode/SoftwareEncoder.js";
import { V4l2m2mEncoder } from "../services/encode/V4l2m2mEncoder.js";
import { VaapiEncoder } from "../services/encode/VaapiEncoder.js";

const KINDS = [
  new SoftwareEncoder(),
  new VaapiEncoder("/dev/dri/renderD128"),
  new QsvEncoder("/dev/dri/renderD128"),
  new NvencEncoder(),
  new V4l2m2mEncoder()
];

const BASE = { targetWidth: 1280, targetHeight: 720, segmentDurationSec: 4, fps: 24 };

test("a kind's arguments name the encoder the kind claims to be", () => {
  // The one thing that must never drift: a class called `h264_nvenc` that puts
  // `libx264` on the command line would be filed under an address promising
  // the other one's header.
  for (const encoder of KINDS) {
    const args = encoder.buildVideoArgs(BASE);
    const at = args.indexOf("-c:v");
    assert.notEqual(at, -1, `${encoder.name} names no video encoder`);
    assert.equal(args[at + 1], encoder.name, `${encoder.name} builds ${args[at + 1]}`);
  }
});

test("an explicit cut list is passed through exactly, by every kind", () => {
  // This is what makes a re-encoded step splice into a copied picture: it has
  // to be cut at the source's own keyframe times and nowhere else. A kind that
  // rounded them, or dropped them for its own even grid, would produce segments
  // that cannot stand where the copy's would.
  const times = [0, 4.271, 8.9, 13.04];
  for (const encoder of KINDS) {
    const args = encoder.buildVideoArgs({ ...BASE, forcedKeyframeTimes: times });
    const at = args.indexOf("-force_key_frames");
    assert.notEqual(at, -1, `${encoder.name} forces no keyframes`);
    assert.equal(args[at + 1], times.join(","), `${encoder.name} altered the cut list`);
  }
});

test("with no cut list, keyframes are still placed on the segment grid", () => {
  for (const encoder of KINDS) {
    const args = encoder.buildVideoArgs({ ...BASE, forcedKeyframeTimes: null });
    const joined = args.join(" ");
    // Either forced by time, or by a frame-count GOP — both put a keyframe on
    // every boundary, which is what makes a segment independently decodable.
    const byTime = joined.includes("-force_key_frames expr:gte(t,n_forced*4)");
    const byFrameCount = joined.includes(`-g ${4 * 24}`);
    assert.ok(byTime || byFrameCount, `${encoder.name} places keyframes by neither rule`);
  }
});

test("a target box of nothing still produces a usable size", () => {
  // The session manager passes 0 for "keep the source size"; a kind that let
  // that through would build `scale=0:0`.
  for (const encoder of KINDS) {
    const args = encoder.buildVideoArgs({ ...BASE, targetWidth: 0, targetHeight: 0 });
    assert.ok(!args.join(" ").includes("=0:"), `${encoder.name} scaled to zero`);
  }
});

test("every kind says what its speed setting is, or that it has none", () => {
  for (const encoder of KINDS) {
    const ladder = encoder.speedLadder;
    assert.equal(typeof ladder.note, "string");
    assert.ok(ladder.note.length > 0, `${encoder.name} explains nothing about its ladder`);
    assert.ok(Array.isArray(ladder.values));
    if (ladder.values.length > 0) {
      assert.ok(ladder.flag.length > 0, `${encoder.name} lists settings but names no option`);
    }
  }
});

test("only libx264 claims a measured ladder", () => {
  // The four hardware kinds have never been benchmarked across their settings,
  // and a ladder claiming to be measured is what would let something start
  // choosing from it.
  for (const encoder of KINDS) {
    assert.equal(
      encoder.speedLadder.measured,
      encoder.kind === "software",
      `${encoder.name} misreports whether its ladder was measured`
    );
  }
});

test("a kind that is not software is hardware, and says so", () => {
  for (const encoder of KINDS) {
    assert.equal(encoder.isHardware, encoder.kind !== "software");
  }
});

test("the encoder on an ARM board always asks for more capture buffers", () => {
  // The default of four deadlocks on the CM4 — "All capture buffers returned to
  // userspace" — so this is not a tuning choice but the condition under which
  // that encoder runs at all.
  const args = new V4l2m2mEncoder().buildVideoArgs(BASE);
  const at = args.indexOf("-num_capture_buffers");
  assert.notEqual(at, -1, "v4l2m2m was given the default buffer count");
  assert.ok(Number(args[at + 1]) > 4);
});

test("a kind that does not say how to build its arguments refuses rather than producing none", () => {
  class Unstated extends Encoder {}
  const encoder = new Unstated({ name: "h264_unstated", kind: "nvenc" });
  assert.throws(() => encoder.buildVideoArgs(BASE), /does not say how/);
});
