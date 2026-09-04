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
import assert from "node:assert/strict";
import { SourceFile } from "../services/source/SourceFile.js";
import { Timeline } from "../services/output/Timeline.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { audioRenditionKey, HlsSessionManager } from "../services/hls-session-manager.js";
import { viewerOf } from "../services/viewer/Viewer.js";
import { fmp4Format } from "../services/segment-formats/fmp4.js";
import { Output } from "../services/output/Output.js";

const BASE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const SEGMENT_SECONDS = 4;
const FIRST = "viewer-one";
const SECOND = "viewer-two";

/**
 * A session shaped like a live one, without the ffmpeg run behind it.
 *
 * @param {{ id: string, dirPath: string, audioTrackIndex?: number, transcodeAudio?: boolean }} params
 * @returns {object}
 */
function fakeSession({ id, dirPath, audioTrackIndex = 0, transcodeAudio = true }) {
  return {
    id,
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
    createEntryMs: Date.now(),
    lastAccessedAt: Date.now(),
    ffmpeg: null,
    lastError: "",
    consumers: new Set(),
    viewers: new Map(),

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

/**
 * A stand-in for a running ffmpeg: enough of a child process for the signals to
 * be recorded and for teardown to await its exit.
 *
 * @returns {{ pid: number, exitCode: number | null, signalCode: string | null, signals: string[], kill: (signal: string) => void, once: (event: string, handler: () => void) => void }}
 */
function fakeEncoder() {
  const signals = [];
  return {
    pid: 1234,
    exitCode: null,
    signalCode: null,
    signals,
    kill(signal) {
      signals.push(signal);
    },
    once(event, handler) {
      if (event === "exit") {
        handler();
      }
    }
  };
}

/**
 * A base picture serving two viewers, with its audio published separately and
 * every rendition created by a stub instead of an encoder.
 *
 * @returns {Promise<{ manager: HlsSessionManager, base: object, dirPath: string, renditions: Map<string, object> }>}
 */
async function pictureWithTwoViewers() {
  const dirPath = await mkdtemp(path.join(os.tmpdir(), "two-viewers-"));
  const manager = new HlsSessionManager({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090
  });
  const base = fakeSession({ id: BASE_ID, dirPath });
  base.audioSeparate = true;
  base.consumers = new Set([FIRST, SECOND]);
  // Both viewers are watching the picture, which is what keeps their choices
  // alive; a viewer whose head has expired holds no encoder.
  viewerOf(base, FIRST).head = { segment: 3, seconds: 12, at: Date.now() };
  viewerOf(base, SECOND).head = { segment: 3, seconds: 12, at: Date.now() };
  viewerOf(base, FIRST).audio = { trackIndex: 0, transcode: true };
  viewerOf(base, SECOND).audio = { trackIndex: 1, transcode: true };
  manager.sessionsById.set(BASE_ID, base);
  manager.getCachedAudioTracks = () => [
    { index: 0, language: "rus", title: "Дубляж", isDefault: true, fileIndex: 0, sourceTrackIndex: 0 },
    { index: 1, language: "eng", title: "", isDefault: false, fileIndex: 0, sourceTrackIndex: 1 }
  ];
  manager.getCachedMediaInfo = () => ({ height: 1080, width: 1920, durationSeconds: 400 });

  /** @type {Map<string, object>} */
  const renditions = new Map();
  manager.createOrGetSession = async (params) => {
    const key = audioRenditionKey(params.audioTrackIndex, params.transcodeAudio);
    const existing = renditions.get(key);
    if (existing) {
      return existing;
    }
    const rendition = fakeSession({
      id: `rendition-${key}`,
      dirPath,
      audioTrackIndex: params.audioTrackIndex,
      transcodeAudio: params.transcodeAudio
    });
    rendition.audioOnly = true;
    rendition.ffmpeg = fakeEncoder();
    manager.sessionsById.set(rendition.id, rendition);
    renditions.set(key, rendition);
    return rendition;
  };
  return { manager, base, dirPath, renditions };
}

test("one viewer fetching their soundtrack does not stop the other viewer's", async (t) => {
  const { manager, renditions, dirPath } = await pictureWithTwoViewers();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });

  const first = await manager.resolveAudioRenditionFile(BASE_ID, 0, "segment-00003.mp4", FIRST);
  const second = await manager.resolveAudioRenditionFile(BASE_ID, 1, "segment-00003.mp4", SECOND);

  assert.notEqual(first.sessionId, second.sessionId, "two soundtracks are two encodes");
  for (const [key, rendition] of renditions) {
    assert.ok(rendition.ffmpeg, `the encoder of ${key} is still running`);
    assert.deepEqual(rendition.ffmpeg.signals, [], `nothing signalled ${key}`);
  }

  // And it holds under the traffic that actually happens: they alternate.
  await manager.resolveAudioRenditionFile(BASE_ID, 0, "segment-00004.mp4", FIRST);
  await manager.resolveAudioRenditionFile(BASE_ID, 1, "segment-00004.mp4", SECOND);
  for (const [key, rendition] of renditions) {
    assert.deepEqual(rendition.ffmpeg?.signals ?? [], [], `nothing signalled ${key} on the second round`);
  }
});

