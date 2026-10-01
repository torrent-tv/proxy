/**
 * @file Two viewers of one picture, each with their own soundtrack.
 *
 * Measured 2026-09-03 (`research/two-viewers-one-file-2026-09-03.md`): two
 * browsers on one copied file got two picture sessions with byte-identical
 * output, because the key carried the soundtrack a picture without sound does
 * not have. Once they share one picture, everything about the sound that used
 * to be a field of the session has to be a fact about a viewer — otherwise they
 * switch each other's soundtrack off, once per segment, for the whole film.
 */

import test from "node:test";
import { fakeProcess as fakeEncoder, startRunOn } from "./helpers/encode-run.js";

/**
 * Whether anything of this session is encoding.
 *
 * A session holds a SET of runs, so the question is about the set and not about
 * a field: a run told to stop is not encoding, whatever its process is still
 * doing about the signal.
 *
 * @param {object} session
 * @returns {boolean}
 */
function encoding(manager, output) {
  return manager.encodeOrchestrator.runsOn(output?.outputKey ?? "").some((run) => run.isAlive);
}
/**
 * Whether anybody is still watching this output.
 *
 * WHAT REPLACED "ITS ENCODER WAS KILLED HERE". Leaving an output is a fact
 * about a viewer; whether an encoder on it should go on running is the same
 * question as where encoders belong, and one party answers that — an output
 * with nobody on it has a priority map with nothing in it, and the plan stops
 * what is on it (`encode-plan.test.js`, "every encoder stops when nobody is
 * watching the output"; `priority-map-per-output.test.js` for the map).
 *
 * Answered here as well, the two fought: this class killed the run, and the
 * viewer's own move — which announces itself — had the plan start it again on
 * the very next pass, several times a second.
 *
 * @param {object} session
 * @returns {boolean}
 */
function watched(manager, session) {
  return session ? manager.viewers.forOutput(session).size > 0 : false;
}

import assert from "node:assert/strict";
import { SourceFile } from "../services/media/SourceFile.js";
import { Timeline } from "../services/encode/output/Timeline.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { audioRenditionKey } from "../services/encode/Renditions.js";
import { managerWithOwnStore } from "./helpers/manager.js";
import { fmp4Format } from "../services/encode/segment-formats/fmp4.js";
import { Output } from "../services/encode/output/Output.js";
import { outputSpec } from "./helpers/output-spec.js";

const BASE_ID = "aaaaaaaabbbbcccc";
const SEGMENT_SECONDS = 4;
const FIRST = "viewer-one";
const SECOND = "viewer-two";

/**
 * A session shaped like a live one, without the ffmpeg run behind it.
 *
 * @param {{ id: string, dirPath: string, audioTrackIndex?: number, transcodeAudio?: boolean, audioOnly?: boolean, audioSeparate?: boolean }} params
 * @returns {object}
 */
function fakeSession({
  id,
  dirPath,
  audioTrackIndex = 0,
  transcodeAudio = true,
  audioOnly = false,
  audioSeparate = false,
  // THE SIZE IS PART OF THE IDENTITY, so two steps of different sizes are two
  // addresses. Left out, every step of this fixture shared one key and the
  // record of which output answers a height could not tell them apart — which
  // is the fixture describing something production does not do, not a rule
  // being too strict.
  encodeHeight = 0
}) {
  return {
    id,
    spec: outputSpec({
      transcodeVideo: !audioOnly,
      transcodeAudio,
      audioOnly,
      audioSeparate,
      audioSourceTrackIndex: audioTrackIndex,
      height: encodeHeight,
      width: encodeHeight > 0 ? Math.round((encodeHeight * 16) / 9) : 0
    }),
    get outputKey() { return this.spec.toKey(); },
    dirPath,
    // Where this file is cut, held by the file. A fixture that stated it
    // on the session was describing what production no longer does.
    timeline: new Timeline({
      boundaries: Array.from({ length: 101 }, (_, index) => index * SEGMENT_SECONDS),
      cutGrid: "keyframe"
    }),
    state: "ready",
    file: new SourceFile({ sourceKey: "torrent:abc", fileIndex: 0, name: "video.mkv" }).learn({ width: 1920, height: 1080 }),
    // An ordinary session reads its own file, and its sound is inside it. The
    // three differ only for a soundtrack shipped as a file of its own.
    get inputFile() { return this.file; },
    get audioFile() { return this.file; },
    startedAt: Date.now(),
    lastAccessedAt: Date.now(),
    ffmpeg: null,
    lastError: "",

    segmentFormat: fmp4Format,
    transcodeVideo: false,
    transcodeAudio,
    audioTrackIndex,
    audioSourceTrackIndex: audioTrackIndex,
    // The shape this output is encoded AS, decided once for the output.
    output: new Output({
      encodeWidth: 0,
      encodeHeight: 0,
      outputFps: 24,
      softwarePreset: null,
      applyTonemap: false
    }),
    encodeRunGeneration: 0,
    encodeStartIndex: 0,
    waitEpoch: 0,
    useSyntheticPlaylist: true,
    playlistText: "#EXTM3U\n",
    segmentCount: 100,
    progress: { state: "running", processedSeconds: 0, startPositionSeconds: 0, speed: "1.0x" }
  };
}

