/**
 * @file What a viewer is watching, and what happens to it when they leave.
 *
 * The relation "this person watches this output" is stored on the viewer, and
 * these checks hold the operations that derive the opposite direction.
 *
 * 1. The viewer must never be dropped from the PICTURE. Their chosen
 *    soundtrack, their position and their step are recorded there, and the
 *    picture is the only id the browser knows. Dropping them was reachable by
 *    an ordinary sequence — down a step, back to the picture's own height, down
 *    again — and cost them the soundtrack they had picked.
 * 2. A viewer who leaves must be subtracted from EVERY output they were
 *    watching, and an output with nobody left must be let go. Nothing outside
 *    the session manager knows the id of a quality step or of a separately
 *    published soundtrack, so nothing else can ever release one.
 * 3. Whatever removes a viewer from an output must release what their watching
 *    claimed of production. The only place a claim is released is the plan's
 *    pass over the output's viewers, so a viewer deleted by any other route
 *    leaves a claim that nothing can reach.
 */

import { chooseOutput } from "../services/viewer/choices.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { wireOutputs } from "../services/server/wire-outputs.js";
import { Viewers } from "../services/viewer/Viewers.js";
import { SourceFile } from "../services/media/SourceFile.js";
import { Timeline } from "../services/encode/output/Timeline.js";
import { Output } from "../services/encode/output/Output.js";
import { fmp4Format } from "../services/encode/segment-formats/fmp4.js";
import { fakeProcess as fakeEncoder, startRunOn } from "./helpers/encode-run.js";
import { outputSpec } from "./helpers/output-spec.js";

const BASE_ID = "aaaaaaaabbbbcccc";
const STEP_ID = "1111111122223333";
const AUDIO_ID = "9999999988887777";
const VIEWER = "viewer-one";
const SEGMENT_SECONDS = 4;

/**
 * A session shaped like a live one, without the ffmpeg run behind it.
 *
 * @param {{ id: string, dirPath: string, file: SourceFile, encodeHeight?: number,
 *   audioOnly?: boolean, isStep?: boolean }} params
 * @returns {object}
 */
function fakeSession({ id, dirPath, file, encodeHeight = 0, audioOnly = false, isStep = false }) {
  return {
    id,
    spec: outputSpec({
      sourceKey: file.sourceKey,
      fileIndex: file.fileIndex,
      transcodeVideo: !audioOnly && encodeHeight > 0,
      audioOnly,
      height: encodeHeight
    }),
    dirPath,
    timeline: new Timeline({
      boundaries: Array.from({ length: 101 }, (_, index) => index * SEGMENT_SECONDS),
      cutGrid: "uniform"
    }),
    state: "ready",
    file,
    get inputFile() { return this.file; },
    get audioFile() { return this.file; },
    startedAt: Date.now(),
    lastAccessedAt: Date.now(),
    ffmpeg: null,
    lastError: "",
    segmentFormat: fmp4Format,
    transcodeVideo: !audioOnly,
    transcodeAudio: true,
    audioTrackIndex: 0,
    audioOnly,
    isStep,
    variantHeight: isStep ? encodeHeight : undefined,
    // Left set so that disposal does not remove a directory the other sessions
    // of this output are still named by.
    outputKey: `output-${id}`,
    output: new Output({
      encodeWidth: 0,
      encodeHeight,
      outputFps: 24,
      softwarePreset: null,
      applyTonemap: false
    }),
    encodeRunGeneration: 0,
    failedStartAt: -1,
    failedStartCount: 0,
    seekSettleTimer: null,
    seekTarget: null,
    waitEpoch: 0,
    runs: new Set(),
    usesExplicitCuts: false,
    useSyntheticPlaylist: true,
    playlistText: "#EXTM3U\n",
    segmentCount: 100,
    progress: { state: "running", processedSeconds: 0, startPositionSeconds: 0 }
  };
}

/**
 * A picture with one quality step and one separately published soundtrack, all
 * of one file, and one viewer watching all three — which is what an ordinary
 * session looks like once the viewer has picked a language and a quality.
 *
 * @returns {Promise<{ manager: object, base: object, step: object,
 *   audio: object, dirPath: string, released: string[] }>}
 */
