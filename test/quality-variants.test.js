/**
 * @file Quality variants: the master playlist, and what happens when the viewer
 * moves between rungs.
 *
 * What makes a mid-stream change of quality possible at all is that every
 * variant is cut at the SAME times, so a segment produced by one encoder can be
 * appended where another encoder's would have gone. The last test here pins
 * that property at its source; the rest cover the wiring that a route reaches —
 * a module test that imports a function directly cannot see a caller that never
 * calls it (2.9.124).
 */

import test from "node:test";
import { fakeProcess as fakeEncoder, startRunOn } from "./helpers/encode-run.js";
import assert from "node:assert/strict";
import { SourceFile } from "../services/source/SourceFile.js";
import { Timeline } from "../services/output/Timeline.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  computeSegmentBoundaries,
  costKindForSession,
  HlsSessionManager
} from "../services/hls-session-manager.js";
import { fmp4Format } from "../services/segment-formats/fmp4.js";
import { Output } from "../services/output/Output.js";
import { viewerOf } from "../services/viewer/Viewer.js";

const BASE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const VARIANT_ID = "11111111-2222-3333-4444-555555555555";
const SECOND_VARIANT_ID = "99999999-8888-7777-6666-555555555555";
const SEGMENT_SECONDS = 4;

/**
 * A session shaped like a live one, without the ffmpeg run behind it.
 *
 * @param {{ id: string, encodeHeight: number, dirPath: string, transcodeVideo?: boolean }} params
 * @returns {object}
 */
function fakeSession({ id, encodeHeight, dirPath, transcodeVideo = true }) {
  return {
    id,
    dirPath,
    // Where this file is cut, held by the file. A fixture that stated it
    // on the session was describing what production no longer does.
    timeline: new Timeline({
      boundaries: Array.from({ length: 101 }, (_, index) => index * SEGMENT_SECONDS),
      cutGrid: "uniform"
    }),
    state: "ready",
    // The file's own facts, which is where the size and what decoding it costs
    // both come from: 1080p24 at 8 Mbit/s, the field file of 2026-08-17. A
    // fixture that assigned a cost object instead was stating an answer the
    // file now derives, so nothing it said reached the arithmetic.
    file: new SourceFile({ sourceKey: "source-1", fileIndex: 0, name: "video.mkv" }).learn({
      width: 1920,
      height: 1080,
      fps: 24,
      bitrateKbps: 8000
    }),
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
    segmentFormat: fmp4Format,
    transcodeVideo,
    transcodeAudio: true,
    audioTrackIndex: 0,
    // The shape this output is encoded AS, decided once for the output rather
    // than once per session.
    output: new Output({ encodeWidth: 0, encodeHeight, outputFps: 24, softwarePreset: null, applyTonemap: false }),
    encodeRunGeneration: 0,
    lastRestartAt: 0,
    seekFailureTarget: -1,
    seekFailureCount: 0,
    seekSettleTimer: null,
    seekTarget: null,
    waitEpoch: 0,
    viewers: new Map(),
    usesExplicitCuts: false,
    useSyntheticPlaylist: true,
    playlistText: "#EXTM3U\n",
    segmentCount: 100,
    progress: { state: "running", processedSeconds: 0, startPositionSeconds: 0, speed: "1.0x" }
  };
}


/**
 * @returns {Promise<{ manager: HlsSessionManager, base: object, dirPath: string }>}
 */
async function managerWithBase() {
  const dirPath = await mkdtemp(path.join(os.tmpdir(), "quality-variants-"));
  const manager = new HlsSessionManager({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090
  });
  // 812p is what a viewport-sized budget actually produces — deliberately not a
  // ladder rung, because that is the case the master has to carry.
  const base = fakeSession({ id: BASE_ID, encodeHeight: 812, dirPath });
  manager.sessionsById.set(BASE_ID, base);
  return { manager, base, dirPath };
}

test("the master offers every rung, the session's own height among them", async (t) => {
  const { manager, dirPath } = await managerWithBase();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });

  const master = manager.buildMasterPlaylist(BASE_ID);

  assert.ok(master, "a re-encoded 1080p source has rungs to choose between");
  const heights = [...master.matchAll(/^v\/(\d+)\/index\.m3u8$/gm)].map((match) => Number(match[1]));
  assert.deepEqual(
    heights,
    [1080, 812, 720, 540, 480, 360, 240],
    "the source height, the height already being encoded, and the rungs below it, largest first"
  );
  assert.match(master, /^#EXT-X-VERSION:7$/m, "the version the segment format requires");
  assert.match(master, /RESOLUTION=1280x720/, "each variant states the size it decodes to");
  assert.ok(
    !master.includes("2160"),
    "a rung above the source would be upscaling — invented detail at a higher cost than the source"
  );
});