function startManagedRun(manager, output, options = {}) {
  const run = startRunOn(output, options);
  manager.encodeOrchestrator.adopt(output.outputKey, run);
  return run;
}


/**
 * A base picture serving two viewers, with its audio published separately and
 * every rendition created by a stub instead of an encoder.
 *
 * @returns {Promise<{ manager: object, base: object, dirPath: string, renditions: Map<string, object> }>}
 */
async function pictureWithTwoViewers() {
  const dirPath = await mkdtemp(path.join(os.tmpdir(), "two-viewers-"));
  // Its own store root — see `helpers/manager.js` for what sharing one cost.
  const { manager } = managerWithOwnStore();
  // These checks cover ownership changes made by viewer requests. Encoder
  // placement is covered by the plan tests and must not run asynchronously in
  // the middle of an assertion about the request path.
  manager.encodeRuns.planEncodersSoon = () => {};
  const base = fakeSession({ id: BASE_ID, dirPath, audioSeparate: true });
  // Both viewers are watching the picture, which is what keeps their choices
  // alive; a viewer whose head has expired holds no encoder.
  manager.viewers.of(base, FIRST).position = { segment: 3, seconds: 12, at: Date.now() };
  manager.viewers.of(base, SECOND).position = { segment: 3, seconds: 12, at: Date.now() };
  manager.viewers.of(base, FIRST).audio = { trackIndex: 0, transcode: true };
  manager.viewers.of(base, SECOND).audio = { trackIndex: 1, transcode: true };
  manager.outputs.set(BASE_ID, base);
  manager.getCachedAudioTracks = () => [
    { index: 0, language: "rus", title: "Дубляж", isDefault: true, fileIndex: 0, sourceTrackIndex: 0 },
    { index: 1, language: "eng", title: "", isDefault: false, fileIndex: 0, sourceTrackIndex: 1 }
  ];
  manager.getCachedMediaInfo = () => ({ height: 1080, width: 1920, durationSeconds: 400 });

  /** @type {Map<string, object>} */
  const renditions = new Map();
  manager.viewerRequests.createOrGetSession = async (params) => {
    const key = audioRenditionKey(params.audioTrackIndex, params.transcodeAudio);
    const existing = renditions.get(key);
    if (existing) {
      return existing;
    }
    const rendition = fakeSession({
      id: `rendition-${key}`,
      dirPath,
      audioTrackIndex: params.audioTrackIndex,
      transcodeAudio: params.transcodeAudio,
      audioOnly: true
    });
    rendition.id = rendition.spec.toName();
    startManagedRun(manager, rendition, { process: fakeEncoder() });
    manager.outputs.set(rendition.id, rendition);
    renditions.set(key, rendition);
    return rendition;
  };
  return { manager, base, dirPath, renditions };
}

test("one viewer fetching their soundtrack does not stop the other viewer's", async (t) => {
  const { manager, renditions, dirPath } = await pictureWithTwoViewers();
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });

  const first = await manager.renditions.resolveAudioRenditionFile(BASE_ID, 0, "segment-00003.mp4", FIRST);
  const second = await manager.renditions.resolveAudioRenditionFile(BASE_ID, 1, "segment-00003.mp4", SECOND);

  assert.notEqual(first.sessionId, second.sessionId, "two soundtracks are two encodes");
  for (const [key, rendition] of renditions) {
    assert.ok([...rendition.runs][0]?.process, `the encoder of ${key} is still running`);
    assert.deepEqual([...rendition.runs][0].process.signals, [], `nothing signalled ${key}`);
  }

  // And it holds under the traffic that actually happens: they alternate.
  await manager.renditions.resolveAudioRenditionFile(BASE_ID, 0, "segment-00004.mp4", FIRST);
  await manager.renditions.resolveAudioRenditionFile(BASE_ID, 1, "segment-00004.mp4", SECOND);
  for (const [key, rendition] of renditions) {
    assert.deepEqual([...rendition.runs][0]?.process?.signals ?? [], [], `nothing signalled ${key} on the second round`);
  }
});