async function pictureWithStepAndSoundtrack() {
  const dirPath = await mkdtemp(path.join(os.tmpdir(), "viewer-outputs-"));
  const manager = wireOutputs({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090
  });
  const file = new SourceFile({ sourceKey: "source-1", fileIndex: 0, name: "video.mkv" })
    .learn({ width: 1920, height: 1080, fps: 24, bitrateKbps: 8000 });
  const base = fakeSession({ id: BASE_ID, dirPath, file, encodeHeight: 812 });
  const step = fakeSession({ id: STEP_ID, dirPath, file, encodeHeight: 540, isStep: true });
  const audio = fakeSession({ id: AUDIO_ID, dirPath, file, audioOnly: true });
  // The browser never learns these two ids: what keeps them is who watches
  // them, and nothing else.
  for (const session of [base, step, audio]) {
    manager.outputs.set(session.id, session);
  }
  manager.outputs.markStep(step);
  return { manager, base, step, audio, dirPath };
}

test("a viewer who steps down, back to the picture's own height and down again keeps their record", async (t) => {
  const { manager, base, dirPath } = await pictureWithStepAndSoundtrack();
  t.after(() => rm(dirPath, { recursive: true, force: true }));
  startRunOn(base, { process: fakeEncoder() });
  const viewer = manager.viewers.of(base, VIEWER);
  viewer.audio = { trackIndex: 1, transcode: true };
  viewer.position = { segment: 25, seconds: 100, at: Date.now() };
  // The rule chose the step for them at 540p; the record is theirs.
  chooseOutput(manager.viewers, VIEWER, 540, manager.outputs.get(STEP_ID).outputKey);

  await manager.renditions.resolveVariantFile(BASE_ID, 540, "segment-00025.mp4", VIEWER);
  manager.renditions.viewerPlays(BASE_ID, VIEWER, 540, 100);
  await manager.renditions.resolveVariantFile(BASE_ID, 812, "segment-00026.mp4", VIEWER);
  manager.renditions.viewerPlays(BASE_ID, VIEWER, 812, 104);
  await manager.renditions.resolveVariantFile(BASE_ID, 540, "segment-00027.mp4", VIEWER);
  manager.renditions.viewerPlays(BASE_ID, VIEWER, 540, 108);

  const known = manager.viewers.forOutput(base).get(VIEWER);
  assert.ok(known, "the picture is the one id the browser holds — a viewer is never dropped from it");
  assert.deepEqual(
    known.audio,
    { trackIndex: 1, transcode: true },
    "the soundtrack they chose is recorded on the picture, and a quality switch does not touch it"
  );
  assert.equal(known.activeVariantId, STEP_ID, "and the step they moved to is where they are");
});

test("a viewer leaving is subtracted from every output, and one nobody is left watching is let go", async (t) => {
  const { manager, base, step, audio, dirPath } = await pictureWithStepAndSoundtrack();
  t.after(() => rm(dirPath, { recursive: true, force: true }));
  // Watching all three, which is what a viewer who picked a language and a
  // quality is doing.
  manager.viewers.of(base, VIEWER).position = { segment: 25, seconds: 100, at: Date.now() };
  manager.viewers.of(step, VIEWER);
  manager.viewers.of(audio, VIEWER);
  assert.deepEqual(
    [...manager.viewers.of(base, VIEWER).outputs].sort(),
    [BASE_ID, STEP_ID, AUDIO_ID].sort(),
    "one viewer, one object, and it knows all three outputs it is watching"
  );

  await manager.lifecycle.releaseSessionConsumer(BASE_ID, VIEWER, "the viewer left");

  assert.equal(manager.outputs.has(BASE_ID), false, "the picture goes with its last consumer");
  assert.equal(
    manager.outputs.has(STEP_ID),
    false,
    "and so does the quality step: nobody is watching it, and no one outside this class knows its id"
  );
  assert.equal(
    manager.outputs.has(AUDIO_ID),
    false,
    "and the soundtrack, for the same reason — it used to sit for half an hour holding an encoder, a directory and a claim on the torrent"
  );
  assert.equal(manager.viewers.size, 0, "and nobody is left in the registry, which must not be a map that only grows");
});

