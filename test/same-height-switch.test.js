/**
 * @file A viewer moved between two outputs of the height on their screen, at
 * two bitrate limits, without their player being told (roadmap item 97, step
 * 12).
 *
 * What is pinned here:
 *
 * 1. the move is prepared for ONE viewer, and nobody else's choice or output
 *    changes;
 * 2. it is made only once the segment that viewer will ask for NEXT is closed
 *    on the new output — a segment closed behind it, an event that arrives
 *    after a seek, or nothing given yet in the viewing all read the next one
 *    from where the viewer is NOW;
 * 3. the move is one synchronous stretch: choice, output on screen and where
 *    the viewer is registered agree the moment it returns;
 * 4. the output left is not disposed: it goes by the idle expiry, which keeps
 *    it while an assignment stands;
 * 5. a move no longer wanted is cancelled, for that viewer alone;
 * 6. a move waiting on an output that closes nothing does not stand for ever:
 *    the viewer's report and a failure of that output's encoding are events
 *    that ask again, and a failed output is not prepared onto.
 *
 * The catalog, the viewer registry and the viewer functions are the REAL ones:
 * what is checked is the records they keep. Only encoding and the store are
 * stood in for, and the store is nothing but which segments are closed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Renditions } from "../services/encode/Renditions.js";
import { OutputCatalog } from "../services/encode/output/OutputCatalog.js";
import { Viewers } from "../services/viewer/Viewers.js";
import {
  audioBeingWarmedOf,
  audioChoiceOf,
  bufferedSecondsOf,
  chooseAudioTrack,
  chooseOutput,
  chosenOutputOf,
  consumersOn,
  generationOfRequest,
  givenOutputOf,
  heightsChosenAs,
  highestGivenSegmentOf,
  linkMbpsOf,
  noteAudioBeingWarmed,
  noteGivenOutput,
  noteSameHeightSwitch,
  noteServingVerdict,
  noteStepBeingWarmed,
  noteStepOnScreen,
  outputsBeingPrepared,
  placeOn,
  presentOn,
  qualityModeOf,
  sameHeightSwitchOf,
  stepBeingWarmedOf,
  stepOnScreenOf,
  switchingOnto,
  watches
} from "../services/viewer/choices.js";
import { activeOutputFor } from "../services/viewer/active-output.js";
import { EncodeAdmission } from "../services/encode/EncodeAdmission.js";
import { SourceFile } from "../services/media/SourceFile.js";
import { fmp4Format } from "../services/encode/segment-formats/fmp4.js";
import { outputSpec } from "./helpers/output-spec.js";
import { maxrateKbpsFor, nominalKbpsFor, softwareRateControlFor } from "../services/encode/args.js";

const BASE_ID = "1111111122223333";
const SEGMENT_SECONDS = 4;
const SEGMENTS = 150;
const HEIGHT = 720;
const NOMINAL = nominalKbpsFor({ width: 1280, height: HEIGHT });
// Three limits of one height, highest first. Given here, because the product
// offers only the nominal one until the set is decided (step 14).
const LIMITS = [NOMINAL, Math.round(NOMINAL * 0.6), Math.round(NOMINAL * 0.35)];
// A re-encoded soundtrack, which is what these outputs carry.
const AUDIO_MBPS = 0.128;

/**
 * A link that admits an output of this limit, with its soundtrack, and nothing
 * above it.
 *
 * @param {number} limit
 * @returns {number}
 */
function linkJustFor(limit) {
  return maxrateKbpsFor(limit) / 1000 + AUDIO_MBPS + 0.01;
}

/**
 * One output of the picture: 720p at a limit, on the even grid, shaped as
 * production shapes it.
 *
 * @param {{ id: string, file: object, limit: number }} what
 * @returns {object}
 */
function outputAt({ id, file, limit }) {
  const width = 1280;
  const spec = outputSpec({
    transcodeVideo: true,
    width,
    height: HEIGHT,
    rateControl: softwareRateControlFor({ width, height: HEIGHT, fps: 24, capKbps: limit })
  });
  return {
    id,
    file,
    spec,
    outputKey: spec.toKey(),
    timeline: { cutGrid: "uniform", segmentCount: SEGMENTS },
    segmentFormat: fmp4Format,
    output: { encodeHeight: HEIGHT }
  };
}

/**
 * A 720p picture at the nominal limit, watched by the viewers named, and
 * everything a move between its limits reads.
 *
 * @param {{ viewers?: string[], costSec?: number, cushionSec?: number }} [how]
 */