test("a soundtrack nobody is listening to any more is let go of", async (t) => {
  const { manager, base, renditions, dirPath } = await pictureWithTwoViewers();
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  // One viewer only, so what they leave is left for nobody. This is the case
  // the stop exists for: an encoder AND a reader holding pieces of the torrent.
  manager.viewers.leaves(base, SECOND);

  await manager.renditions.resolveAudioRenditionFile(BASE_ID, 0, "segment-00003.mp4", FIRST);
  await manager.renditions.resolveAudioRenditionFile(BASE_ID, 1, "segment-00004.mp4", FIRST);

  const left = renditions.get(audioRenditionKey(0, true));
  const moved = renditions.get(audioRenditionKey(1, true));
  assert.equal(watched(manager, left), false, "the track the viewer left is nobody's now");
  assert.ok(watched(manager, moved), "and the track they moved to is theirs");
  assert.deepEqual(
    [...left.runs][0]?.process?.signals ?? [],
    [],
    "and it is not killed from here, which is what the plan then undid"
  );
});

test("each viewer's browser decides for itself whether its soundtrack is re-encoded", async (t) => {
  const { manager, base, renditions, dirPath } = await pictureWithTwoViewers();
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  // The same track, two browsers: one can decode it as it stands, the other
  // cannot. Answering both from the session's own flag would leave the second
  // viewer with silence.
  manager.viewers.of(base, FIRST).audio = { trackIndex: 0, transcode: false };
  manager.viewers.of(base, SECOND).audio = { trackIndex: 0, transcode: true };

  const copied = await manager.renditions.resolveAudioRenditionFile(BASE_ID, 0, "segment-00003.mp4", FIRST);
  const encoded = await manager.renditions.resolveAudioRenditionFile(BASE_ID, 0, "segment-00003.mp4", SECOND);

  assert.notEqual(copied.sessionId, encoded.sessionId);
  assert.equal(renditions.get(audioRenditionKey(0, false)).transcodeAudio, false);
  assert.equal(renditions.get(audioRenditionKey(0, true)).transcodeAudio, true);
  // Both are wanted, so neither is stopped.
  assert.ok(encoding(manager, renditions.get(audioRenditionKey(0, false))));
  assert.ok(encoding(manager, renditions.get(audioRenditionKey(0, true))));
});

test("the master marks each viewer's own soundtrack as the default one", async (t) => {
  const { manager, dirPath } = await pictureWithTwoViewers();
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });

  const forFirst = manager.renditions.buildMasterPlaylist(BASE_ID, FIRST);
  const forSecond = manager.renditions.buildMasterPlaylist(BASE_ID, SECOND);

  const defaultsOf = (master) =>
    [...master.matchAll(/^#EXT-X-MEDIA:.*?NAME="([^"]+)".*?DEFAULT=(YES|NO)/gm)]
      .filter((match) => match[2] === "YES")
      .map((match) => match[1]);
  assert.deepEqual(defaultsOf(forFirst), ["Дубляж"]);
  assert.deepEqual(defaultsOf(forSecond).length, 1);
  assert.notDeepEqual(defaultsOf(forFirst), defaultsOf(forSecond));
});