test("audio is published once for the file, and every rung points at it", async (t) => {
  const { manager, base, dirPath } = await managerWithBase();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  // The inventory the plan already probed — the same list the browser's audio
  // menu is built from.
  manager.getCachedAudioTracks = () => [
    { index: 0, language: "rus", title: "Дубляж", isDefault: true },
    { index: 1, language: "eng", title: "", isDefault: false }
  ];
  // Settled at creation in production; set here directly, since this test
  // builds its session by hand.
  base.audioSeparate = true;
  base.audioTrackIndex = 1;

  const master = manager.buildMasterPlaylist(BASE_ID);

  assert.match(
    master,
    /#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Дубляж",LANGUAGE="ru",AUTOSELECT=YES,DEFAULT=NO,URI="a\/0\/index\.m3u8"/,
    "a track with a title is named by it"
  );
  assert.match(
    master,
    /#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="eng",LANGUAGE="en",AUTOSELECT=YES,DEFAULT=YES,URI="a\/1\/index\.m3u8"/,
    "the track the session was created with is the default one, and an untitled track is named by its language"
  );
  const streams = [...master.matchAll(/^#EXT-X-STREAM-INF:.*$/gm)].map((match) => match[0]);
  assert.equal(streams.length, 7, "every rung");
  assert.ok(
    streams.every((line) => line.includes('AUDIO="aud"')),
    "each rung plays with the shared audio rather than carrying its own"
  );
});

test("a session that did not ask for renditions gets audio in its stream, as before", async (t) => {
  const { manager, dirPath } = await managerWithBase();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  manager.getCachedAudioTracks = () => [{ index: 0, language: "rus", title: "", isDefault: true }];

  const master = manager.buildMasterPlaylist(BASE_ID);

  assert.ok(!master.includes("EXT-X-MEDIA"), "a browser that does not know about renditions is not sent any");
  assert.ok(!master.includes("AUDIO="), "and its rungs still carry their own audio");
});

test("a copied video is offered variants when its cut grid is real", async (t) => {
  const { manager, base, dirPath } = await managerWithBase();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  // A copy is cut at the source's own keyframes — it has no other choice. A
  // re-encoded rung CAN be cut there too, by being told those times, and then
  // its segments cover the same spans and can stand in the copy's place.
  base.transcodeVideo = false;
  base.timeline = new Timeline({ boundaries: base.timeline?.boundaries ?? [], cutGrid: "keyframe" });

  const master = manager.buildMasterPlaylist(BASE_ID);

  assert.ok(master, "the obstacle was never the encoder, it was the cut points");
  assert.match(master, /^v\/1080\/index\.m3u8$/m, "the copy itself is the top rung — no encoder, no cost");
  assert.match(master, /^v\/540\/index\.m3u8$/m);
});

test("a copied video with no readable keyframe index is offered nothing", async (t) => {
  const { manager, base, dirPath } = await managerWithBase();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  // Its playlist claims an even grid that ffmpeg does not cut on. Aligning a
  // rung to that is aligning it to a fiction.
  base.transcodeVideo = false;
  base.timeline = new Timeline({ boundaries: base.timeline?.boundaries ?? [], cutGrid: "uniform" });

  assert.equal(manager.buildMasterPlaylist(BASE_ID), null);
});

test("the session's own height resolves to the session itself", async (t) => {
  const { manager, dirPath } = await managerWithBase();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });

  assert.deepEqual(
    await manager.resolveVariantFile(BASE_ID, 812, "segment-00000.mp4"),
    { sessionId: BASE_ID },
    "an encoder is already producing this height; making a second one would be a cold start for nothing"
  );
});

test("a height the master does not offer is refused", async (t) => {
  const { manager, dirPath } = await managerWithBase();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });

  assert.deepEqual(
    await manager.resolveVariantFile(BASE_ID, 999, "index.m3u8"),
    { sessionId: null },
    "honouring an arbitrary height would let a client start encoder runs at will"
  );
  assert.deepEqual(
    await manager.resolveVariantFile(BASE_ID, 540, "master.m3u8"),
    { sessionId: null },
    "a master under a variant would describe variants of a variant"
  );
});

test("a variant's playlist is answered without starting an encoder for it", async (t) => {
  const { manager, base, dirPath } = await managerWithBase();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });

  const resolved = await manager.resolveVariantFile(BASE_ID, 540, "index.m3u8");

  assert.deepEqual(
    resolved,
    { sessionId: BASE_ID },
    "every variant of a file has the same media playlist — that is what makes them interchangeable"
  );
  assert.equal(
    base.file.stepHeights.size,
    0,
    "the player fetches a level's playlist to decide with, and may never switch to it"
  );
});

test("a segment request hands the encoder to the variant the viewer moved to", async (t) => {
  const { manager, base, dirPath } = await managerWithBase();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  const variant = fakeSession({ id: VARIANT_ID, encodeHeight: 540, dirPath });
  variant.variantHeight = 540;
  // A step of the picture: made as one, same file, and a height of its own.
  variant.isStep = true;
  manager.sessionsById.set(VARIANT_ID, variant);
  base.file.stepHeights.set(540, 540);
  // The viewer is a hundred seconds in, and the base is the one encoding.
  base.lastRequestedSegment = 25;
  const encoder = fakeEncoder();
  startRunOn(base, { process: encoder });
  const served = await manager.resolveVariantFile(BASE_ID, 540, "segment-00025.mp4");

  assert.equal(served.sessionId, VARIANT_ID, "the file must be served from the variant, not the base");
  assert.equal(base.activeVariantId, VARIANT_ID, "the variant the viewer is watching is the active one");
  assert.equal(
    encoder.signals.join(","),
    "SIGTERM",
    "the rung nobody is watching must not go on using the host's one encoder"
  );
  assert.equal([...base.runs][0]?.process ?? null, null, "a deliberate stop must not read as a run that died");
  assert.equal(
    variant.seekTarget,
    24,
    "a segment request steers nothing, so the variant has to be pointed at the viewer explicitly " +
    "(one segment back, for the preceding keyframe)"
  );
});