function pictureAtNominal(how = {}) {
  const file = new SourceFile({ sourceKey: "source-1", fileIndex: 0, name: "video.mkv" })
    .learn({ durationSeconds: SEGMENTS * SEGMENT_SECONDS, height: 1080, width: 1920 });
  const base = outputAt({ id: BASE_ID, file, limit: NOMINAL });
  const outputs = new OutputCatalog();
  outputs.set(BASE_ID, base);
  const viewers = new Viewers();
  const closed = new Set();
  const disposed = [];
  const opened = [];
  // Outputs whose encoding has failed for good, as `EncodeRuns.hasFailed` says.
  const failed = new Set();
  let made = 0;
  // What one encoder on any output here costs, in seconds of work per second of
  // film, when the check is about the machine's places. Nothing runs in this
  // setting, so what holds places is the preparations alone.
  const admission = Number.isFinite(how.costSec)
    ? new EncodeAdmission({
      liveRunsByAddress: () => new Map(),
      preparedAddresses: () => new Set(
        [...outputsBeingPrepared(viewers)].map((id) => outputs.get(id)?.outputKey).filter(Boolean)
      ),
      loadOf: () => ({ costSec: how.costSec, fileKey: "", fileCostSec: 0 }),
      availability: () => null
    })
    : null;
  const renditions = new Renditions({
    outputs,
    viewers,
    viewerCountOn: (output) => viewers.forOutput(output).size,
    outputStillNeeded: (output) => viewers.stillNeeded(output),
    viewerSecondsOn: () => 0,
    activeOutputFor: (args) => activeOutputFor({ ...args, viewers }),
    viewerPositionOf: (_id, consumerId) => viewers.get(consumerId)?.positionSeconds() ?? 0,
    placeViewerOn: (output, consumerId, seconds) => placeOn(viewers, output, consumerId, seconds),
    outputTimes: {
      segmentStartTime: (_output, index) => index * SEGMENT_SECONDS,
      segmentIndexForTime: (_output, seconds) => Math.floor(seconds / SEGMENT_SECONDS)
    },
    encodeRuns: { isLive: () => true, hasFailed: (output) => failed.has(output.id) },
    quality: { variantsOnScreen: () => new Set() },
    consumersOn: (output) => consumersOn(viewers, output),
    presentOn: (output) => presentOn(viewers, output),
    qualityModeOf: (output, consumerId) => qualityModeOf(viewers, output, consumerId),
    linkMbpsOf: (output, consumerId) => linkMbpsOf(viewers, output, consumerId),
    audioChoiceOf: (output, consumerId) => audioChoiceOf(viewers, output, consumerId),
    chooseAudioTrack: (output, consumerId, choice) => chooseAudioTrack(viewers, output, consumerId, choice),
    stepOnScreenOf: (output, consumerId) => stepOnScreenOf(viewers, output, consumerId),
    noteStepOnScreen: (output, consumerId, stepId) => noteStepOnScreen(viewers, output, consumerId, stepId),
    stepBeingWarmedOf: (output, consumerId) => stepBeingWarmedOf(viewers, output, consumerId),
    noteStepBeingWarmed: (output, consumerId, stepId) => noteStepBeingWarmed(viewers, output, consumerId, stepId),
    audioBeingWarmedOf: (output, consumerId) => audioBeingWarmedOf(viewers, output, consumerId),
    noteAudioBeingWarmed: (output, consumerId, id) => noteAudioBeingWarmed(viewers, output, consumerId, id),
    watches: (output, consumerId) => watches(viewers, output, consumerId),
    placeOn: (output, consumerId, seconds) => placeOn(viewers, output, consumerId, seconds),
    generationOfRequest: (consumerId, stated) => generationOfRequest(viewers, consumerId, stated),
    givenOutputOf: (consumerId, generation, height, index) =>
      givenOutputOf(viewers, consumerId, generation, height, index),
    noteGivenOutput: (consumerId, generation, height, index, key) =>
      noteGivenOutput(viewers, consumerId, generation, height, index, key),
    chosenOutputOf: (consumerId, height) => chosenOutputOf(viewers, consumerId, height),
    chooseOutput: (consumerId, height, key) => chooseOutput(viewers, consumerId, height, key),
    noteServingVerdict: (consumerId, verdict) => noteServingVerdict(viewers, consumerId, verdict),
    limitsFor: () => LIMITS,
    heightsChosenAs: (consumerId, key) => heightsChosenAs(viewers, consumerId, key),
    highestGivenSegmentOf: (consumerId, height) => highestGivenSegmentOf(viewers, consumerId, height),
    sameHeightSwitchOf: (consumerId) => sameHeightSwitchOf(viewers, consumerId),
    noteSameHeightSwitch: (consumerId, value) => noteSameHeightSwitch(viewers, consumerId, value),
    switchingOnto: (output) => switchingOnto(viewers, output),
    segmentClosed: (key, index) => closed.has(`${key}#${index}`),
    // What a viewer holds, as their page said, and the cushion a move that is
    // not urgent waits for — none unless a check names one.
    bufferedSecondsOf: (consumerId) => bufferedSecondsOf(viewers, consumerId),
    minimumBufferSecondsFor: () => how.cushionSec ?? null,
    headersCompatible: () => how.headerVerdict ?? { compatible: true, differences: [] },
    // THE REAL ADMISSION over the viewers' own records, when a cost is given;
    // otherwise every preparation is admitted, as the checks above need.
    admitsPreparation: (output) => (admission
      ? admission.admitsPreparation(output?.outputKey ?? "")
      : { admitted: true, reason: "", speedX: null }),
    getCachedAudioTracks: () => [],
    // Opening at a named limit returns the output with that key, made once:
    // the key is the output's identity, as `OutputOpening` has it.
    createOrGetSession: async (request) => {
      opened.push(request);
      const probe = outputAt({ id: "probe", file, limit: request.capKbps ?? NOMINAL });
      const existing = [...outputs.values()].find((output) => output.outputKey === probe.outputKey);
      if (existing) {
        if (Number.isInteger(how.preclosedIndex)) {
          closed.add(`${existing.outputKey}#${how.preclosedIndex}`);
        }
        return existing;
      }
      made += 1;
      const output = outputAt({ id: `${String(made).padStart(8, "9")}00000000`, file, limit: request.capKbps ?? NOMINAL });
      outputs.set(output.id, output);
      if (Number.isInteger(how.preclosedIndex)) {
        closed.add(`${output.outputKey}#${how.preclosedIndex}`);
      }
      return output;
    },
    disposeSession: async (id) => { disposed.push(id); outputs.delete(id); },
    planEncodersSoon: () => {},
    viewerLeaves: (output, consumerId) => viewers.leaves(output, consumerId),
    invalidateWaits: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  });
  for (const consumerId of how.viewers ?? ["viewer-a"]) {
    const viewer = viewers.of(base, consumerId);
    viewer.qualityMode = "auto";
    // What `ViewerRequests` records when the output is opened for them: the
    // soundtrack it carries, re-encoded, which is a load with a bound.
    viewer.audio = { trackIndex: 0, transcode: true };
    viewer.moveTo(40);
    // What production records when this viewer's player asked for 720p: the
    // picture answered it, by the rule.
    chooseOutput(viewers, consumerId, HEIGHT, base.outputKey);
    viewer.report({ linkMbps: linkJustFor(NOMINAL) * 2, bufferedAheadSec: 20, positionSeconds: 40, playing: true });
  }
  /**
   * The segments this viewer has been given in the viewing they are in.
   *
   * @param {string} consumerId
   * @param {number} upTo
   * @param {object} [output]
   */
  const given = (consumerId, upTo, output = base) => {
    const generation = viewers.get(consumerId).assignments.generation;
    for (let index = 0; index <= upTo; index += 1) {
      noteGivenOutput(viewers, consumerId, generation, HEIGHT, index, output.outputKey);
    }
  };
  /** @param {string} consumerId @param {number} limit */
  const linkNow = (consumerId, limit) => {
    viewers.get(consumerId).report({ linkMbps: linkJustFor(limit), bufferedAheadSec: 4, positionSeconds: viewers.get(consumerId).positionSeconds(), playing: true });
  };
  /** A segment closed on an output, and the store telling of it. */
  const close = (output, index) => {
    closed.add(`${output.outputKey}#${index}`);
    renditions.noteSegmentPublished(output.outputKey, index);
  };
  /**
   * A report from this viewer reaching the proxy: recorded, and then told, as
   * the net-report route does it.
   *
   * @param {string} consumerId
   * @param {number} linkMbps
   */
  const report = (consumerId, linkMbps) => {
    viewers.get(consumerId).report({ linkMbps, bufferedAheadSec: 4, positionSeconds: viewers.get(consumerId).positionSeconds(), playing: true });
    renditions.noteViewerReported(BASE_ID, consumerId);
  };
  /** Encoding an output failing for good, and `EncodeRuns` telling of it. */
  const fail = (output) => {
    failed.add(output.id);
    renditions.noteProductionFailed(output);
  };
  return { renditions, outputs, viewers, base, file, closed, close, given, linkNow, report, fail, failed, disposed, opened };
}