test("one viewer changing quality does not take the other off their step", async (t) => {
  const { manager, base, dirPath } = await pictureWithTwoViewers();
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  /** @type {Map<number, object>} */
  const variants = new Map();
  manager.viewerRequests.createOrGetSession = async (params) => {
    const height = params.targetHeight;
    const existing = variants.get(height);
    if (existing) {
      return existing;
    }
    // A STEP CARRIES WHAT ITS PICTURE CARRIES. This picture publishes its
    // soundtrack separately, so its steps do too — which is what production
    // passes (`audioRenditions: servesAudioSeparately(base)`). Built muxed, a
    // step is not the same material as the picture it is a step of, and is
    // rightly refused.
    const variant = fakeSession({ id: `variant-${height}`, dirPath, encodeHeight: height, audioSeparate: true });
    variant.transcodeVideo = true;
    variant.output.encodeHeight = height;
    variant.variantHeight = height;
    variant.isStep = true;
    manager.outputs.markStep(variant);
    variant.file = base.file;
    startManagedRun(manager, variant, { process: fakeEncoder() });
    manager.outputs.set(variant.id, variant);
    variants.set(height, variant);
    return variant;
  };

  await manager.renditions.resolveVariantFile(BASE_ID, 720, "segment-00003.mp4", FIRST);
  manager.renditions.viewerPlays(BASE_ID, FIRST, 720, 12);
  await manager.renditions.resolveVariantFile(BASE_ID, 540, "segment-00003.mp4", SECOND);
  manager.renditions.viewerPlays(BASE_ID, SECOND, 540, 12);
  // Both viewers go on watching their own step, which is what a player does
  // every few seconds.
  await manager.renditions.resolveVariantFile(BASE_ID, 720, "segment-00004.mp4", FIRST);
  await manager.renditions.resolveVariantFile(BASE_ID, 540, "segment-00004.mp4", SECOND);

  assert.ok(encoding(manager, variants.get(720)), "the first viewer's step is still encoding");
  assert.ok(encoding(manager, variants.get(540)), "and so is the second viewer's");

  // Now the first viewer steps down. Theirs is left for nobody and stops; the
  // other viewer's is untouched.
  await manager.renditions.resolveVariantFile(BASE_ID, 480, "segment-00005.mp4", FIRST);
  manager.renditions.viewerPlays(BASE_ID, FIRST, 480, 20);

  assert.equal(watched(manager, variants.get(720)), false, "the step nobody is on is nobody's");
  assert.ok(watched(manager, variants.get(540)), "the step the other viewer is watching stays theirs");
  assert.ok(watched(manager, variants.get(480)), "and the one they moved to is now theirs");
  assert.ok(encoding(manager, variants.get(540)), "and nothing here touched the other viewer's encoder");
});

test("a step somebody is watching is never withdrawn from the offer", async (t) => {
  const { manager, base, dirPath } = await pictureWithTwoViewers();
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  // A host that can re-encode 240p and nothing above it — the shape of the
  // field case of 2026-08-15.
  base.output.encodeHeight = 1080;
  base.variantHeight = 1080;
  manager.softwarePresetBenchmark = [{ preset: "ultrafast", pixelsPerSec: 12_000_000 }];
  manager.decodeCostModel = { pixelTerm: 0.00793, bitrateTerm: 0, constantTerm: 0 };
  // 1080p24 at 8 Mbit/s, stated as the file's own facts — what decoding costs
  // is derived from them.
  base.file.learn({ width: 1920, height: 1080, fps: 24, bitrateKbps: 8000 });

  const variant = fakeSession({ id: "variant-720", dirPath });
  variant.transcodeVideo = true;
  variant.output.encodeHeight = 720;
  variant.variantHeight = 720;
  // One file, two sessions of it.
  variant.file = base.file;
  variant.isStep = true;
  manager.outputs.markStep(variant);
  variant.file = base.file;
  manager.outputs.set(variant.id, variant);

  // Nobody on it: measured below realtime, it is withdrawn. This half is the
  // control — without it the other half proves nothing.
  const withoutAViewer = manager.quality.offeredHeights(base);
  assert.ok(
    !withoutAViewer.includes(720),
    `a step nobody is on and that cannot keep up is withdrawn: ${withoutAViewer.join(" ")}`
  );

  manager.viewers.of(base, SECOND).activeVariantId = variant.id;
  const withAViewer = manager.quality.offeredHeights(base);

  assert.ok(
    withAViewer.includes(720),
    `a step on somebody's screen stays offered, whatever it is measured at: ${withAViewer.join(" ")}`
  );
});

test("a viewer whose picture has gone quiet holds no soundtrack encoder", async (t) => {
  const { manager, base, renditions, dirPath } = await pictureWithTwoViewers();
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  await manager.renditions.resolveAudioRenditionFile(BASE_ID, 0, "segment-00003.mp4", FIRST);
  await manager.renditions.resolveAudioRenditionFile(BASE_ID, 1, "segment-00003.mp4", SECOND);
  // The second viewer's tab is gone. Nothing releases the session when a
  // channel closes (roadmap item 54), so what expires is their head on the
  // picture — and with it their claim on an encoder.
  manager.viewers.leaves(base, SECOND);

  await manager.renditions.resolveAudioRenditionFile(BASE_ID, 1, "segment-00004.mp4", FIRST);

  assert.equal(
    watched(manager, renditions.get(audioRenditionKey(0, true))),
    false,
    "the first viewer moved on, so their old track is nobody's"
  );
});