test("a rung is placed where the player asked it for, not where the other rung had read to", async (t) => {
  const { manager, base, dirPath } = await managerWithBase();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  const variant = fakeSession({ id: VARIANT_ID, encodeHeight: 540, dirPath });
  variant.variantHeight = 540;
  // A step of the picture: made as one, same file, and a height of its own.
  variant.isStep = true;
  manager.sessionsById.set(VARIANT_ID, variant);
  base.file.stepHeights.set(540, 540);
  startRunOn(base, { process: fakeEncoder() });
  // The rung being left had read fourteen segments further than the picture had
  // played — an encoder running at several times realtime fills the buffer far
  // ahead. Measured 2026-08-11: 56 s of gap, and using the read head placed the
  // new run past everything the player then asked for, which no request could
  // ever be answered from.
  base.lastRequestedSegment = 70;
  base.furthestViewerSeconds = 280;

  await manager.resolveVariantFile(BASE_ID, 540, "segment-00056.mp4");

  assert.equal(
    variant.seekTarget,
    55,
    "the segment the player asked this rung for is where it must begin (one back for the keyframe)"
  );
});

test("warming a rung prepares it without taking the encoder from the one on screen", async (t) => {
  const { manager, base, dirPath } = await managerWithBase();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  const variant = fakeSession({ id: VARIANT_ID, encodeHeight: 540, dirPath });
  variant.variantHeight = 540;
  // A step of the picture: made as one, same file, and a height of its own.
  variant.isStep = true;
  manager.sessionsById.set(VARIANT_ID, variant);
  base.file.stepHeights.set(540, 540);
  const encoder = fakeEncoder();
  startRunOn(base, { process: encoder });
  const prepared = await manager.prepareVariant(BASE_ID, 540, 240);

  assert.deepEqual(
    prepared,
    { sessionId: VARIANT_ID, fileName: "segment-00060.mp4" },
    "the caller is told which segment to wait for — 240 s on a four-second grid"
  );
  assert.equal(variant.seekTarget, 59, "the rung is pointed at the switch position, one back for the keyframe");
  assert.equal(base.activeVariantId, undefined, "nothing has switched yet");
  assert.equal([...base.runs][0]?.process, encoder, "the picture on screen keeps its encoder until the player actually moves");
  assert.deepEqual(encoder.signals, [], "stopping it here is what would put the spinner back");
});

test("a rung warmed at the playhead survives the switch that lands just ahead of it", async (t) => {
  const { manager, base, dirPath } = await managerWithBase();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  const variant = fakeSession({ id: VARIANT_ID, encodeHeight: 540, dirPath });
  variant.variantHeight = 540;
  // A step of the picture: made as one, same file, and a height of its own.
  variant.isStep = true;
  manager.sessionsById.set(VARIANT_ID, variant);
  base.file.stepHeights.set(540, 540);
  startRunOn(base, { process: fakeEncoder() });
  // Warmed AT THE PLAYHEAD (240 s = segment #60), which is what the browser
  // sends from server 0.10.0 onwards, and the run is alive and has produced a
  // few segments past it.
  await manager.prepareVariant(BASE_ID, 540, 240);

  startRunOn(variant, { from: 59, process: fakeEncoder() });
  variant.progress = { ...variant.progress, processedSeconds: 268 };
  variant.seekTarget = null;
  variant.seekSettleTimer = null;

  // hls.js flushes from the fragment after the one holding
  // `currentTime + fetchdelay`, so its first request for the new rung is the
  // playhead plus up to one fragment — here #61 against a run that began at
  // #59. Warming at the END OF THE BUFFER instead put the run tens of seconds
  // AHEAD of this request, which the proxy then read as a seek backwards:
  // measured 2026-08-14, that killed a run holding 21.8 s of encoded output.
  await manager.resolveVariantFile(BASE_ID, 540, "segment-00061.mp4");

  assert.equal(base.activeVariantId, VARIANT_ID, "the viewer has moved to this rung");
  assert.equal(
    variant.seekTarget,
    null,
    "the request is inside the warmed run, so nothing is repositioned and the warm-up is kept"
  );
  assert.equal([...variant.runs][0].from, 59, "the run still begins where it was warmed");
});

test("a rung warmed PAST the switch is repositioned, which is what warming late costs", async (t) => {
  const { manager, base, dirPath } = await managerWithBase();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  const variant = fakeSession({ id: VARIANT_ID, encodeHeight: 540, dirPath });
  variant.variantHeight = 540;
  // A step of the picture: made as one, same file, and a height of its own.
  variant.isStep = true;
  manager.sessionsById.set(VARIANT_ID, variant);
  base.file.stepHeights.set(540, 540);
  startRunOn(base, { process: fakeEncoder() });
  // The same session, warmed where the BUFFER ended rather than where the
  // picture was — 60 s further on, which is an ordinary cushion. This is what
  // server 0.9.3 sent and 0.11.0 stopped sending.
  await manager.prepareVariant(BASE_ID, 540, 300);
  startRunOn(variant, { from: 74, process: fakeEncoder() });
  variant.progress = { ...variant.progress, processedSeconds: 310 };
  variant.seekTarget = null;
  variant.seekSettleTimer = null;

  // hls.js still lands near the playhead, so the request is far BEHIND the
  // warmed run: the proxy reads it as a seek backwards and starts again, and
  // everything the warm-up produced is thrown away. Measured in the field
  // 2026-08-14 as 21.8 s of encoded output destroyed by the act of using it.
  await manager.resolveVariantFile(BASE_ID, 540, "segment-00061.mp4");

  assert.equal(variant.seekTarget, 60, "the run is moved back to where the player actually asked");
});