test("a thin link moves only its own viewer to a lower limit of the same height", async () => {
  const { renditions, viewers, base, close, given, linkNow, outputs } = pictureAtNominal({ viewers: ["viewer-a", "viewer-b"] });
  given("viewer-a", 10);
  given("viewer-b", 10);
  linkNow("viewer-a", LIMITS[1]);
  const move = await renditions.prepareSameHeightSwitch(base, "viewer-a", "down", "thin");
  assert.equal(move.started, true, move.reason);
  const prepared = outputs.get(sameHeightSwitchOf(viewers, "viewer-a").outputId);
  assert.equal(prepared.spec.video.encode.rateControl.maxrateKbps, maxrateKbpsFor(LIMITS[1]), "the highest lower limit the link admits");
  close(prepared, 11);
  assert.equal(chosenOutputOf(viewers, "viewer-a", HEIGHT), prepared.outputKey);
  assert.equal(chosenOutputOf(viewers, "viewer-b", HEIGHT), base.outputKey, "the other viewer's choice is theirs");
  assert.equal(stepOnScreenOf(viewers, base, "viewer-b"), null, "and so is what is on their screen");
  assert.equal(viewers.forOutput(prepared).has("viewer-b"), false, "nobody else is put on the new output");
});

test("until the segment asked for next is closed on the new output, the choice stands", async () => {
  const { renditions, viewers, base, close, given, linkNow, outputs } = pictureAtNominal();
  given("viewer-a", 10);
  linkNow("viewer-a", LIMITS[1]);
  await renditions.prepareSameHeightSwitch(base, "viewer-a", "down", "thin");
  const prepared = outputs.get(sameHeightSwitchOf(viewers, "viewer-a").outputId);
  close(prepared, 12);
  assert.equal(chosenOutputOf(viewers, "viewer-a", HEIGHT), base.outputKey, "a later segment does not stand for #11");
  close(prepared, 11);
  assert.equal(chosenOutputOf(viewers, "viewer-a", HEIGHT), prepared.outputKey);
});