test("a soundtrack nobody is listening to any more is stopped", async (t) => {
  const { manager, base, renditions, dirPath } = await pictureWithTwoViewers();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  // One viewer only, so what they leave is left for nobody. This is the case
  // the stop exists for: an encoder AND a reader holding pieces of the torrent.
  base.consumers = new Set([FIRST]);
  base.viewers.delete(SECOND);
  base.viewers.delete(SECOND);

  await manager.resolveAudioRenditionFile(BASE_ID, 0, "segment-00003.mp4", FIRST);
  await manager.resolveAudioRenditionFile(BASE_ID, 1, "segment-00004.mp4", FIRST);

  const left = renditions.get(audioRenditionKey(0, true));
  const moved = renditions.get(audioRenditionKey(1, true));
  assert.equal(left.ffmpeg, null, "the track the viewer left is not encoding for anybody");
  assert.ok(moved.ffmpeg, "the track they moved to is");
});

test("each viewer's browser decides for itself whether its soundtrack is re-encoded", async (t) => {
  const { manager, base, renditions, dirPath } = await pictureWithTwoViewers();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  // The same track, two browsers: one can decode it as it stands, the other
  // cannot. Answering both from the session's own flag would leave the second
  // viewer with silence.
  viewerOf(base, FIRST).audio = { trackIndex: 0, transcode: false };
  viewerOf(base, SECOND).audio = { trackIndex: 0, transcode: true };

  const copied = await manager.resolveAudioRenditionFile(BASE_ID, 0, "segment-00003.mp4", FIRST);
  const encoded = await manager.resolveAudioRenditionFile(BASE_ID, 0, "segment-00003.mp4", SECOND);

  assert.notEqual(copied.sessionId, encoded.sessionId);
  assert.equal(renditions.get(audioRenditionKey(0, false)).transcodeAudio, false);
  assert.equal(renditions.get(audioRenditionKey(0, true)).transcodeAudio, true);
  // Both are wanted, so neither is stopped.
  assert.ok(renditions.get(audioRenditionKey(0, false)).ffmpeg);
  assert.ok(renditions.get(audioRenditionKey(0, true)).ffmpeg);
});

test("the master marks each viewer's own soundtrack as the default one", async (t) => {
  const { manager, dirPath } = await pictureWithTwoViewers();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });

  const forFirst = manager.buildMasterPlaylist(BASE_ID, FIRST);
  const forSecond = manager.buildMasterPlaylist(BASE_ID, SECOND);

  const defaultsOf = (master) =>
    [...master.matchAll(/^#EXT-X-MEDIA:.*?NAME="([^"]+)".*?DEFAULT=(YES|NO)/gm)]
      .filter((match) => match[2] === "YES")
      .map((match) => match[1]);
  assert.deepEqual(defaultsOf(forFirst), ["Дубляж"]);
  assert.deepEqual(defaultsOf(forSecond).length, 1);
  assert.notDeepEqual(defaultsOf(forFirst), defaultsOf(forSecond));
});