test("the rung on screen fetching its own segments does not cancel a warm-up", async (t) => {
  const { manager, base, dirPath } = await managerWithBase();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  const variant = fakeSession({ id: VARIANT_ID, encodeHeight: 540, dirPath });
  variant.variantHeight = 540;
  // A step of the picture: made as one, same file, and a height of its own.
  variant.isStep = true;
  manager.sessionsById.set(VARIANT_ID, variant);
  base.file.stepHeights.set(540, 540);
  const warmedEncoder = fakeEncoder();
  startRunOn(variant, { process: warmedEncoder });
  startRunOn(base, { process: fakeEncoder() });
  await manager.prepareVariant(BASE_ID, 540, 100);

  // The viewer has not moved: the rung they are watching goes on asking for its
  // own segments, every few seconds, for as long as they watch.
  await manager.resolveVariantFile(BASE_ID, 812, "segment-00026.mp4");
  await manager.resolveVariantFile(BASE_ID, 812, "segment-00027.mp4");

  // Kept per viewer, and this one is the unnamed viewer of a transport that
  // carries no consumer id.
  assert.equal(
    base.viewers.get("")?.warmingVariantId ?? null,
    VARIANT_ID,
    "the rung being prepared is still being prepared"
  );
  assert.deepEqual(
    warmedEncoder.signals,
    [],
    "cancelling it here left the viewer waiting out the whole warm-up for a segment nobody was making"
  );
});

test("warming the height the base itself serves still points it at the switch", async (t) => {
  const { manager, base, dirPath } = await managerWithBase();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  // The viewer is on another rung; the base is parked where they left it, with
  // its encoder stopped. Warming its height must bring it back.
  const variant = fakeSession({ id: VARIANT_ID, encodeHeight: 540, dirPath });
  variant.variantHeight = 540;
  manager.sessionsById.set(VARIANT_ID, variant);
  base.file.stepHeights.set(540, 540);
  base.activeVariantId = VARIANT_ID;
  base.runs = new Set();

  await manager.prepareVariant(BASE_ID, 812, 400);

  // 400 s falls on the boundary between #99 and #100, and a run starts one
  // segment back so the player has the preceding keyframe.
  assert.equal(
    base.seekTarget,
    98,
    "the base is parked at the start, so warming its height must reposition it like any other rung"
  );
});

test("the viewer's position is kept current by the segments they ask for", async (t) => {
  const { manager, base, dirPath } = await managerWithBase();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  // A seek an hour ago is the only thing that ever wrote this field, and
  // playback reports no position at all. Read as it stood, a quality change
  // would place the new variant's encode run back at the seek — and since a
  // segment request steers nothing, the segments the player then asks for would
  // never be produced by anyone.
  base.furthestViewerSeconds = 40;

  await manager.getFileStream(BASE_ID, "segment-00090.mp4", { requestSeq: 1 });

  assert.equal(
    base.furthestViewerSeconds,
    360,
    "a request for segment #90 of a four-second grid says where the viewer is now"
  );
});

test("a playlist or an init segment does not move the encoder", async (t) => {
  const { manager, base, dirPath } = await managerWithBase();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  const variant = fakeSession({ id: VARIANT_ID, encodeHeight: 540, dirPath });
  manager.sessionsById.set(VARIANT_ID, variant);
  base.file.stepHeights.set(540, 540);
  startRunOn(base, { process: fakeEncoder() });
  base.file.stepHeights.set(540, 540);
  await manager.resolveVariantFile(BASE_ID, 540, "index.m3u8");
  await manager.resolveVariantFile(BASE_ID, 540, "init.mp4");

  assert.notEqual(
    base.activeVariantId,
    VARIANT_ID,
    "hls.js fetches a level's playlist and init to decide with, and may never switch to it"
  );
  assert.ok([...base.runs][0]?.process, "the stream on screen must keep its encoder while the player is only looking");
});

test("the name of a variant is fixed, whatever its encode is later set to", async (t) => {
  const { manager, base, dirPath } = await managerWithBase();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  // The player fetched the master once and addresses this variant as 812p for
  // the rest of the session, so the name must not follow the encode. Nothing in
  // the proxy changes `encodeHeight` mid-session any more — a change of size is
  // a change of variant now — but the name and the encode are still two
  // different things, and the addressing depends on their staying so.
  assert.equal(manager.liveOutputs.variantHeightOf(base), 812);
  base.encodeHeight = 540;

  assert.equal(
    manager.liveOutputs.variantHeightOf(base),
    812,
    "the name stays; renaming it would leave the player addressing a variant nobody answers for"
  );
  assert.deepEqual(
    await manager.resolveVariantFile(BASE_ID, 812, "segment-00000.mp4"),
    { sessionId: BASE_ID },
    "a second session at a height the host has already failed to manage is the opposite of what a step is for"
  );
});