test("a segment closed behind the one asked for next does not start the move", async () => {
  const { renditions, viewers, base, close, given, linkNow, outputs } = pictureAtNominal();
  given("viewer-a", 10);
  linkNow("viewer-a", LIMITS[1]);
  await renditions.prepareSameHeightSwitch(base, "viewer-a", "down", "thin");
  const prepared = outputs.get(sameHeightSwitchOf(viewers, "viewer-a").outputId);
  close(prepared, 5);
  assert.equal(chosenOutputOf(viewers, "viewer-a", HEIGHT), base.outputKey);
  assert.ok(sameHeightSwitchOf(viewers, "viewer-a"), "still being prepared");
});

test("with nothing given yet in the viewing, the next segment is the one where the viewer stands", async () => {
  const { renditions, viewers, base, close, linkNow, outputs } = pictureAtNominal();
  // Straight after a seek: a new viewing, nothing given in it.
  viewers.get("viewer-a").moveTo(80);
  viewers.get("viewer-a").assignments.statedGeneration(1);
  linkNow("viewer-a", LIMITS[1]);
  await renditions.prepareSameHeightSwitch(base, "viewer-a", "down", "thin");
  const prepared = outputs.get(sameHeightSwitchOf(viewers, "viewer-a").outputId);
  close(prepared, 11);
  assert.equal(chosenOutputOf(viewers, "viewer-a", HEIGHT), base.outputKey, "#11 is not where they stand");
  close(prepared, 80 / SEGMENT_SECONDS);
  assert.equal(chosenOutputOf(viewers, "viewer-a", HEIGHT), prepared.outputKey);
});

test("an event that arrives after a seek is judged against where the viewer is now", async () => {
  const { renditions, viewers, base, close, given, linkNow, outputs } = pictureAtNominal();
  given("viewer-a", 10);
  linkNow("viewer-a", LIMITS[1]);
  await renditions.prepareSameHeightSwitch(base, "viewer-a", "down", "thin");
  const prepared = outputs.get(sameHeightSwitchOf(viewers, "viewer-a").outputId);
  // They seek to 200 s before the closing of #11 is told.
  viewers.get("viewer-a").moveTo(200);
  viewers.get("viewer-a").assignments.statedGeneration(1);
  close(prepared, 11);
  assert.equal(chosenOutputOf(viewers, "viewer-a", HEIGHT), base.outputKey, "#11 was the next segment of a viewing they left");
  close(prepared, 200 / SEGMENT_SECONDS);
  assert.equal(chosenOutputOf(viewers, "viewer-a", HEIGHT), prepared.outputKey);
});

test("the move returns with the choice, the screen and the registration in agreement", async () => {
  const { renditions, viewers, base, closed, given, linkNow, outputs } = pictureAtNominal();
  given("viewer-a", 10);
  linkNow("viewer-a", LIMITS[1]);
  await renditions.prepareSameHeightSwitch(base, "viewer-a", "down", "thin");
  const prepared = outputs.get(sameHeightSwitchOf(viewers, "viewer-a").outputId);
  closed.add(`${prepared.outputKey}#11`);
  // Told synchronously, and nothing about it is still to happen after it returns.
  const returned = renditions.noteSegmentPublished(prepared.outputKey, 11);
  assert.equal(returned, undefined, "not a promise: there is no await in the move");
  assert.equal(chosenOutputOf(viewers, "viewer-a", HEIGHT), prepared.outputKey);
  assert.equal(stepOnScreenOf(viewers, base, "viewer-a"), prepared.id);
  assert.equal(viewers.forOutput(prepared).has("viewer-a"), true);
  assert.equal(sameHeightSwitchOf(viewers, "viewer-a"), null, "nothing left being prepared");
  assert.equal(renditions.servingOutputFor(base, HEIGHT, "viewer-a"), prepared, "the next new address is answered by it");
});