test("one viewer changing quality does not take the other off their step", async (t) => {
  const { manager, dirPath } = await pictureWithTwoViewers();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  /** @type {Map<number, object>} */
  const variants = new Map();
  manager.createOrGetSession = async (params) => {
    const height = params.targetHeight;
    const existing = variants.get(height);
    if (existing) {
      return existing;
    }
    const variant = fakeSession({ id: `variant-${height}`, dirPath });
    variant.transcodeVideo = true;
    variant.output.encodeHeight = height;
    variant.variantHeight = height;
    variant.variantBases = new Set([BASE_ID]);
    variant.ffmpeg = fakeEncoder();
    variant.runState = "PRODUCING";
    manager.sessionsById.set(variant.id, variant);
    variants.set(height, variant);
    return variant;
  };

  await manager.resolveVariantFile(BASE_ID, 720, "segment-00003.mp4", FIRST);
  await manager.resolveVariantFile(BASE_ID, 540, "segment-00003.mp4", SECOND);
  // Both viewers go on watching their own step, which is what a player does
  // every few seconds.
  await manager.resolveVariantFile(BASE_ID, 720, "segment-00004.mp4", FIRST);
  await manager.resolveVariantFile(BASE_ID, 540, "segment-00004.mp4", SECOND);

  assert.ok(variants.get(720).ffmpeg, "the first viewer's step is still encoding");
  assert.ok(variants.get(540).ffmpeg, "and so is the second viewer's");

  // Now the first viewer steps down. Theirs is left for nobody and stops; the
  // other viewer's is untouched.
  await manager.resolveVariantFile(BASE_ID, 480, "segment-00005.mp4", FIRST);

  assert.equal(variants.get(720).ffmpeg, null, "the step nobody is on stops");
  assert.ok(variants.get(540).ffmpeg, "the step the other viewer is watching does not");
  assert.ok(variants.get(480).ffmpeg, "and the one they moved to is encoding");
});

test("a step somebody is watching is never withdrawn from the offer", async (t) => {
  const { manager, base, dirPath } = await pictureWithTwoViewers();
  t.after(async () => {
    await manager.disposeAll();
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
  variant.variantBases = new Set([BASE_ID]);
  manager.sessionsById.set(variant.id, variant);
  base.variants = new Map([[720, variant.id]]);

  // Nobody on it: measured below realtime, it is withdrawn. This half is the
  // control — without it the other half proves nothing.
  const withoutAViewer = manager.offeredHeights(base);
  assert.ok(
    !withoutAViewer.includes(720),
    `a step nobody is on and that cannot keep up is withdrawn: ${withoutAViewer.join(" ")}`
  );

  viewerOf(base, SECOND).activeVariantId = variant.id;
  const withAViewer = manager.offeredHeights(base);

  assert.ok(
    withAViewer.includes(720),
    `a step on somebody's screen stays offered, whatever it is measured at: ${withAViewer.join(" ")}`
  );
});

test("a viewer whose picture has gone quiet holds no soundtrack encoder", async (t) => {
  const { manager, base, renditions, dirPath } = await pictureWithTwoViewers();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  await manager.resolveAudioRenditionFile(BASE_ID, 0, "segment-00003.mp4", FIRST);
  await manager.resolveAudioRenditionFile(BASE_ID, 1, "segment-00003.mp4", SECOND);
  // The second viewer's tab is gone. Nothing releases the session when a
  // channel closes (roadmap item 54), so what expires is their head on the
  // picture — and with it their claim on an encoder.
  base.viewers.delete(SECOND);

  await manager.resolveAudioRenditionFile(BASE_ID, 1, "segment-00004.mp4", FIRST);

  assert.equal(
    renditions.get(audioRenditionKey(0, true)).ffmpeg,
    null,
    "the first viewer moved on, so their old track is stopped"
  );
});
