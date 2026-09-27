/**
 * @file Letting go of a step must ask who is on it, at the moment of letting go.
 *
 * Two disposals in the step path reasoned "nobody is on it yet", and neither
 * could know it. An output is addressed by what it PRODUCES, so opening one
 * hands back the output that already makes that picture whenever there is one —
 * which may be a step another viewer has been watching all along. And a
 * genuinely new one is only nobody's until something else reaches it: making a
 * step takes a probe and a keyframe index, seconds in which a second viewer can
 * ask for the same height and be registered onto it.
 *
 * Both are the same fault, so both are one question asked of the registry now.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Renditions } from "../services/encode/Renditions.js";
import { Viewers } from "../services/viewer/Viewers.js";
import {
  chooseOutput,
  chosenOutputOf,
  noteServingVerdict,
  audioBeingWarmedOf,
  audioChoiceOf,
  chooseAudioTrack,
  consumersOn,
  linkMbpsOf,
  noteAudioBeingWarmed,
  noteStepBeingWarmed,
  noteStepOnScreen,
  placeOn,
  presentOn,
  qualityModeOf,
  stepBeingWarmedOf,
  stepOnScreenOf,
  watches
} from "../services/viewer/choices.js";
import { SourceFile } from "../services/media/SourceFile.js";

const BASE_ID = "4444444455556666";
const STEP_ID = "5555555566667777";

/**
 * A picture with one step of 720p, and whatever `createOrGetSession` is told to
 * hand back for the next request.
 *
 * @param {{ handBack: (() => object) | null, baseIsLive?: boolean, stepProducedHeight?: number }} how
 */
function renditionsOver(how) {
  const file = new SourceFile({ sourceKey: "source-1", fileIndex: 0, name: "video.mkv" });
  // THE SAME MATERIAL, stated in full, because that is what the rule compares:
  // the source, the container, the cut grid, what the output carries and which
  // tracks. Two outputs of one picture differ in SIZE and in nothing else, and
  // a stub that leaves those fields out is not a picture with two rungs — it is
  // two outputs the rule cannot recognise as related.
  const material = () => ({
    transcodesAudio: false,
    sourceKey: "source-1",
    segmentFormatId: "fmp4",
    grid: { toKey: () => "kf@0:100" },
    carries: "video-only",
    video: { fileIndex: 0 },
    audio: null
  });
  const base = { id: BASE_ID, outputKey: "letting-go:base", file, spec: material(), timeline: { cutGrid: "uniform" }, segmentFormat: { id: "fmp4" } };
  const step = { id: STEP_ID, outputKey: "letting-go:step", file, spec: material(), timeline: { cutGrid: "uniform" }, segmentFormat: { id: "fmp4" } };
  const viewers = new Viewers();
  const disposed = [];
  const lines = [];
  const outputs = {
    get: (id) => (id === BASE_ID ? base : id === STEP_ID ? step : null),
    touch: () => {},
    markStep: () => {},
    stepsOf: () => [step],
    splicableHeights: () => [1080, 720],
    // The step is NAMED 540 and may PRODUCE something else: an output answers
    // for the picture it makes, not for the number in its name.
    variantHeightOf: (output) => (output === base ? 1080 : 540),
    // What each actually makes. The picture itself is a rung like any other,
    // and when it is a re-encode a step can land on exactly its size — which is
    // the case the adoption below exists for.
    producedHeightOf: (output) => (output === base ? (how.baseProducedHeight ?? 1080) : (how.stepProducedHeight ?? 540)),
    values: () => [base, step]
  };
  const renditions = new Renditions({
    outputs,
    viewerCountOn: (output) => viewers.forOutput(output).size,
    outputStillNeeded: (output) => viewers.stillNeeded(output),
    consumersOn: (output) => consumersOn(viewers, output),
    presentOn: (output) => presentOn(viewers, output),
    qualityModeOf: (output, consumerId) => qualityModeOf(viewers, output, consumerId),
    linkMbpsOf: (output, consumerId) => linkMbpsOf(viewers, output, consumerId),
    audioChoiceOf: (output, consumerId) => audioChoiceOf(viewers, output, consumerId),
    chooseAudioTrack: (output, consumerId, trackIndex) => chooseAudioTrack(viewers, output, consumerId, trackIndex),
    stepOnScreenOf: (output, consumerId) => stepOnScreenOf(viewers, output, consumerId),
    noteStepOnScreen: (output, consumerId, stepId) => noteStepOnScreen(viewers, output, consumerId, stepId),
    stepBeingWarmedOf: (output, consumerId) => stepBeingWarmedOf(viewers, output, consumerId),
    noteStepBeingWarmed: (output, consumerId, stepId) => noteStepBeingWarmed(viewers, output, consumerId, stepId),
    audioBeingWarmedOf: (output, consumerId) => audioBeingWarmedOf(viewers, output, consumerId),
    noteAudioBeingWarmed: (output, consumerId, id) => noteAudioBeingWarmed(viewers, output, consumerId, id),
    watches: (output, consumerId) => watches(viewers, output, consumerId),
    placeOn: (output, consumerId, seconds) => placeOn(viewers, output, consumerId, seconds),
    // Which output answers a height for a viewer is the viewer's own record.
    chosenOutputOf: (consumerId, height) => chosenOutputOf(viewers, consumerId, height),
    chooseOutput: (consumerId, height, key) => chooseOutput(viewers, consumerId, height, key),
    noteServingVerdict: (consumerId, verdict) => noteServingVerdict(viewers, consumerId, verdict),
    placeViewerOn: () => {},
    viewerSecondsOn: () => 0,
    activeOutputFor: () => base,
    viewerPositionOf: () => 0,
    outputTimes: { segmentStartTime: () => 0 },
    encodeRuns: { isLive: () => how.baseIsLive !== false },
    quality: { variantsOnScreen: () => new Set() },
    createOrGetSession: async () => how.handBack(),
    disposeSession: async (id) => { disposed.push(id); },
    planEncodersSoon: () => {},
    viewerLeaves: () => {},
    logger: { info: (line) => lines.push(line), warn: (line) => lines.push(line), error: (line) => lines.push(line) }
  });
  return { renditions, base, step, viewers, disposed, lines };
}

