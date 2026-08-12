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
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { computeSegmentBoundaries, HlsSessionManager } from "../services/hls-session-manager.js";
import { fmp4Format } from "../services/segment-formats/fmp4.js";

const BASE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const VARIANT_ID = "11111111-2222-3333-4444-555555555555";
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
    state: "ready",
    fileName: "video.mkv",
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
    sourceKey: "source-1",
    fileIndex: 0,
    sourceWidth: 1920,
    sourceHeight: 1080,
    encodeWidth: 0,
    encodeHeight,
    encodeRunGeneration: 0,
    encodeStartIndex: 0,
    lastRestartAt: 0,
    seekFailureTarget: -1,
    seekFailureCount: 0,
    seekSettleTimer: null,
    seekTarget: null,
    waitEpoch: 0,
    usesExplicitCuts: false,
    useSyntheticPlaylist: true,
    playlistText: "#EXTM3U\n",
    segmentBoundaries: Array.from({ length: 101 }, (_, index) => index * SEGMENT_SECONDS),
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
  base.cutGrid = "keyframe";

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
  base.cutGrid = "uniform";

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
    base.variants,
    undefined,
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
  variant.variantBases = new Set([BASE_ID]);
  manager.sessionsById.set(VARIANT_ID, variant);
  base.variants = new Map([[540, VARIANT_ID]]);
  // The viewer is a hundred seconds in, and the base is the one encoding.
  base.lastRequestedSegment = 25;
  const encoder = fakeEncoder();
  base.ffmpeg = encoder;

  const served = await manager.resolveVariantFile(BASE_ID, 540, "segment-00025.mp4");

  assert.equal(served.sessionId, VARIANT_ID, "the file must be served from the variant, not the base");
  assert.equal(base.activeVariantId, VARIANT_ID, "the variant the viewer is watching is the active one");
  assert.equal(
    encoder.signals.join(","),
    "SIGTERM",
    "the rung nobody is watching must not go on using the host's one encoder"
  );
  assert.equal(base.ffmpeg, null, "a deliberate stop must not read as a run that died");
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
  variant.variantBases = new Set([BASE_ID]);
  manager.sessionsById.set(VARIANT_ID, variant);
  base.variants = new Map([[540, VARIANT_ID]]);
  base.ffmpeg = fakeEncoder();
  // The rung being left had read fourteen segments further than the picture had
  // played — an encoder running at several times realtime fills the buffer far
  // ahead. Measured 2026-08-11: 56 s of gap, and using the read head placed the
  // new run past everything the player then asked for, which no request could
  // ever be answered from.
  base.lastRequestedSegment = 70;
  base.viewerPositionSeconds = 280;

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
  variant.variantBases = new Set([BASE_ID]);
  manager.sessionsById.set(VARIANT_ID, variant);
  base.variants = new Map([[540, VARIANT_ID]]);
  const encoder = fakeEncoder();
  base.ffmpeg = encoder;

  const prepared = await manager.prepareVariant(BASE_ID, 540, 240);

  assert.deepEqual(
    prepared,
    { sessionId: VARIANT_ID, fileName: "segment-00060.mp4" },
    "the caller is told which segment to wait for — 240 s on a four-second grid"
  );
  assert.equal(variant.seekTarget, 59, "the rung is pointed at the switch position, one back for the keyframe");
  assert.equal(base.activeVariantId, undefined, "nothing has switched yet");
  assert.equal(base.ffmpeg, encoder, "the picture on screen keeps its encoder until the player actually moves");
  assert.deepEqual(encoder.signals, [], "stopping it here is what would put the spinner back");
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
  base.viewerPositionSeconds = 40;

  await manager.getFileStream(BASE_ID, "segment-00090.mp4", { requestSeq: 1 });

  assert.equal(
    base.viewerPositionSeconds,
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
  base.variants = new Map([[540, VARIANT_ID]]);
  base.ffmpeg = fakeEncoder();

  base.variants = new Map([[540, VARIANT_ID]]);
  await manager.resolveVariantFile(BASE_ID, 540, "index.m3u8");
  await manager.resolveVariantFile(BASE_ID, 540, "init.mp4");

  assert.notEqual(
    base.activeVariantId,
    VARIANT_ID,
    "hls.js fetches a level's playlist and init to decide with, and may never switch to it"
  );
  assert.ok(base.ffmpeg, "the stream on screen must keep its encoder while the player is only looking");
});

test("a downshift does not rename the variant the viewer is watching", async (t) => {
  const { manager, base, dirPath } = await managerWithBase();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  // The player fetched the master once and addresses this variant as 812p for
  // the rest of the session. The realtime budget then finds the host cannot
  // keep up and steps the encode down — inside this variant, which is what it
  // has always done.
  assert.equal(manager.variantHeightOf(base), 812);
  base.encodeHeight = 540;

  assert.equal(
    manager.variantHeightOf(base),
    812,
    "the name stays; renaming it would leave the player addressing a variant nobody answers for"
  );
  assert.deepEqual(
    await manager.resolveVariantFile(BASE_ID, 812, "segment-00000.mp4"),
    { sessionId: BASE_ID },
    "a second session at the height the host just failed to manage is the opposite of what a downshift is for"
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