test("the cut grid follows the grid asked for, not who produces the frames", () => {
  // Why a segment from one encoder can stand where another's would have: both
  // are cut at the same times. Which times is a property of the SESSION — the
  // even grid, or the source's own keyframes — and it must not be re-derived
  // from whether the video is copied, because a variant of a copied stream is
  // re-encoded and still has to land on the copy's cuts.
  const shape = { durationSeconds: 100, segDur: SEGMENT_SECONDS, startTime: 0 };
  const keyframeTimes = [0, 3.1, 9.7, 14.2, 21.5, 40, 61.25];

  const even = computeSegmentBoundaries({ ...shape, useKeyframeGrid: false, keyframeTimes });
  assert.equal(even[1], SEGMENT_SECONDS, "the even grid ignores the source's keyframes");
  assert.equal(even.at(-1), 100);

  const source = computeSegmentBoundaries({ ...shape, useKeyframeGrid: true, keyframeTimes });
  assert.deepEqual(
    source,
    [0, 9.7, 14.2, 21.5, 40, 61.25, 100],
    "the source's own keyframes, kept only where they are at least a segment apart"
  );

  // The one that matters: a copy and a re-encoded rung of it, given the same
  // grid, produce the SAME table. Segment N then covers the same span in both,
  // which is what lets one stand where the other would have.
  assert.deepEqual(
    computeSegmentBoundaries({ ...shape, useKeyframeGrid: true, keyframeTimes }),
    source,
    "a variant inherits the grid, so its boundaries are the same values"
  );
  // And with no index there is nothing to align to — the even grid, whoever asks.
  assert.deepEqual(
    computeSegmentBoundaries({ ...shape, useKeyframeGrid: true, keyframeTimes: null }),
    even,
    "no keyframes means no keyframe grid, however the caller asks"
  );
});

test("a rung served by copy stays offered while a re-encoded rung is on screen", async (t) => {
  const { manager, base, dirPath } = await managerWithBase();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  // The field case of 2026-08-15: a 1080p source served by COPY, the viewer on
  // 240p, and a host too weak to re-encode anything above it.
  base.transcodeVideo = false;
  base.encodeHeight = 1080;
  base.variantHeight = 1080;
  // Enough to re-encode 240p (1.67x combined) and nowhere near enough for
  // 720p (0.45x) — the field's own shape, where the rung the viewer picked was
  // offered and everything between it and the copy was not.
  manager.softwarePresetBenchmark = [{ preset: "ultrafast", pixelsPerSec: 12_000_000 }];
  manager.decodeCostModel = { pixelTerm: 0.00793, bitrateTerm: 0, constantTerm: 0 };
  // What decoding this source costs comes from the file's own facts, stated in
  // the fixture: 49.766 Mpx/s at 8 Mbit/s.
  assert.ok(base.file.decode, "the fixture must state enough for a decode cost to exist");

  const watching = fakeSession({ id: VARIANT_ID, encodeHeight: 240, dirPath });
  watching.variantHeight = 240;
  watching.transcodeVideo = true;
  // The rung knows the source as well as the base does, because it IS the same
  // file. Without that it prices nothing at all — every height comes back
  // "sustainable" for want of a measurement — and the assertion below would
  // hold for the wrong reason.
  watching.file = base.file;
  // A step of the picture: same file, and made as a step.
  watching.isStep = true;
  manager.sessionsById.set(VARIANT_ID, watching);
  base.file.stepHeights.set(240, 240);
  base.activeVariantId = VARIANT_ID;

  const offered = manager.offeredHeights(watching);

  assert.ok(
    offered.includes(1080),
    "the height the source is COPIED at costs no encoder, so no measurement of this host can withdraw it"
  );
  assert.deepEqual(
    offered,
    manager.offeredHeights(base),
    "one answer for the family: a rung asked while watching another must not disagree with the base"
  );
});

test("a separately published audio track starts where the picture is, from the reported buffer", async (t) => {
  const { manager, base, dirPath } = await managerWithBase();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  base.audioSeparate = true;
  // Served up to 140 s, and the browser says it holds 40 s ahead of the
  // picture — so the viewer is at 100 s, and that, less a segment of margin,
  // is where the track has to begin.
  base.furthestViewerSeconds = 140;
  viewerOf(base, "viewer").netReport = {
    linkMbps: 20,
    bufferedAheadSec: 40,
    positionSeconds: null,
    at: Date.now()
  };
  manager.getCachedAudioTracks = () => [
    { index: 0, language: "rus", title: "", isDefault: true },
    { index: 1, language: "eng", title: "", isDefault: false }
  ];
  const created = [];
  manager.createOrGetSession = async (params) => {
    created.push(params);
    const rendition = fakeSession({ id: VARIANT_ID, encodeHeight: 0, dirPath });
    rendition.audioOnly = true;
    return { sessionId: VARIANT_ID, session: rendition };
  };

  await manager.resolveAudioRenditionFile(BASE_ID, 1, "segment-00010.mp4");

  assert.equal(created.length, 1, "the track's own session was made");
  assert.equal(
    created[0].startPositionSeconds,
    96,
    "140 s served, less the 40 s the player holds, less one segment of margin"
  );
});