/**
 * The soundtracks of the field case of 2026-10-01: the picture's own track
 * states its rate, and the dub shipped beside it states nothing.
 *
 * @param {object} manager
 * @param {{ dubRate?: number | null }} [what]
 */
function withAStatedAndASilentTrack(manager, { dubRate = null } = {}) {
  const inventory = [
    { index: 0, language: "jpn", title: "", isDefault: true, fileIndex: 0, sourceTrackIndex: 0, bitrateKbps: 128 },
    { index: 1, language: "rus", title: "", isDefault: false, fileIndex: 0, sourceTrackIndex: 1, bitrateKbps: dubRate }
  ];
  manager.getCachedAudioTracks = () => inventory;
  return inventory;
}

test("a track nothing states a rate for is sent as AAC even to a browser that plays it, and another viewer's copy is left alone", async (t) => {
  const { manager, base, renditions, dirPath } = await pictureWithTwoViewers();
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  withAStatedAndASilentTrack(manager);
  manager.viewers.of(base, FIRST).audio = { trackIndex: 0, transcode: false };
  manager.viewers.of(base, SECOND).audio = { trackIndex: 0, transcode: false };
  const copy = await manager.renditions.resolveAudioRenditionFile(BASE_ID, 0, "segment-00003.mp4", FIRST);

  // The second viewer's page says its browser plays the dub as it is.
  const prepared = await manager.renditions.prepareAudioTrack(BASE_ID, 1, 12, SECOND, true);
  const sent = await manager.renditions.resolveAudioRenditionFile(BASE_ID, 1, "segment-00003.mp4", SECOND);

  assert.equal(prepared.sessionId, renditions.get(audioRenditionKey(1, true)).id, "prepared as AAC");
  assert.equal(sent.sessionId, prepared.sessionId, "and its segments come from that same output");
  assert.deepEqual(
    manager.viewers.of(base, SECOND).audio,
    { trackIndex: 1, transcode: true },
    "the viewer is recorded as receiving what they are sent"
  );
  assert.equal(
    (await manager.renditions.resolveAudioRenditionFile(BASE_ID, 0, "segment-00004.mp4", FIRST)).sessionId,
    copy.sessionId,
    "the other viewer's copy is the same output it was"
  );
  assert.deepEqual(manager.viewers.of(base, FIRST).audio, { trackIndex: 0, transcode: false });
});

test("the page's statement about the track it moves to decides, and silence keeps what it needed before", async (t) => {
  const { manager, base, renditions, dirPath } = await pictureWithTwoViewers();
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  withAStatedAndASilentTrack(manager, { dubRate: 192 });
  manager.viewers.of(base, FIRST).audio = { trackIndex: 0, transcode: false };
  manager.viewers.of(base, SECOND).audio = { trackIndex: 0, transcode: false };

  await manager.renditions.prepareAudioTrack(BASE_ID, 1, 12, FIRST, false);
  await manager.renditions.prepareAudioTrack(BASE_ID, 1, 12, SECOND, null);

  assert.ok(renditions.has(audioRenditionKey(1, true)), "a browser that cannot play it gets AAC");
  assert.ok(renditions.has(audioRenditionKey(1, false)), "one that says nothing is taken to play it, as it played the track it was on");
});

test("the soundtrack's load counts what is sent, not a figure learned after it was chosen", async (t) => {
  const { manager, base, dirPath } = await pictureWithTwoViewers();
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  const inventory = withAStatedAndASilentTrack(manager);
  manager.viewers.of(base, SECOND).audio = { trackIndex: 0, transcode: false };
  await manager.renditions.prepareAudioTrack(BASE_ID, 1, 12, SECOND, true);
  await manager.renditions.resolveAudioRenditionFile(BASE_ID, 1, "segment-00003.mp4", SECOND);

  // The dub's header arrives late and states a bound after all.
  inventory[1].peakKbps = 576;

  assert.deepEqual(
    manager.renditions.viewerAudioLoadOf(base, SECOND),
    { mbps: 0.128, peakClass: "estimated" },
    "still the AAC being sent, not a copy nobody is receiving"
  );
});

test("a copied track's codec bound reaches the link's question through the viewer's choice", async (t) => {
  const { manager, base, dirPath } = await pictureWithTwoViewers();
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  const inventory = withAStatedAndASilentTrack(manager);
  inventory[0].peakKbps = 576;
  manager.viewers.of(base, FIRST).audio = { trackIndex: 0, transcode: false };

  assert.deepEqual(manager.renditions.viewerAudioLoadOf(base, FIRST), { mbps: 0.576, peakClass: "known" });
});
