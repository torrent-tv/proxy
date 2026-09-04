/**
 * @file What a viewer is watching, and what happens to it when they leave.
 *
 * The relation "this person watches this output" is indexed both ways — the
 * output holds its viewers, the viewer holds its outputs — and these checks
 * hold the three things that go wrong when the two indexes come apart.
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

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HlsSessionManager, variantConsumerId } from "../services/hls-session-manager.js";
import { Viewers } from "../services/viewer/Viewers.js";
import { SourceFile } from "../services/source/SourceFile.js";
import { Timeline } from "../services/output/Timeline.js";
import { Output } from "../services/output/Output.js";
import { fmp4Format } from "../services/segment-formats/fmp4.js";
import { fakeProcess as fakeEncoder, startRunOn } from "./helpers/encode-run.js";

const BASE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const STEP_ID = "11111111-2222-3333-4444-555555555555";
const AUDIO_ID = "99999999-8888-7777-6666-555555555555";
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
    createEntryMs: Date.now(),
    lastAccessedAt: Date.now(),
    ffmpeg: null,
    lastError: "",
    consumers: new Set(),
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
    lastRestartAt: 0,
    seekFailureTarget: -1,
    seekFailureCount: 0,
    seekSettleTimer: null,
    seekTarget: null,
    waitEpoch: 0,
    runs: new Set(),
    viewers: new Map(),
    usesExplicitCuts: false,
    useSyntheticPlaylist: true,
    playlistText: "#EXTM3U\n",
    segmentCount: 100,
    progress: { state: "running", processedSeconds: 0, startPositionSeconds: 0, speed: "1.0x" }
  };
}

/**
 * A picture with one quality step and one separately published soundtrack, all
 * of one file, and one viewer watching all three — which is what an ordinary
 * session looks like once the viewer has picked a language and a quality.
 *
 * @returns {Promise<{ manager: HlsSessionManager, base: object, step: object,
 *   audio: object, dirPath: string, released: string[] }>}
 */