test("an output handed back because it already makes this picture is not taken from its viewers", async () => {
  // What `createOrGetSession` returns for a 720p request: the step that is
  // already producing it, which somebody has been watching all along.
  // The picture is itself re-encoded at 720 on this machine, so the step asked
  // for produces the same picture it does: the case adoption is written for,
  // and the one where what is let go of may be somebody's.
  const { renditions, step, viewers, disposed } = renditionsOver({
    handBack: () => step,
    baseProducedHeight: 720,
    stepProducedHeight: 720
  });
  viewers.of(step, "viewer-b");

  const resolved = await renditions.resolveVariantSession(BASE_ID, 720, -1, "viewer-a");

  assert.equal(resolved?.id, BASE_ID, "the incumbent making this picture answers for the height");
  assert.deepEqual(disposed, [], "and the step handed back is not taken from the viewer on it");
});

test("a step a second viewer reached while it was being made is not disposed under them", async () => {
  // The picture dies while the step is being prepared — the case the disposal
  // was written for — but a second viewer has reached the step meanwhile.
  const made = { id: STEP_ID };
  const { renditions, viewers, disposed, lines } = renditionsOver({
    baseIsLive: false,
    handBack: () => {
      // Registered onto it inside the window the disposal assumes is empty.
      viewers.of(made, "viewer-b");
      return made;
    }
  });

  const resolved = await renditions.resolveVariantSession(BASE_ID, 720, -1, "viewer-a");

  assert.equal(resolved, null, "the viewer who asked has lost the picture it was a step of");
  assert.deepEqual(disposed, [], "but the step itself is somebody's now");
  assert.ok(lines.some((line) => line.includes("kept although")), "and the reason is in the log");
});

test("a step nobody reached is still let go of when its picture dies", async () => {
  const made = { id: STEP_ID };
  const { renditions, disposed } = renditionsOver({ baseIsLive: false, handBack: () => made });

  const resolved = await renditions.resolveVariantSession(BASE_ID, 720, -1, "viewer-a");

  assert.equal(resolved, null);
  assert.deepEqual(disposed, [STEP_ID], "nothing holds it, and it would hold an encoder until its idle timer");
});

test("a step nobody is watching is kept while a response from it is still being sent", async () => {
  // The case the assignment exists for: the last viewer has stopped being
  // registered on the output, and its bytes are still going out. Asked at the
  // moment of letting go, which is the only moment at which the answer is
  // about now.
  const made = { id: STEP_ID, outputKey: "letting-go:made" };
  const { renditions, viewers, disposed, lines } = renditionsOver({ baseIsLive: false, handBack: () => made });
  const elsewhere = viewers.of({ id: "some-other-output" }, "viewer-c");
  const token = elsewhere.assignments.accept(made.outputKey);

  const resolved = await renditions.resolveVariantSession(BASE_ID, 720, -1, "viewer-a");

  assert.equal(resolved, null, "the viewer who asked has lost the picture it was a step of");
  assert.deepEqual(disposed, [], "but the output a response is being sent from is not taken away");
  assert.ok(lines.some((line) => line.includes("kept although")), "and the reason is in the log");

  // And once the response is done, nothing stands on it any more.
  elsewhere.assignments.release(token);
  assert.equal(viewers.stillNeeded(made), false);
});