test("with two viewers the audio track starts at the EARLIEST picture, not the read head", async (t) => {
  const { manager, base, dirPath } = await managerWithBase();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  base.audioSeparate = true;
  // A copied picture is one session shared by both of them. The read head is
  // the furthest request of EITHER, so it belongs to the viewer in front.
  base.furthestViewerSeconds = 140;
  viewerOf(base, "ahead").netReport = {
    linkMbps: 20,
    bufferedAheadSec: 40,
    positionSeconds: 100,
    at: Date.now()
  };
  viewerOf(base, "behind").netReport = {
    linkMbps: 20,
    bufferedAheadSec: 8,
    positionSeconds: 40,
    at: Date.now()
  };
  manager.getCachedAudioTracks = () => [
    { index: 0, language: "rus", title: "", isDefault: true },
    { index: 1, language: "eng", title: "", isDefault: false }
  ];
  const created = [];
  manager.createOrGetSession = async (params) => {
    created.push(params);
    const rendition = fakeSession({ id: VARIANT_ID, encodeHeight: 0, dirPath });
    rendition.audioOnly = true;
    return { sessionId: VARIANT_ID, session: rendition };
  };

  await manager.resolveAudioRenditionFile(BASE_ID, 1, "segment-00010.mp4");

  assert.equal(
    created[0].startPositionSeconds,
    36,
    "the viewer at 40 s, less one segment of margin — a run starting at the leader " +
      "has nothing to give the one behind them"
  );
});

test("a position past the read head is clamped rather than acted on", async (t) => {
  const { manager, base, dirPath } = await managerWithBase();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  base.audioSeparate = true;
  base.furthestViewerSeconds = 140;
  // Reports and requests race; a position claiming to be past everything that
  // has been asked for would start the run where no request can reach it.
  viewerOf(base, "viewer").netReport = {
    linkMbps: 20,
    bufferedAheadSec: 40,
    positionSeconds: 900,
    at: Date.now()
  };
  manager.getCachedAudioTracks = () => [
    { index: 0, language: "rus", title: "", isDefault: true },
    { index: 1, language: "eng", title: "", isDefault: false }
  ];
  const created = [];
  manager.createOrGetSession = async (params) => {
    created.push(params);
    const rendition = fakeSession({ id: VARIANT_ID, encodeHeight: 0, dirPath });
    rendition.audioOnly = true;
    return { sessionId: VARIANT_ID, session: rendition };
  };

  await manager.resolveAudioRenditionFile(BASE_ID, 1, "segment-00010.mp4");

  assert.equal(
    created[0].startPositionSeconds,
    136,
    "clamped to the read head, less one segment of margin"
  );
});

test("a stale buffer report is not used to place an audio track", async (t) => {
  const { manager, base, dirPath } = await managerWithBase();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  base.audioSeparate = true;
  base.furthestViewerSeconds = 300;
  // Sent a minute ago: the viewer may have seeked anywhere since, so neither
  // the buffer nor the position in it says where they are now.
  viewerOf(base, "viewer").netReport = {
    linkMbps: 20,
    bufferedAheadSec: 5,
    positionSeconds: 250,
    at: Date.now() - 60_000
  };
  manager.getCachedAudioTracks = () => [
    { index: 0, language: "rus", title: "", isDefault: true },
    { index: 1, language: "eng", title: "", isDefault: false }
  ];
  const created = [];
  manager.createOrGetSession = async (params) => {
    created.push(params);
    const rendition = fakeSession({ id: VARIANT_ID, encodeHeight: 0, dirPath });
    rendition.audioOnly = true;
    return { sessionId: VARIANT_ID, session: rendition };
  };

  await manager.resolveAudioRenditionFile(BASE_ID, 1, "segment-00010.mp4");

  assert.equal(
    created[0].startPositionSeconds,
    176,
    "the whole look-ahead is subtracted instead — it cannot leave the run ahead of the viewer"
  );
});

test("an audio track is prepared at the position the switch will land on", async (t) => {
  const { manager, base, dirPath } = await managerWithBase();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  base.audioSeparate = true;
  manager.getCachedAudioTracks = () => [
    { index: 0, language: "rus", title: "", isDefault: true },
    { index: 1, language: "eng", title: "", isDefault: false }
  ];
  const rendition = fakeSession({ id: VARIANT_ID, encodeHeight: 0, dirPath });
  rendition.audioOnly = true;
  rendition.audioTrackIndex = 1;
  rendition.transcodeAudio = true;
  // A soundtrack of THIS picture: the same file, published on its own. Found by
  // what it is — there is no list of ids to put it on.
  rendition.file = base.file;
  startRunOn(rendition, { process: fakeEncoder() });
  manager.sessionsById.set(VARIANT_ID, rendition);

  const prepared = await manager.prepareAudioTrack(BASE_ID, 1, 240);

  assert.deepEqual(
    prepared,
    { sessionId: VARIANT_ID, fileName: "segment-00060.mp4" },
    "the caller is told which segment to wait for — 240 s on a four-second grid"
  );
  assert.equal(
    rendition.seekTarget,
    59,
    "and the track is pointed at the switch position, one back for the preceding keyframe"
  );
});

test("a reading from a soundtrack is priced as one", () => {
  // The fault this pins: an audio rendition reached no learner at all. One
  // guard refused renditions a reading, and the only call that would have
  // priced one sat behind a second guard its caller had already made — so a
  // soundtrack ran for the whole film and was charged at nothing, which is the
  // half of roadmap item 6 that was left owing.
  assert.equal(costKindForSession({ audioOnly: true, transcodeVideo: false }), "audio");
  assert.equal(
    costKindForSession({ audioOnly: true, transcodeVideo: true }),
    "audio",
    "a rendition carries no picture, whatever the flag it inherited says"
  );
  assert.equal(costKindForSession({ transcodeVideo: true }), "decode");
  assert.equal(costKindForSession({ transcodeVideo: false }), "copy");
});