async function pictureWithStepAndSoundtrack() {
  const dirPath = await mkdtemp(path.join(os.tmpdir(), "viewer-outputs-"));
  const manager = new HlsSessionManager({
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
  base.consumers = new Set([VIEWER]);
  // The family's own claim, which is how a picture holds what it made: the
  // browser never learns these two ids.
  step.consumers = new Set([variantConsumerId(BASE_ID)]);
  audio.consumers = new Set([variantConsumerId(BASE_ID)]);
  for (const session of [base, step, audio]) {
    manager.sessionsById.set(session.id, session);
  }
  file.stepHeights.set(540, 540);
  /** @type {string[]} */
  const released = [];
  const realRelease = manager.encodeOrchestrator.release.bind(manager.encodeOrchestrator);
  manager.encodeOrchestrator.release = (claimant) => {
    released.push(claimant);
    return realRelease(claimant);
  };
  return { manager, base, step, audio, dirPath, released };
}

test("a viewer who steps down, back to the picture's own height and down again keeps their record", async (t) => {
  const { manager, base, dirPath } = await pictureWithStepAndSoundtrack();
  t.after(() => rm(dirPath, { recursive: true, force: true }));
  startRunOn(base, { process: fakeEncoder() });
  const viewer = manager.viewers.of(base, VIEWER);
  viewer.audio = { trackIndex: 1, transcode: true };
  viewer.head = { segment: 25, seconds: 100, at: Date.now() };

  await manager.resolveVariantFile(BASE_ID, 540, "segment-00025.mp4", VIEWER);
  await manager.resolveVariantFile(BASE_ID, 812, "segment-00026.mp4", VIEWER);
  await manager.resolveVariantFile(BASE_ID, 540, "segment-00027.mp4", VIEWER);

  const known = base.viewers.get(VIEWER);
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
  manager.viewers.of(base, VIEWER).head = { segment: 25, seconds: 100, at: Date.now() };
  manager.viewers.of(step, VIEWER);
  manager.viewers.of(audio, VIEWER);
  assert.deepEqual(
    [...manager.viewers.of(base, VIEWER).outputs].sort(),
    [BASE_ID, STEP_ID, AUDIO_ID].sort(),
    "one viewer, one object, and it knows all three outputs it is watching"
  );

  await manager.releaseSessionConsumer(BASE_ID, VIEWER, "the viewer left");

  assert.equal(manager.sessionsById.has(BASE_ID), false, "the picture goes with its last consumer");
  assert.equal(
    manager.sessionsById.has(STEP_ID),
    false,
    "and so does the quality step: nobody is watching it, and no one outside this class knows its id"
  );
  assert.equal(
    manager.sessionsById.has(AUDIO_ID),
    false,
    "and the soundtrack, for the same reason — it used to sit for half an hour holding an encoder, a directory and a claim on the torrent"
  );
  assert.equal(manager.viewers.size, 0, "and nobody is left in the registry, which must not be a map that only grows");
});

test("an output somebody else is still watching is kept when one viewer leaves", async (t) => {
  const { manager, base, step, audio, dirPath } = await pictureWithStepAndSoundtrack();
  t.after(() => rm(dirPath, { recursive: true, force: true }));
  const second = "viewer-two";
  base.consumers.add(second);
  manager.viewers.of(base, VIEWER).head = { segment: 25, seconds: 100, at: Date.now() };
  manager.viewers.of(step, VIEWER);
  manager.viewers.of(audio, VIEWER);
  // The second viewer is listening to the same soundtrack and watching the
  // picture at its own height.
  manager.viewers.of(base, second).head = { segment: 25, seconds: 100, at: Date.now() };
  manager.viewers.of(audio, second);

  await manager.releaseSessionConsumer(BASE_ID, VIEWER, "the first viewer left");

  assert.equal(manager.sessionsById.has(BASE_ID), true, "the picture stays: it still has a consumer");
  assert.equal(
    manager.sessionsById.has(AUDIO_ID),
    true,
    "and the soundtrack stays, because having no listeners is what kills it and it has one"
  );
  assert.equal(
    base.viewers.has(VIEWER),
    false,
    "the viewer who left is gone from the picture"
  );
  assert.equal(
    audio.viewers.has(VIEWER),
    false,
    "and from the soundtrack, which is the half of the relation the viewer holds"
  );
  assert.equal(step.viewers.size, 0, "the step they had is watched by nobody");
});

test("leaving an output releases what the watching claimed of production", async (t) => {
  const { manager, base, step, audio, dirPath, released } = await pictureWithStepAndSoundtrack();
  t.after(() => rm(dirPath, { recursive: true, force: true }));
  manager.viewers.of(base, VIEWER).head = { segment: 25, seconds: 100, at: Date.now() };
  manager.viewers.of(step, VIEWER);
  manager.viewers.of(audio, VIEWER);

  await manager.releaseSessionConsumer(BASE_ID, VIEWER, "the viewer left");

  for (const id of [BASE_ID, STEP_ID, AUDIO_ID]) {
    assert.ok(
      released.includes(`${id}:${VIEWER}`),
      `the claim on ${id.slice(0, 8)} is released — the plan's own pass cannot do it once the viewer is out of the map`
    );
  }
});

test("the two indexes of one relation are written together", () => {
  const viewers = new Viewers();
  const picture = { id: "picture" };
  const soundtrack = { id: "soundtrack" };

  const viewer = viewers.of(picture, VIEWER);
  viewers.of(soundtrack, VIEWER);
  assert.equal(viewers.of(soundtrack, VIEWER), viewer, "one person is one object, whatever they are watching");
  assert.deepEqual([...viewer.outputs].sort(), ["picture", "soundtrack"]);
  assert.equal(picture.viewers.get(VIEWER), viewer);

  viewers.leaves(soundtrack, VIEWER);
  assert.deepEqual([...viewer.outputs], ["picture"], "both directions go together");
  assert.equal(soundtrack.viewers.has(VIEWER), false);
  assert.equal(viewers.size, 1, "and the person is still known, because they are still watching something");

  viewers.leaves(picture, VIEWER);
  assert.equal(viewers.size, 0, "watching nothing, they are forgotten");
});

test("a viewer that cannot name itself belongs to the session that met it", () => {
  const viewers = new Viewers();
  const oneFilm = { id: "one" };
  const another = { id: "another" };

  const first = viewers.of(oneFilm, "");
  const second = viewers.of(another, "");
  assert.notEqual(first, second, "two anonymous viewers of two films are not one person");
  assert.equal(viewers.size, 0, "and neither is in the registry, which is keyed by a name they do not have");
});