test("a ready output with an incompatible init is refused as an unstarted move", async () => {
  const { renditions, viewers, base, given, linkNow, outputs } = pictureAtNominal({
    headerVerdict: { compatible: false, differences: ["avcC differs"] },
    preclosedIndex: 11
  });
  given("viewer-a", 10);
  linkNow("viewer-a", LIMITS[1]);
  const move = await renditions.prepareSameHeightSwitch(base, "viewer-a", "down", "thin");
  const prepared = [...outputs.values()].find((output) => output !== base);
  assert.equal(move.started, false, "the quality budget can try its next option immediately");
  assert.match(move.reason, /not usable/);
  assert.equal(chosenOutputOf(viewers, "viewer-a", HEIGHT), base.outputKey, "the old output remains selected");
  assert.equal(stepOnScreenOf(viewers, base, "viewer-a"), null, "the player is not assigned the incompatible init");
  assert.equal(sameHeightSwitchOf(viewers, "viewer-a"), null, "the refused transition releases its preparation");
  assert.equal(viewers.forOutput(prepared).has("viewer-a"), false, "the viewer leaves the refused output");
});

test("the output left is not disposed, and its assignments keep it", async () => {
  const { renditions, viewers, base, close, given, linkNow, outputs, disposed } = pictureAtNominal();
  // Their screen holds a STEP of the picture, at the middle limit.
  const stepAtMiddle = outputAt({ id: "2222222233334445", file: base.file, limit: LIMITS[1] });
  outputs.set(stepAtMiddle.id, stepAtMiddle);
  outputs.markStep(stepAtMiddle);
  stepAtMiddle.variantHeight = HEIGHT;
  chooseOutput(viewers, "viewer-a", HEIGHT, stepAtMiddle.outputKey);
  noteStepOnScreen(viewers, base, "viewer-a", stepAtMiddle.id);
  watches(viewers, stepAtMiddle, "viewer-a");
  given("viewer-a", 10, stepAtMiddle);
  linkNow("viewer-a", LIMITS[2]);
  const move = await renditions.prepareSameHeightSwitch(base, "viewer-a", "down", "thin");
  assert.equal(move.started, true, move.reason);
  const prepared = outputs.get(sameHeightSwitchOf(viewers, "viewer-a").outputId);
  close(prepared, 11);
  assert.equal(chosenOutputOf(viewers, "viewer-a", HEIGHT), prepared.outputKey);
  assert.equal(viewers.forOutput(stepAtMiddle).has("viewer-a"), false, "they stop watching the step they left");
  assert.deepEqual(disposed, [], "nothing is disposed by the move");
  assert.equal(outputs.get(stepAtMiddle.id), stepAtMiddle);
  assert.equal(viewers.assignmentsHold(stepAtMiddle), true, "what it gave in this viewing still holds it against the idle expiry");
  assert.equal(viewers.forOutput(base).has("viewer-a"), true, "and the picture itself is never left");
});

test("a viewer moved off the picture itself stays registered on it", async () => {
  const { renditions, viewers, base, close, given, linkNow, outputs } = pictureAtNominal();
  given("viewer-a", 10);
  linkNow("viewer-a", LIMITS[1]);
  await renditions.prepareSameHeightSwitch(base, "viewer-a", "down", "thin");
  const prepared = outputs.get(sameHeightSwitchOf(viewers, "viewer-a").outputId);
  close(prepared, 11);
  assert.equal(viewers.forOutput(base).has("viewer-a"), true);
  assert.equal(stepOnScreenOf(viewers, base, "viewer-a"), prepared.id);
});

test("up goes one limit at a time, and at the height's highest limit there is nowhere to go", async () => {
  const { renditions, viewers, base, close, given, outputs } = pictureAtNominal();
  const lowest = outputAt({ id: "3333333344445555", file: base.file, limit: LIMITS[2] });
  outputs.set(lowest.id, lowest);
  outputs.markStep(lowest);
  lowest.variantHeight = HEIGHT;
  chooseOutput(viewers, "viewer-a", HEIGHT, lowest.outputKey);
  noteStepOnScreen(viewers, base, "viewer-a", lowest.id);
  watches(viewers, lowest, "viewer-a");
  given("viewer-a", 10, lowest);
  const up = await renditions.prepareSameHeightSwitch(base, "viewer-a", "up", "room");
  assert.equal(up.started, true, up.reason);
  const prepared = outputs.get(sameHeightSwitchOf(viewers, "viewer-a").outputId);
  assert.equal(prepared.spec.video.encode.rateControl.maxrateKbps, maxrateKbpsFor(LIMITS[1]), "the next limit, not the highest");
  close(prepared, 11);
  // And from the picture's own limit, which is the height's highest, up is refused
  // — which is what sends the budget to the next HEIGHT instead.
  const fresh = pictureAtNominal();
  const refused = await fresh.renditions.prepareSameHeightSwitch(fresh.base, "viewer-a", "up", "room");
  assert.equal(refused.started, false);
  assert.match(refused.reason, /highest/);
});