test("an output somebody else is still watching is kept when one viewer leaves", async (t) => {
  const { manager, base, step, audio, dirPath } = await pictureWithStepAndSoundtrack();
  t.after(() => rm(dirPath, { recursive: true, force: true }));
  const second = "viewer-two";
  manager.viewers.of(base, VIEWER).position = { segment: 25, seconds: 100, at: Date.now() };
  manager.viewers.of(step, VIEWER);
  manager.viewers.of(audio, VIEWER);
  // The second viewer is listening to the same soundtrack and watching the
  // picture at its own height.
  manager.viewers.of(base, second).position = { segment: 25, seconds: 100, at: Date.now() };
  manager.viewers.of(audio, second);

  await manager.lifecycle.releaseSessionConsumer(BASE_ID, VIEWER, "the first viewer left");

  assert.equal(manager.outputs.has(BASE_ID), true, "the picture stays: it still has a consumer");
  assert.equal(
    manager.outputs.has(AUDIO_ID),
    true,
    "and the soundtrack stays, because having no listeners is what kills it and it has one"
  );
  assert.equal(
    manager.viewers.forOutput(base).has(VIEWER),
    false,
    "the viewer who left is gone from the picture"
  );
  assert.equal(
    manager.viewers.forOutput(audio).has(VIEWER),
    false,
    "and from the soundtrack, which is the half of the relation the viewer holds"
  );
  assert.equal(manager.viewers.forOutput(step).size, 0, "the step they had is watched by nobody");
});

test("nothing is left wanting production once the last viewer has left", async (t) => {
  const { manager, base, step, audio, dirPath } = await pictureWithStepAndSoundtrack();
  t.after(() => rm(dirPath, { recursive: true, force: true }));
  manager.viewers.of(base, VIEWER).position = { segment: 25, seconds: 100, at: Date.now() };
  manager.viewers.of(step, VIEWER);
  manager.viewers.of(audio, VIEWER);

  await manager.lifecycle.releaseSessionConsumer(BASE_ID, VIEWER, "the viewer left");

  // NOTHING HAS TO BE RELEASED, and that is the point of the shape. A claim per
  // viewer per output used to be held in the encoding layer and taken back one
  // by one when they left — the viewer's own name as the key of a claim, which
  // is the coupling the layer rule forbids. What the plan is given now is a map
  // with nobody's name in it, rebuilt from whoever is watching; a viewer who has
  // left is simply not in the next one.
  for (const id of [BASE_ID, STEP_ID, AUDIO_ID]) {
    const session = manager.outputs.get(id);
    assert.equal(session, undefined, `${id.slice(0, 8)} is let go with its last viewer`);
  }
  manager.encodeRuns.planEncodersNow();
  for (const address of [base.outputKey, step.outputKey, audio.outputKey]) {
    assert.deepEqual(
      manager.encodeOrchestrator.wantedSegmentsOn(address),
      [],
      "and no output is left asking for an encoder"
    );
  }
});

test("the reverse view is derived from the relation stored on the viewer", () => {
  const viewers = new Viewers();
  const picture = { id: "picture" };
  const soundtrack = { id: "soundtrack" };

  const viewer = viewers.of(picture, VIEWER);
  viewers.of(soundtrack, VIEWER);
  assert.equal(viewers.of(soundtrack, VIEWER), viewer, "one person is one object, whatever they are watching");
  assert.deepEqual([...viewer.outputs].sort(), ["picture", "soundtrack"]);
  assert.equal(viewers.forOutput(picture).get(VIEWER), viewer);

  viewers.leaves(soundtrack, VIEWER);
  assert.deepEqual([...viewer.outputs], ["picture"], "the stored relation changes once");
  assert.equal(viewers.forOutput(soundtrack).has(VIEWER), false);
  assert.equal(viewers.size, 1, "and the person is still known, because they are still watching something");

  viewers.leaves(picture, VIEWER);
  assert.equal(viewers.size, 0, "watching nothing, they are forgotten");
});

test("a request that names nobody makes no viewer", () => {
  // A nameless viewer used to belong to whichever output met it: the same
  // person was a different object on each output, and two nameless people on
  // one output were one object. Every viewer has a name now.
  const viewers = new Viewers();
  const oneFilm = { id: "one" };

  assert.throws(() => viewers.of(oneFilm, ""), TypeError);
  assert.equal(viewers.size, 0, "nothing was registered");
  assert.equal(viewers.forOutput(oneFilm).size, 0, "and nobody watches the output");
  assert.equal(viewers.getForOutput(oneFilm, ""), null);
});
