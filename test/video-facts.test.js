/**
 * @file The picture's facts, from the two readings that state them.
 *
 * Audio and subtitles have had this reconciliation since their flags were first
 * read from the file. Video never did: every figure the encode is planned from
 * came from ffmpeg's `-i` banner alone, and the `VideoTrack` the container
 * declares was read and then used for nothing but a line in the log — so a file
 * that states its bit depth or its HDR signalling, against a probe that does
 * not print them, disagreed with nobody watching.
 *
 * What each check pins is WHICH reading answers, and why: the size and the
 * frame rate are what the decoder will produce, so the probe answers; the bit
 * depth and the HDR signalling are the file saying how its samples are to be
 * read, so the container answers.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { Container } from "../services/container/Container.js";

const banner = (fields) => ({ width: null, height: null, fps: null, isHdr: false, bitDepth: null, ...fields });

test("with no container reading the probe answers for everything", () => {
  const facts = Container.mergeVideoFacts(
    banner({ width: 1920, height: 1080, fps: 23.976, isHdr: true, bitDepth: 10 }),
    null
  );
  assert.equal(facts.width, 1920);
  assert.equal(facts.height, 1080);
  assert.equal(facts.fps, 23.976);
  assert.equal(facts.isHdr, true);
  assert.equal(facts.bitDepth, 10);
  assert.deepEqual(facts.disagreements, []);
});

test("the size and the frame rate are the probe's, because that is what will be decoded", () => {
  const facts = Container.mergeVideoFacts(
    banner({ width: 1920, height: 1080, fps: 24 }),
    { width: 1440, height: 1080, fps: 25, displayWidth: 1920, displayHeight: 1080 }
  );
  assert.equal(facts.width, 1920, "the ladder and the scale filter are sized to the decoded frame");
  assert.equal(facts.height, 1080);
  assert.equal(facts.fps, 24);
});

test("the bit depth and the HDR signalling are the file's, because the file states them", () => {
  // A ten-bit HEVC whose probe printed neither: this is the case that decides
  // whether tone mapping runs and how the decode cost is priced.
  const facts = Container.mergeVideoFacts(
    banner({ width: 3840, height: 2160, fps: 24 }),
    { width: 3840, height: 2160, bitDepth: 10, isHdr: true }
  );
  assert.equal(facts.bitDepth, 10);
  assert.equal(facts.isHdr, true);
  assert.deepEqual(facts.disagreements, [], "one side saying nothing is not a disagreement");
});

test("a field only the probe states is still answered", () => {
  const facts = Container.mergeVideoFacts(
    banner({ width: 1280, height: 720, fps: 30, bitDepth: 8 }),
    { width: null, height: null, fps: null, bitDepth: null }
  );
  assert.equal(facts.width, 1280);
  assert.equal(facts.bitDepth, 8);
});

test("a real disagreement is reported, with both values and which is which", () => {
  const facts = Container.mergeVideoFacts(
    banner({ width: 1920, height: 1080, bitDepth: 8, isHdr: false }),
    { width: 1280, height: 720, bitDepth: 10, isHdr: true }
  );
  assert.equal(facts.disagreements.length, 3);
  assert.ok(facts.disagreements.some((line) => /width 1280 in the container against 1920 in the probe/.test(line)));
  assert.ok(facts.disagreements.some((line) => /bit depth 10 in the container against 8 in the probe/.test(line)));
  // HDR is not among them, and cannot be: see `mergeVideoFacts`.
  assert.ok(!facts.disagreements.some((line) => /HDR/.test(line)));
  // And the rule still decides: the probe for the size, the file for the rest.
  assert.equal(facts.width, 1920);
  assert.equal(facts.bitDepth, 10);
  assert.equal(facts.isHdr, true);
});

test("the display size is the container's alone — the probe has no such field", () => {
  const facts = Container.mergeVideoFacts(
    banner({ width: 1440, height: 1080 }),
    { width: 1440, height: 1080, displayWidth: 1920, displayHeight: 1080 }
  );
  assert.equal(facts.displayWidth, 1920);
  assert.equal(facts.displayHeight, 1080);
});

test("zero and nonsense are not values", () => {
  const facts = Container.mergeVideoFacts(
    banner({ width: 0, height: 0, fps: 0, bitDepth: 0 }),
    { width: 1920, height: 1080, fps: 24, bitDepth: 8 }
  );
  assert.equal(facts.width, 1920, "a probe that printed nothing does not outrank a file that speaks");
  assert.equal(facts.fps, 24);
  assert.equal(facts.bitDepth, 8);
  assert.deepEqual(facts.disagreements, []);
});