test("one of two viewers giving up a move does not take the other off it", async () => {
  const { renditions, viewers, base, close, given, linkNow, outputs } = pictureAtNominal({ viewers: ["viewer-a", "viewer-b"] });
  given("viewer-a", 10);
  given("viewer-b", 10);
  linkNow("viewer-a", LIMITS[1]);
  linkNow("viewer-b", LIMITS[1]);
  await renditions.prepareSameHeightSwitch(base, "viewer-a", "down", "thin");
  await renditions.prepareSameHeightSwitch(base, "viewer-b", "down", "thin");
  const prepared = outputs.get(sameHeightSwitchOf(viewers, "viewer-a").outputId);
  assert.equal(sameHeightSwitchOf(viewers, "viewer-b").outputId, prepared.id, "one output of that limit, for both");
  // A's link recovers; the next event about the prepared output cancels A's move.
  viewers.get("viewer-a").report({ linkMbps: linkJustFor(NOMINAL) * 2, bufferedAheadSec: 20, positionSeconds: 40, playing: true });
  close(prepared, 3);
  assert.equal(sameHeightSwitchOf(viewers, "viewer-a"), null, "A's move is cancelled");
  assert.equal(viewers.forOutput(prepared).has("viewer-a"), false);
  assert.ok(sameHeightSwitchOf(viewers, "viewer-b"), "B's is not");
  assert.equal(viewers.forOutput(prepared).has("viewer-b"), true);
  assert.equal(outputs.get(prepared.id), prepared, "and the output stays");
});

test("a link that fell further while the output was being prepared cancels the move", async () => {
  const { renditions, viewers, base, close, given, linkNow, outputs } = pictureAtNominal();
  given("viewer-a", 10);
  linkNow("viewer-a", LIMITS[1]);
  await renditions.prepareSameHeightSwitch(base, "viewer-a", "down", "thin");
  const prepared = outputs.get(sameHeightSwitchOf(viewers, "viewer-a").outputId);
  linkNow("viewer-a", LIMITS[2]);
  close(prepared, 11);
  assert.equal(chosenOutputOf(viewers, "viewer-a", HEIGHT), base.outputKey, "not moved onto what no longer fits");
  assert.equal(sameHeightSwitchOf(viewers, "viewer-a"), null);
});

test("a move is refused where there is no limit to change", async () => {
  const { renditions, viewers, base, given, linkNow } = pictureAtNominal();
  given("viewer-a", 10);
  // No lower limit this link admits.
  viewers.get("viewer-a").report({ linkMbps: 0.2, bufferedAheadSec: 4, positionSeconds: 40, playing: true });
  const refused = await renditions.prepareSameHeightSwitch(base, "viewer-a", "down", "thin");
  assert.equal(refused.started, false);
  assert.match(refused.reason, /no lower limit/);
  linkNow("viewer-a", LIMITS[1]);
  assert.equal(sameHeightSwitchOf(viewers, "viewer-a"), null);
});

// A MOVE MUST NOT STAND FOR EVER ON AN OUTPUT THAT CLOSES NOTHING (review
// 2026-09-24). Publication was its only event; an output that produces nothing
// sends none, and the quality budget leaves a viewer with a move pending alone.

test("a link that recovered cancels the move on the viewer's report, with nothing published", async () => {
  const { renditions, viewers, base, given, linkNow, report, outputs } = pictureAtNominal();
  given("viewer-a", 10);
  linkNow("viewer-a", LIMITS[1]);
  await renditions.prepareSameHeightSwitch(base, "viewer-a", "down", "thin");
  const prepared = outputs.get(sameHeightSwitchOf(viewers, "viewer-a").outputId);
  report("viewer-a", linkJustFor(NOMINAL) * 2);
  assert.equal(sameHeightSwitchOf(viewers, "viewer-a"), null, "cancelled with no segment closed anywhere");
  assert.equal(renditions.sameHeightSwitchPending("viewer-a"), false, "so the budget decides for them again");
  assert.equal(viewers.forOutput(prepared).has("viewer-a"), false);
  assert.equal(chosenOutputOf(viewers, "viewer-a", HEIGHT), base.outputKey);
});

test("a report while the move is still wanted and not ready leaves it waiting", async () => {
  const { renditions, viewers, base, given, linkNow, report } = pictureAtNominal();
  given("viewer-a", 10);
  linkNow("viewer-a", LIMITS[1]);
  await renditions.prepareSameHeightSwitch(base, "viewer-a", "down", "thin");
  report("viewer-a", linkJustFor(LIMITS[1]));
  assert.ok(sameHeightSwitchOf(viewers, "viewer-a"), "still being prepared");
  assert.equal(chosenOutputOf(viewers, "viewer-a", HEIGHT), base.outputKey, "and not made: #11 is not closed");
});