test("a quality step being warmed is not refused by its own cost", async (t) => {
  const dirPath = await mkdtemp(path.join(os.tmpdir(), "warm-cost-"));
  // The addon host's own figures, so the arithmetic below is the field's and
  // not an invention. Without a benchmark the check returns every height
  // untouched and a test over it would pass while proving nothing.
  const manager = new HlsSessionManager({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090,
    softwarePresetBenchmark: [
      { preset: "fast", pixelsPerSec: 17.0e6 },
      { preset: "ultrafast", pixelsPerSec: 67.5e6 }
    ],
    decodeCostModel: { pixelTerm: 0.007742, bitrateTerm: 0, constantTerm: 0 }
  });
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  // A copied 1080p picture, and a 240p step warmed beside it for a switch —
  // which is what every quality change does, two encoders on purpose.
  const base = fakeSession({ id: BASE_ID, encodeHeight: 0, dirPath, transcodeVideo: false });
  base.variantHeight = 1080;
  // What this source costs to decode comes from the file's own facts, stated in
  // the fixture: 1080p24 at 8 Mbit/s, the field file. Without them nothing can
  // be priced and every height comes back offerable for want of a measurement,
  // which would make the assertion hold for the wrong reason.
  assert.ok(base.file.decode, "the fixture must state enough for a decode cost to exist");
  const warming = fakeSession({ id: VARIANT_ID, encodeHeight: 240, dirPath });
  warming.variantHeight = 240;
  // Two sessions of ONE file share its facts, which is the whole point of the
  // file being an object: a step warmed beside the picture is not a second file.
  warming.file = base.file;
  base.file.stepHeights.set(240, 240);
  // A step of the picture: same file, and a height of its own.
  // Running, and running well: it says of itself that it holds twice realtime,
  // i.e. half a second of work per second of video.
  startRunOn(warming, { process: fakeEncoder() });
  warming.lastAloneSpeed = 2;
  manager.sessionsById.set(BASE_ID, base);
  manager.sessionsById.set(VARIANT_ID, warming);

  const offered = manager.offeredHeights(base);

  assert.ok(
    offered.includes(240),
    "charged its own cost while being judged, the step the viewer just asked for is dropped from the " +
      "offer by the act of warming it — and its next segment 404s on a stream that is playing"
  );
});

test("the master survives a live offer that has collapsed to one rung", async (t) => {
  // The field case of 2026-08-18, in the smallest form that reproduces it: a
  // host too slow for any re-encoded rung, and a swarm whose interruptions
  // demand far more than realtime. The live offer then holds only the height an
  // encoder is already producing — and until this test existed, that made
  // `buildMasterPlaylist` answer null and the route answer 404 to a session
  // that had just published the address.
  const dirPath = await mkdtemp(path.join(os.tmpdir(), "quality-variants-collapse-"));
  const manager = new HlsSessionManager({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090,
    // A megapixel a second: every rung below the source costs more than the
    // machine has.
    softwarePresetBenchmark: [{ preset: "veryfast", pixelsPerSec: 1_000_000 }],
    decodeCostModel: { pixelTerm: 0.01, bitrateTerm: 0, constantTerm: 0 }
  });
  const base = fakeSession({ id: BASE_ID, encodeHeight: 812, dirPath });
  // A thicker source than the fixture's, stated as the file's own bitrate
  // rather than as a cost object the file now derives.
  base.file.learn({ width: 1920, height: 1080, fps: 24, bitrateKbps: 10_000 });
  // What this file's own reader measured: a step must run at eight times
  // realtime to survive this swarm.
  base.supplyFigures = { requiredSpeed: 8 };
  manager.sessionsById.set(BASE_ID, base);
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });

  assert.deepEqual(
    manager.offeredHeights(base),
    [812],
    "the live judgement is unchanged: nothing but the running height is worth offering"
  );

  const master = manager.buildMasterPlaylist(BASE_ID);

  assert.ok(master, "the master is a published document, not a live figure");
  const heights = [...master.matchAll(/^v\/(\d+)\/index\.m3u8$/gm)].map((match) => Number(match[1]));
  assert.deepEqual(
    heights,
    [1080, 812, 720, 540, 480, 360, 240],
    "every rung that can be spliced onto this cut grid stays addressable"
  );
});

