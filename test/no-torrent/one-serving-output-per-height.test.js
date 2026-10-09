/**
 * @file Four addressings of one step must name one output, and it must be an
 * output that can actually serve the picture it is a step of.
 *
 * A step is addressed four times — warmed for a switch, its init fetched, its
 * segments fetched, and named by the page as the one now playing — and each of
 * them decided for itself which output that is. Two things made them disagree:
 *
 * 1. the answer was recorded on ONE of the three paths that give one. A step
 *    produced at another size than the one asked for is NAMED after the size it
 *    produces, so nothing could find it by the height it answers, and every
 *    later request decided again;
 * 2. what was recorded was a HEIGHT. A picture's family is gathered by the
 *    file, and one file can hold two pictures that are not interchangeable —
 *    another container, other cuts, another soundtrack — so a height cannot say
 *    which output, and a step of one container could be handed to a picture of
 *    the other.
 *
 * Both are the address of the output, recorded on every path and checked for
 * being the same material.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Renditions } from "../../services/encode/Renditions.js";
import { OutputCatalog } from "../../services/encode/output/OutputCatalog.js";
import { Viewers } from "../../services/viewer/Viewers.js";
import {
  audioBeingWarmedOf,
  audioChoiceOf,
  chooseAudioTrack,
  chooseOutput,
  chosenOutputOf,
  consumersOn,
  generationOfRequest,
  givenOutputOf,
  linkMbpsOf,
  noteGivenOutput,
  noteServingVerdict,
  noteAudioBeingWarmed,
  noteStepBeingWarmed,
  noteStepOnScreen,
  placeOn,
  presentOn,
  qualityModeOf,
  noteSameHeightSwitch,
  sameHeightSwitchOf,
  stepBeingWarmedOf,
  stepOnScreenOf,
  watches
} from "../../services/viewer/choices.js";
import { SourceFile } from "../../services/media/SourceFile.js";
import { fmp4Format } from "../../services/encode/segment-formats/fmp4.js";
import { mpegtsFormat } from "../../services/encode/segment-formats/mpegts.js";
import { outputSpec } from "./helpers/output-spec.js";
import { softwareRateControlFor } from "../../services/encode/args.js";
import { OUTPUT_UNAVAILABLE } from "../../services/encode/output/index.js";

const BASE_ID = "6666666677778888";
const MADE_ID = "7777777788889999";
const FOREIGN_ID = "8888888899990000";

/**
 * One output of a file, shaped as production shapes it: an identity that states
 * its actual format, the address that follows from it, and what its encoder
 * produces.
 *
 * @param {{ id: string, file: object, height?: number, segmentFormatId?: string, preset?: string | null, capKbps?: number | null }} what
 * @returns {object}
 */
function outputOf({ id, file, height = 0, segmentFormatId = "fmp4", preset = null, capKbps = null }) {
  const width = height > 0 ? Math.round((height * 16) / 9) : 0;
  const spec = outputSpec({
    transcodeVideo: height > 0,
    height,
    width,
    segmentFormatId,
    preset,
    // A limit, when the test gives one: what the viewer's link is compared
    // against. None is a hardware-like output with no bound.
    rateControl: capKbps ? softwareRateControlFor({
      width, height, fps: 24, source: { width, height, pictureKbps: 20000 }, capKbps
    }) : null
  });
  return {
    id,
    file,
    spec,
    outputKey: spec.toKey(),
    timeline: { cutGrid: "uniform" },
    segmentFormat: segmentFormatId === "mpegts" ? mpegtsFormat : fmp4Format,
    output: { encodeHeight: height }
  };
}

/**
 * A 1080p picture whose steps are whatever `createOrGetSession` hands back.
 *
 * The catalog is the REAL one: what is being checked is the record it keeps and
 * the lookup over it, and a fake of both would be a description of the answer
 * rather than the answer.
 *
 * @param {{ mode?: "auto" | "manual", hands?: (file: object) => object }} [how]
 */