test("encoding the output being prepared failing for good cancels the move, with nothing published", async () => {
  const { renditions, viewers, base, given, linkNow, fail, outputs } = pictureAtNominal();
  given("viewer-a", 10);
  linkNow("viewer-a", LIMITS[1]);
  await renditions.prepareSameHeightSwitch(base, "viewer-a", "down", "thin");
  const prepared = outputs.get(sameHeightSwitchOf(viewers, "viewer-a").outputId);
  fail(prepared);
  assert.equal(sameHeightSwitchOf(viewers, "viewer-a"), null);
  assert.equal(viewers.forOutput(prepared).has("viewer-a"), false);
  assert.equal(chosenOutputOf(viewers, "viewer-a", HEIGHT), base.outputKey);
});

test("a move is not prepared onto an output whose encoding has failed", async () => {
  const { renditions, viewers, base, given, linkNow, fail, outputs } = pictureAtNominal();
  given("viewer-a", 10);
  linkNow("viewer-a", LIMITS[1]);
  await renditions.prepareSameHeightSwitch(base, "viewer-a", "down", "thin");
  fail(outputs.get(sameHeightSwitchOf(viewers, "viewer-a").outputId));
  // The next budget pass asks for the same move: opening that limit returns the
  // same, failed, output.
  const again = await renditions.prepareSameHeightSwitch(base, "viewer-a", "down", "thin");
  assert.equal(again.started, false);
  assert.match(again.reason, /has failed/);
  assert.equal(sameHeightSwitchOf(viewers, "viewer-a"), null);
});

// A PLACE ON THIS MACHINE (roadmap item 97, step 13). One encoder here costs
// 0.6 s of work per second of film: one alone makes 1.67x, two make 0.83x, so
// the machine has room for exactly one.

test("two moves onto two different outputs with room for one: one is admitted, the other refused and not recorded", async () => {
  const { renditions, viewers, base, given, linkNow } = pictureAtNominal({ viewers: ["viewer-a", "viewer-b"], costSec: 0.6 });
  given("viewer-a", 10);
  given("viewer-b", 10);
  // Two different targets: the highest lower limit each link admits.
  linkNow("viewer-a", LIMITS[1]);
  linkNow("viewer-b", LIMITS[2]);
  const moves = await Promise.all([
    renditions.prepareSameHeightSwitch(base, "viewer-a", "down", "thin"),
    renditions.prepareSameHeightSwitch(base, "viewer-b", "down", "thin")
  ]);
  assert.equal(moves.filter((move) => move.started).length, 1, "one place, one move");
  const refused = moves.find((move) => !move.started);
  assert.equal(refused.noPlace, true, "refused for the machine, not for a missing limit");
  const loser = moves[0].started ? "viewer-b" : "viewer-a";
  assert.equal(sameHeightSwitchOf(viewers, loser), null, "nothing recorded for the refused one");
  assert.equal(renditions.sameHeightSwitchPending(loser), false, "so the budget goes to its other lever at once");
  assert.equal(outputsBeingPrepared(viewers).size, 1, "only the admitted move holds a place");
});

test("two moves onto one output take one place, and one of them giving up keeps it", async () => {
  const { renditions, viewers, base, given, linkNow, report } = pictureAtNominal({
    viewers: ["viewer-a", "viewer-b", "viewer-c"],
    costSec: 0.6
  });
  for (const viewer of ["viewer-a", "viewer-b", "viewer-c"]) {
    given(viewer, 10);
  }
  linkNow("viewer-a", LIMITS[1]);
  linkNow("viewer-b", LIMITS[1]);
  const [first, second] = await Promise.all([
    renditions.prepareSameHeightSwitch(base, "viewer-a", "down", "thin"),
    renditions.prepareSameHeightSwitch(base, "viewer-b", "down", "thin")
  ]);
  assert.equal(first.started, true, first.reason);
  assert.equal(second.started, true, "the same output needs one encoder however many wait for it");
  assert.equal(outputsBeingPrepared(viewers).size, 1);
  // A's link recovers: A's move is cancelled, B's still holds the place.
  report("viewer-a", linkJustFor(NOMINAL) * 2);
  assert.equal(sameHeightSwitchOf(viewers, "viewer-a"), null);
  assert.equal(outputsBeingPrepared(viewers).size, 1, "B still holds it");
  linkNow("viewer-c", LIMITS[2]);
  const third = await renditions.prepareSameHeightSwitch(base, "viewer-c", "down", "thin");
  assert.equal(third.started, false, "the place B holds is not free");
  assert.equal(third.noPlace, true);
});