test("two heights that clamp onto one picture share a single encoder", async (t) => {
  const { manager, base, dirPath } = await managerWithBase();
  const spawnedDirs = [];
  t.after(async () => {
    await manager.disposeAll();
    await Promise.all(spawnedDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    await rm(dirPath, { recursive: true, force: true });
  });

  // A host that can hold exactly one rung. Whatever height is asked for, the
  // clamp inside createOrGetSession lands the encode on 240p — which is what a
  // CM4 did on 2026-08-28, turning a 360p and a 540p request into two more
  // ffmpeg processes making the same 426x240 picture as the 240p one.
  const madeIds = [VARIANT_ID, SECOND_VARIANT_ID];
  const created = [];
  manager.createOrGetSession = async (params) => {
    const id = madeIds[created.length];
    created.push(params);
    const variantDir = await mkdtemp(path.join(os.tmpdir(), "quality-variants-clamped-"));
    spawnedDirs.push(variantDir);
    const variant = fakeSession({ id, encodeHeight: 240, dirPath: variantDir });
    variant.consumers = new Set([params.consumerId]);
    manager.sessionsById.set(id, variant);
    return variant;
  };

  const asked360 = await manager.resolveVariantSession(BASE_ID, 360);
  const asked540 = await manager.resolveVariantSession(BASE_ID, 540);

  assert.equal(asked360.id, VARIANT_ID, "the first request made the encoder");
  assert.equal(
    asked540.id,
    VARIANT_ID,
    "and the second is served by it, because it produces the very same picture"
  );
  assert.equal(
    manager.sessionsById.has(SECOND_VARIANT_ID),
    false,
    "the duplicate was let go as soon as its size was known"
  );
  assert.equal(
    base.file.stepHeights.get(540),
    240,
    "540p is recorded as answered with the 240p the machine can hold"
  );

  const askedAgain = await manager.resolveVariantSession(BASE_ID, 540);

  assert.equal(askedAgain.id, VARIANT_ID);
  assert.equal(created.length, 2, "the third request created nothing at all");
});

test("rungs that really do differ keep their own encoders", async (t) => {
  const { manager, base, dirPath } = await managerWithBase();
  const spawnedDirs = [];
  t.after(async () => {
    await manager.disposeAll();
    await Promise.all(spawnedDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    await rm(dirPath, { recursive: true, force: true });
  });

  // A host with room: each request is encoded at the height it named, so
  // nothing may be merged. The sharing above must not become "one encoder for
  // every rung".
  const madeIds = [VARIANT_ID, SECOND_VARIANT_ID];
  const created = [];
  manager.createOrGetSession = async (params) => {
    const id = madeIds[created.length];
    created.push(params);
    const variantDir = await mkdtemp(path.join(os.tmpdir(), "quality-variants-distinct-"));
    spawnedDirs.push(variantDir);
    const variant = fakeSession({ id, encodeHeight: params.targetHeight, dirPath: variantDir });
    variant.consumers = new Set([params.consumerId]);
    manager.sessionsById.set(id, variant);
    return variant;
  };

  const asked360 = await manager.resolveVariantSession(BASE_ID, 360);
  const asked540 = await manager.resolveVariantSession(BASE_ID, 540);

  assert.equal(asked360.id, VARIANT_ID);
  assert.equal(asked540.id, SECOND_VARIANT_ID, "two different pictures, two encoders");
  assert.equal(base.file.stepHeights.get(360), 360);
  assert.equal(base.file.stepHeights.get(540), 540);
});

test("a rung is never served from the COPY, whatever height the copy happens to be", async (t) => {
  const { manager, base, dirPath } = await managerWithBase();
  const spawnedDirs = [];
  t.after(async () => {
    await manager.disposeAll();
    await Promise.all(spawnedDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    await rm(dirPath, { recursive: true, force: true });
  });

  // The base is a COPY at 240p — no encoder behind it, and it is the one rung
  // this host can always serve. Handing it to a request for a re-encoded 360p
  // would give away exactly that, and a viewer stranded on a rung the machine
  // cannot hold would have nowhere left to return to.
  base.transcodeVideo = false;
  base.encodeHeight = 240;
  base.variantHeight = 240;
  const created = [];
  manager.createOrGetSession = async (params) => {
    created.push(params);
    const variantDir = await mkdtemp(path.join(os.tmpdir(), "quality-variants-copy-"));
    spawnedDirs.push(variantDir);
    const variant = fakeSession({ id: VARIANT_ID, encodeHeight: 240, dirPath: variantDir });
    variant.consumers = new Set([params.consumerId]);
    manager.sessionsById.set(VARIANT_ID, variant);
    return variant;
  };

  const asked = await manager.resolveVariantSession(BASE_ID, 360);

  assert.equal(asked.id, VARIANT_ID, "the re-encoded rung is its own session, not the copy");
});

test("a file opened at a position starts its sound THERE, not a look-ahead earlier", async (t) => {
  const { manager, base, dirPath } = await managerWithBase();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  base.audioSeparate = true;
  // The state at the instant a page is opened at a position: nothing seeked,
  // no segment served, no report from anybody. The read head is then not a
  // request edge — it is where the session was made — and a browser that has
  // just opened holds no buffer at all.
  base.furthestViewerSeconds = null;
  base.lastRequestedSegment = null;
  base.viewers.clear();
  base.progress.startPositionSeconds = 588;
  manager.getCachedAudioTracks = () => [
    { index: 0, language: "rus", title: "", isDefault: true },
    { index: 1, language: "eng", title: "", isDefault: false }
  ];
  const created = [];
  manager.createOrGetSession = async (params) => {
    created.push(params);
    const rendition = fakeSession({ id: VARIANT_ID, encodeHeight: 0, dirPath });
    rendition.audioOnly = true;
    return { sessionId: VARIANT_ID, session: rendition };
  };

  await manager.resolveAudioRenditionFile(BASE_ID, 1, "segment-00010.mp4");

  // Field 2026-08-31: this answered 460 for a page opened at 588 — the whole
  // 120 s look-ahead subtracted from a buffer that did not exist — and the
  // segment the viewer needed took 38.8 s to appear against the picture's 8.4 s.
  assert.equal(
    created[0].startPositionSeconds,
    584,
    "where the viewer opened, less one segment of margin, and nothing else"
  );
});