function pictureWithSteps(how = {}) {
  const file = new SourceFile({ sourceKey: "source-1", fileIndex: 0, name: "video.mkv" })
    .learn({ durationSeconds: 600, height: 1080, width: 1920 });
  const base = outputOf({ id: BASE_ID, file });
  base.variantHeight = 1080;
  const outputs = new OutputCatalog();
  outputs.set(BASE_ID, base);
  const viewers = new Viewers();
  const asked = [];
  const renditions = new Renditions({
    outputs,
    viewers,
    viewersOf: (output) => viewers.forOutput(output),
    viewerCountOn: (output) => viewers.forOutput(output).size,
    viewerSecondsOn: () => 0,
    activeOutputFor: () => base,
    viewerPositionOf: () => 0,
    placeViewerOn: () => {},
    outputTimes: { segmentStartTime: () => 0 },
    encodeRuns: { isLive: () => true },
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
    // A change of rung cancels a move between limits being prepared; nothing is
    // prepared in these fixtures.
    sameHeightSwitchOf: (consumerId) => sameHeightSwitchOf(viewers, consumerId),
    noteSameHeightSwitch: (consumerId, value) => noteSameHeightSwitch(viewers, consumerId, value),
    // Nothing is stored for a gone output in these fixtures, and no header can
    // be proved compatible: a lost address is lost.
    storedPieceReady: () => how.storedPieceReady === true,
    headersCompatible: () => how.headersCompatible ?? { compatible: false, differences: ["no header"] },
    getCachedAudioTracks: () => how.audioTracks ?? [],
    createOrGetSession: async (request) => {
      asked.push(request);
      if (how.unavailable) {
        const error = new Error("No output suits this viewer.");
        error.code = OUTPUT_UNAVAILABLE;
        error.details = how.unavailable;
        throw error;
      }
      const made = how.hands ? how.hands(file, request) : outputOf({ id: MADE_ID, file, height: 540 });
      const existing = outputs.get(made.id);
      if (existing?.outputKey === made.outputKey) {
        return existing;
      }
      outputs.set(made.id, made);
      return made;
    },
    disposeSession: async (id) => { outputs.delete(id); },
    planEncodersSoon: () => {},
    viewerLeaves: () => {},
    invalidateWaits: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  });
  const viewer = viewers.of(base, "viewer-a");
  viewer.qualityMode = how.mode ?? "auto";
  return { renditions, outputs, base, file, viewers, viewer, asked };
}

test("a step produced at another size is still the answer for the height asked for", async () => {
  // The whole of what was wrong: 720p is answered by a picture of 540p, the
  // step is NAMED 540, and the answer was recorded only where the two agreed.
  const { renditions, base, asked, viewers } = pictureWithSteps();

  const made = await renditions.resolveVariantSession(BASE_ID, 720, -1, "viewer-a");

  assert.equal(made.id, MADE_ID);
  assert.equal(chosenOutputOf(viewers, "viewer-a", 720), made.outputKey, "the address is what was recorded, on the viewer");
  assert.equal(renditions.servingOutputFor(base, 720, "viewer-a").id, MADE_ID, "and it is what answers them next time");
  assert.equal(asked.length, 1, "nothing else was made");
});

test("the four addressings of that step name one output", async () => {
  const { renditions, base, viewers, asked } = pictureWithSteps();

  const warmed = await renditions.resolveVariantSession(BASE_ID, 720, -1, "viewer-a");
  const init = await renditions.resolveVariantFile(BASE_ID, 720, "init.mp4", "viewer-a");
  const segment = await renditions.resolveVariantFile(BASE_ID, 720, "segment-00000.mp4", "viewer-a");
  const played = renditions.viewerPlays(BASE_ID, "viewer-a", 720, 30);

  assert.equal(warmed.id, MADE_ID);
  assert.equal(init.sessionId, MADE_ID, "the init must come from the output that was warmed");
  assert.equal(segment.sessionId, MADE_ID, "and so must the segments");
  assert.equal(played, true, "and the page's statement must find it");
  // Read back through the viewer layer, which is where the step on a screen
  // lives. This line used to name a method that exists nowhere —
  // `renditions.stepOnScreenOfViewer?.(…) ?? MADE_ID` — so it substituted the
  // expected value for the missing answer and compared it with itself.
  assert.equal(
    stepOnScreenOf(viewers, base, "viewer-a"),
    MADE_ID,
    "and the viewer's own record must name it"
  );
  assert.equal(asked.length, 1, "one output was made, not four");
});

test("the picture answering for its own height is recorded like any other answer", async () => {
  const { renditions, viewers, base } = pictureWithSteps();

  const answer = await renditions.resolveVariantSession(BASE_ID, 1080, -1, "viewer-a");

  assert.equal(answer.id, BASE_ID);
  assert.equal(chosenOutputOf(viewers, "viewer-a", 1080), base.outputKey, "the answer is recorded for the next address");
});