test("a move UP is made once the viewer holds the cushion, on the report that says so", async () => {
  const { renditions, viewers, base, close, given, outputs } = pictureAtNominal({ cushionSec: 12 });
  const lowest = outputAt({ id: "3333333344445555", file: base.file, limit: LIMITS[2] });
  outputs.set(lowest.id, lowest);
  outputs.markStep(lowest);
  lowest.variantHeight = HEIGHT;
  chooseOutput(viewers, "viewer-a", HEIGHT, lowest.outputKey);
  noteStepOnScreen(viewers, base, "viewer-a", lowest.id);
  watches(viewers, lowest, "viewer-a");
  given("viewer-a", 10, lowest);
  viewers.get("viewer-a").report({ linkMbps: linkJustFor(NOMINAL) * 2, bufferedAheadSec: 4, positionSeconds: 40, playing: true });
  const up = await renditions.prepareSameHeightSwitch(base, "viewer-a", "up", "room");
  assert.equal(up.started, true, up.reason);
  const prepared = outputs.get(sameHeightSwitchOf(viewers, "viewer-a").outputId);
  close(prepared, 11);
  assert.equal(chosenOutputOf(viewers, "viewer-a", HEIGHT), lowest.outputKey, "ready, but 4 s held against 12 s needed");
  viewers.get("viewer-a").report({ linkMbps: linkJustFor(NOMINAL) * 2, bufferedAheadSec: 14, positionSeconds: 40, playing: true });
  renditions.noteViewerReported(BASE_ID, "viewer-a");
  assert.equal(chosenOutputOf(viewers, "viewer-a", HEIGHT), prepared.outputKey, "the cushion is held: the move is made");
});

test("a move DOWN is made the moment the piece is ready, whatever the cushion", async () => {
  const { renditions, viewers, base, close, given, linkNow, outputs } = pictureAtNominal({ cushionSec: 30 });
  given("viewer-a", 10);
  linkNow("viewer-a", LIMITS[1]);
  await renditions.prepareSameHeightSwitch(base, "viewer-a", "down", "thin");
  const prepared = outputs.get(sameHeightSwitchOf(viewers, "viewer-a").outputId);
  close(prepared, 11);
  assert.equal(chosenOutputOf(viewers, "viewer-a", HEIGHT), prepared.outputKey, "a shrinking buffer is not waited on");
});

test("with no place on the machine the output on screen stays", async () => {
  const { renditions, viewers, base, given, linkNow } = pictureAtNominal({ costSec: 2 });
  given("viewer-a", 10);
  linkNow("viewer-a", LIMITS[1]);
  const move = await renditions.prepareSameHeightSwitch(base, "viewer-a", "down", "thin");
  assert.equal(move.started, false);
  assert.equal(move.noPlace, true);
  assert.equal(chosenOutputOf(viewers, "viewer-a", HEIGHT), base.outputKey, "nothing moved");
  assert.equal(sameHeightSwitchOf(viewers, "viewer-a"), null, "and nothing is left waiting");
});

test("a height is ready for a viewer only when the piece they ask for next is closed on it", () => {
  const { renditions, outputs, base, closed, given } = pictureAtNominal();
  const smaller = outputAt({ id: "4444444455556666", file: base.file, limit: LIMITS[2] });
  smaller.variantHeight = 480;
  outputs.set(smaller.id, smaller);
  outputs.markStep(smaller);
  given("viewer-a", 10);
  assert.equal(renditions.heightReadyFor(base, "viewer-a", 480), false, "nothing closed on it");
  closed.add(`${smaller.outputKey}#9`);
  assert.equal(renditions.heightReadyFor(base, "viewer-a", 480), false, "a piece behind the next one says nothing");
  closed.add(`${smaller.outputKey}#11`);
  assert.equal(renditions.heightReadyFor(base, "viewer-a", 480), true);
  assert.equal(renditions.heightReadyFor(base, "viewer-a", 360), false, "no step at that height at all");
});

test("a move up can be taken back by the budget, for that viewer alone", async () => {
  const { renditions, viewers, base, given, outputs } = pictureAtNominal();
  const lowest = outputAt({ id: "3333333344445555", file: base.file, limit: LIMITS[2] });
  outputs.set(lowest.id, lowest);
  outputs.markStep(lowest);
  lowest.variantHeight = HEIGHT;
  chooseOutput(viewers, "viewer-a", HEIGHT, lowest.outputKey);
  noteStepOnScreen(viewers, base, "viewer-a", lowest.id);
  watches(viewers, lowest, "viewer-a");
  given("viewer-a", 10, lowest);
  await renditions.prepareSameHeightSwitch(base, "viewer-a", "up", "room");
  assert.equal(renditions.sameHeightSwitchDirection("viewer-a"), "up");
  renditions.cancelSameHeightSwitch("viewer-a", "the room went");
  assert.equal(sameHeightSwitchOf(viewers, "viewer-a"), null);
  assert.equal(chosenOutputOf(viewers, "viewer-a", HEIGHT), lowest.outputKey, "they stay where they are");
});