test("a step of another container is not handed to this picture", async () => {
  // One file, two pictures, and they are NOT interchangeable: a segment of the
  // one is a name the other's player cannot even ask for. The family is
  // gathered by the file, so without the material check this is exactly what a
  // height match returns.
  const { renditions, outputs, base, file } = pictureWithSteps({
    hands: () => outputOf({ id: MADE_ID, file, height: 720, segmentFormatId: "mpegts" })
  });
  const foreign = outputs.get(MADE_ID) ?? null;
  void foreign;

  const made = await renditions.resolveVariantSession(BASE_ID, 720, -1, "viewer-a");
  outputs.markStep(made);

  assert.equal(made.spec.segmentFormatId, "mpegts", "the fixture must describe the case");
  assert.equal(
    renditions.servingOutputFor(base, 720, "viewer-a"),
    null,
    "a step of another container answers for nothing of this picture"
  );
});

test("a step of another container is not put in the place of the one just made", async () => {
  // The second way in, and fixing the first left it open INSIDE the same
  // operation: the lookup rejects the MPEG-TS step correctly, an fMP4 step is
  // therefore made — and the replacement that follows creation finds the
  // MPEG-TS one by produced height alone, lets the new one go, and hands back
  // an output whose segment names this picture's player cannot ask for.
  const { renditions, outputs, file, viewers } = pictureWithSteps({
    hands: () => outputOf({ id: MADE_ID, file, height: 720 })
  });
  const foreign = outputOf({ id: FOREIGN_ID, file, height: 720, segmentFormatId: "mpegts" });
  outputs.set(FOREIGN_ID, foreign);
  outputs.markStep(foreign);
  assert.equal(foreign.spec.segmentFormatId, "mpegts", "the fixture must describe the case");
  assert.equal(outputs.producedHeightOf(foreign), 720, "and it must match on produced height");

  const made = await renditions.resolveVariantSession(BASE_ID, 720, -1, "viewer-a");

  assert.equal(made.id, MADE_ID, "the answer is the step of this picture's own container");
  assert.equal(made.spec.segmentFormatId, "fmp4");
  assert.equal(outputs.has(MADE_ID), true, "and it was not let go in favour of the foreign one");
  assert.equal(
    chosenOutputOf(viewers, "viewer-a", 720),
    made.outputKey,
    "the address recorded is the one that can actually serve"
  );
});

test("an answer does not outlive the output that gave it", async () => {
  const { renditions, outputs, base, viewers } = pictureWithSteps();

  const made = await renditions.resolveVariantSession(BASE_ID, 720, -1, "viewer-a");
  assert.equal(chosenOutputOf(viewers, "viewer-a", 720), made.outputKey);

  outputs.delete(made.id);

  assert.equal(renditions.servingOutputFor(base, 720, "viewer-a"), null, "an address nothing serves is not an answer");
});

test("a request for a file says whose it is, so the viewer's mode decides", async () => {
  const { renditions, asked } = pictureWithSteps({ mode: "auto" });

  await renditions.resolveVariantFile(BASE_ID, 480, "segment-00000.mp4", "viewer-a");

  assert.equal(asked.length, 1, "the fixture must have reached the making of an output");
  assert.equal(asked[0].servingMode, "auto", "the viewer is in AUTO and their request must say so");
});

test("a repeat in the same viewing is answered by what answered it, after two transitions", async () => {
  // Roadmap item 97, step 9. The shared record of which output answers 720p
  // moves on — another interchangeable 720p step now answers the file — and
  // the viewer seeks twice. A request made in the FIRST viewing and repeated
  // must still be answered by the output that answered it: its bytes for that
  // segment are what the player already holds or half holds.
  const { renditions, outputs, file, viewers } = pictureWithSteps({
    hands: (source) => outputOf({ id: MADE_ID, file: source, height: 720 })
  });

  const firstSegment = await renditions.resolveVariantFile(BASE_ID, 720, "segment-00005.mp4", "viewer-a", 0);
  const firstInit = await renditions.resolveVariantFile(BASE_ID, 720, "init.mp4", "viewer-a", 0);
  assert.equal(firstSegment.sessionId, MADE_ID, "the fixture must reach the made step");
  assert.equal(firstInit.sessionId, MADE_ID);

  const other = outputOf({ id: FOREIGN_ID, file, height: 720, preset: "veryfast" });
  outputs.set(FOREIGN_ID, other);
  outputs.markStep(other);
  // The rule chooses again for NEW addresses (step 12 is what triggers this in
  // the product; here it is stated outright).
  chooseOutput(viewers, "viewer-a", 720, other.outputKey);
  assert.notEqual(other.outputKey, outputs.get(MADE_ID).outputKey, "the fixture needs two outputs, not one");

  viewers.get("viewer-a").assignments.statedGeneration(1);
  viewers.get("viewer-a").assignments.statedGeneration(2);

  const repeatedSegment = await renditions.resolveVariantFile(BASE_ID, 720, "segment-00005.mp4", "viewer-a", 0);
  const repeatedInit = await renditions.resolveVariantFile(BASE_ID, 720, "init.mp4", "viewer-a", 0);
  assert.equal(repeatedSegment.sessionId, MADE_ID, "a repeat of the first viewing's segment gets what answered it");
  assert.equal(repeatedInit.sessionId, MADE_ID, "and so does its init, recorded as segment -1");

  const fresh = await renditions.resolveVariantFile(BASE_ID, 720, "segment-00005.mp4", "viewer-a", 2);
  assert.equal(fresh.sessionId, FOREIGN_ID, "the same address in the new viewing is decided again");
});

// ---------------------------------------------------------------------------
// Step 11: one rule of suitability, and the choice is the viewer's own.
// ---------------------------------------------------------------------------

const OTHER_VIEWER = "viewer-b";

test("the picture answers its own height only when it suits the viewer asking", async () => {
  // The picture is a copy whose rate nothing states, so it has no bound: a
  // measured link has nothing to compare it with. It is not handed over for
  // being the one addressed; the height is decided like any other.
  const { renditions, viewers, asked } = pictureWithSteps({ mode: "manual" });
  viewers.get("viewer-a").netReport = { linkMbps: 50, bufferedAheadSec: 30 };

  const answer = await renditions.resolveVariantSession(BASE_ID, 1080, -1, "viewer-a");

  assert.notEqual(answer?.id, BASE_ID, "the picture does not suit this viewer and is not given");
  assert.equal(asked.length, 1, "so the height is decided by the rule, which made an output for it");
});

test("two viewers of one height on different links are given different outputs, and neither moves the other", async () => {
  const { renditions, base, viewers } = pictureWithSteps({
    mode: "manual",
    // What the rule would make for each link: the fast one gets the nominal
    // limit, the slow one a lower one. Same height, same material.
    hands: (source, request) => (request.viewerLinkMbps >= 10
      ? outputOf({ id: MADE_ID, file: source, height: 720, capKbps: 2800 })
      : outputOf({ id: FOREIGN_ID, file: source, height: 720, capKbps: 1400, preset: "veryfast" }))
  });
  viewers.get("viewer-a").netReport = { linkMbps: 50, bufferedAheadSec: 30 };
  viewers.of(base, OTHER_VIEWER).qualityMode = "manual";
  viewers.get(OTHER_VIEWER).netReport = { linkMbps: 3, bufferedAheadSec: 30 };

  const fast = await renditions.resolveVariantSession(BASE_ID, 720, -1, "viewer-a");
  const slow = await renditions.resolveVariantSession(BASE_ID, 720, -1, OTHER_VIEWER);

  assert.equal(fast.id, MADE_ID);
  assert.equal(slow.id, FOREIGN_ID, "the output the fast viewer got is more than this link carries, so it is not adopted");
  assert.equal(chosenOutputOf(viewers, "viewer-a", 720), fast.outputKey, "the fast viewer's choice is unchanged");
  assert.equal(chosenOutputOf(viewers, OTHER_VIEWER, 720), slow.outputKey);
});

test("a second viewer whose link admits a shared output joins it without changing its parameters", async () => {
  const { renditions, base, viewers, asked } = pictureWithSteps({
    hands: (source) => outputOf({ id: MADE_ID, file: source, height: 720, capKbps: 1400, preset: "veryfast" })
  });
  viewers.get("viewer-a").netReport = { linkMbps: 3, bufferedAheadSec: 30 };
  viewers.of(base, OTHER_VIEWER).qualityMode = "auto";
  viewers.get(OTHER_VIEWER).netReport = { linkMbps: 3, bufferedAheadSec: 30 };

  const first = await renditions.resolveVariantSession(BASE_ID, 720, -1, "viewer-a");
  const originalSpec = first.spec;
  const originalRateControl = { ...first.spec.video.encode.rateControl };
  const second = await renditions.resolveVariantSession(BASE_ID, 720, -1, OTHER_VIEWER);

  assert.equal(first.id, MADE_ID);
  assert.equal(second, first, "a compatible existing output is shared");
  assert.equal(asked.length, 2, "both viewers ask for the same output parameters");
  assert.equal(first.spec, originalSpec, "the shared output's specification is retained");
  assert.deepEqual(first.spec.video.encode.rateControl, originalRateControl, "the second viewer cannot change its rate control");
  assert.equal(chosenOutputOf(viewers, "viewer-a", 720), first.outputKey, "the first viewer keeps the same assignment");
  assert.equal(chosenOutputOf(viewers, OTHER_VIEWER, 720), first.outputKey);
});

test("a height asked for by nobody is refused, and nothing is made for it", async () => {
  const { renditions, asked } = pictureWithSteps();

  assert.equal(await renditions.resolveVariantSession(BASE_ID, 720, -1, ""), null);
  assert.deepEqual(await renditions.resolveVariantFile(BASE_ID, 720, "segment-00000.mp4", ""), { sessionId: null });
  assert.equal(asked.length, 0);
});

test("nothing suiting the viewer is answered as unavailable, and is not recorded as their choice", async () => {
  const details = { reason: "no limit of the size picked is admitted by this viewer's link", figures: { verdict: "does not fit" } };
  const { renditions, viewers } = pictureWithSteps({ unavailable: details });

  const resolved = await renditions.resolveVariantFile(BASE_ID, 720, "segment-00000.mp4", "viewer-a", 0);

  assert.deepEqual(resolved, { sessionId: null, unavailable: details });
  assert.equal(chosenOutputOf(viewers, "viewer-a", 720), "", "an answer of nothing suits is not a choice");
});

test("an address given by an output that has gone is served from its stored piece", async () => {
  const { renditions, viewers } = pictureWithSteps({ storedPieceReady: true });
  noteGivenOutput(viewers, "viewer-a", 0, 720, 5, "gone-output-key");

  const resolved = await renditions.resolveVariantFile(BASE_ID, 720, "segment-00005.mp4", "viewer-a", 0);

  assert.deepEqual(resolved, { sessionId: null, recover: { key: "gone-output-key", likeId: BASE_ID } });
});

test("an address given by an output that has gone is lost when nothing proven compatible can stand in", async () => {
  const { renditions, viewers } = pictureWithSteps({
    hands: (source) => outputOf({ id: MADE_ID, file: source, height: 720 })
  });
  noteGivenOutput(viewers, "viewer-a", 0, 720, 5, "gone-output-key");

  const resolved = await renditions.resolveVariantFile(BASE_ID, 720, "segment-00005.mp4", "viewer-a", 0);

  assert.equal(resolved.sessionId, null, "never a piece of another output under a header it may not match");
  assert.ok(resolved.lost, "the page is told, and starts a new viewing");
});

test("an address given by an output that has gone is served by one whose header is proven compatible", async () => {
  const { renditions, viewers } = pictureWithSteps({
    hands: (source) => outputOf({ id: MADE_ID, file: source, height: 720 }),
    headersCompatible: { compatible: true, differences: [] }
  });
  noteGivenOutput(viewers, "viewer-a", 0, 720, 5, "gone-output-key");

  const resolved = await renditions.resolveVariantFile(BASE_ID, 720, "segment-00005.mp4", "viewer-a", 0);

  assert.equal(resolved.sessionId, MADE_ID);
});

test("the soundtrack a viewer's link carries is the one they chose, at that track's own rate", () => {
  const { renditions, base, viewers } = pictureWithSteps({
    audioTracks: [
      { index: 0, fileIndex: 0, sourceTrackIndex: 0, bitrateKbps: 128 },
      { index: 1, fileIndex: 0, sourceTrackIndex: 1, bitrateKbps: 640 }
    ]
  });
  viewers.get("viewer-a").audio = { trackIndex: 1, transcode: false };

  const load = renditions.viewerAudioLoadOf(base, "viewer-a");

  assert.deepEqual(load, { mbps: 0.64, peakClass: "estimated" }, "the second track's stated rate, not the first's");
});
