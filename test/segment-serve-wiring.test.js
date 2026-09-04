/**
 * @file A finished segment on disk must reach the viewer as bytes.
 *
 * The module tests cover each piece of the fMP4 path on its own, and every one
 * of them passed while playback was dead: 2.9.124 called
 * `readSelfContainedStartSeconds` from `fmp4.js` without importing it, and the
 * unit test imports that function straight from `mp4-boxes.js`, so the gap
 * between a module and its CALLER was invisible. This test asks the session
 * manager for a segment that exists and insists on getting it.
 *
 * The second half pins the reason a one-word slip cost a whole release: the
 * failure was reported as "still being produced". Measured 2026-08-08 — segment
 * #0 was held for 45 281 ms with twelve finished segments in the directory, and
 * the log said nothing at all. Anything that goes wrong while preparing a file
 * that EXISTS must be named and answered, never turned into an endless wait.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { SourceFile } from "../services/source/SourceFile.js";
import { Timeline } from "../services/output/Timeline.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HlsSessionManager } from "../services/hls-session-manager.js";
import { ENCODE_RUN_STATE } from "../services/encode/encode-run-state.js";
import { startRunOn } from "./helpers/encode-run.js";
import { fmp4Format } from "../services/segment-formats/fmp4.js";

const MOVIE_TIMESCALE = 1000;
const VIDEO_TIMESCALE = 90_000;
const AUDIO_TIMESCALE = 48_000;
const SEGMENT_START_SECONDS = 12.5;
const SESSION_ID = "11111111-2222-3333-4444-555555555555";

/**
 * @param {string} type
 * @param {Buffer} body
 * @returns {Buffer}
 */
function box(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
}

/**
 * `elst` holding one empty edit — how the `segment` muxer records where the
 * piece sits on the source timeline.
 *
 * @param {number} offsetSeconds
 * @returns {Buffer}
 */
function emptyEdit(offsetSeconds) {
  const body = Buffer.alloc(16);
  body.writeUInt32BE(1, 4);                                        // entry count
  body.writeUInt32BE(Math.round(offsetSeconds * MOVIE_TIMESCALE), 8); // duration
  body.writeInt32BE(-1, 12);                                       // media_time
  return box("elst", body);
}

/**
 * @param {number} trackId
 * @param {number} timescale
 * @param {number} offsetSeconds
 * @returns {Buffer}
 */
function trak(trackId, timescale, offsetSeconds) {
  const tkhdBody = Buffer.alloc(84);
  tkhdBody.writeUInt32BE(trackId, 12);
  const mdhdBody = Buffer.alloc(20);
  mdhdBody.writeUInt32BE(timescale, 12);
  return box("trak", Buffer.concat([
    box("tkhd", tkhdBody),
    box("edts", emptyEdit(offsetSeconds)),
    box("mdia", box("mdhd", mdhdBody))
  ]));
}

/**
 * @param {number} trackId
 * @returns {Buffer}
 */
function traf(trackId) {
  const tfhdBody = Buffer.alloc(8);
  tfhdBody.writeUInt32BE(trackId, 4);
  const tfdtBody = Buffer.alloc(12);
  tfdtBody.writeUInt8(1, 0);                       // version 1 — 64-bit
  tfdtBody.writeBigUInt64BE(0n, 4);                // what ffmpeg writes: zero
  return box("traf", Buffer.concat([box("tfhd", tfhdBody), box("tfdt", tfdtBody)]));
}

/**
 * A piece shaped like the `segment` muxer's output: header, two fragments and a
 * trailing random-access index, all in one file.
 *
 * @param {number} offsetSeconds
 * @returns {Buffer}
 */
function selfContainedPiece(offsetSeconds) {
  const mvhdBody = Buffer.alloc(100);
  mvhdBody.writeUInt32BE(MOVIE_TIMESCALE, 12);
  const moov = box("moov", Buffer.concat([
    box("mvhd", mvhdBody),
    trak(1, VIDEO_TIMESCALE, offsetSeconds),
    trak(2, AUDIO_TIMESCALE, offsetSeconds)
  ]));
  const moof = box("moof", Buffer.concat([traf(1), traf(2)]));
  const mdat = box("mdat", Buffer.alloc(64, 0x5a));
  const mfra = box("mfra", Buffer.alloc(24, 0));
  return Buffer.concat([box("ftyp", Buffer.alloc(16, 0)), moov, moof, mdat, mfra]);
}

/**
 * A manager holding one session whose segments are already on disk, cut at
 * explicit times — the ordinary keyframe-cut path.
 *
 * @param {{ segmentFormat?: object }} [overrides]
 * @returns {Promise<{ manager: HlsSessionManager, session: object, dirPath: string }>}
 */
async function managerWithReadySegment(overrides = {}) {
  const dirPath = await mkdtemp(path.join(os.tmpdir(), "segment-serve-"));
  const piece = selfContainedPiece(SEGMENT_START_SECONDS);
  // Two segments, because a piece is only finished once the next one exists.
  await writeFile(path.join(dirPath, "segment-00000.mp4"), piece);
  await writeFile(path.join(dirPath, "segment-00001.mp4"), piece);

  const manager = new HlsSessionManager({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090
  });
  const session = {
    id: SESSION_ID,
    dirPath,
    // Where this file is cut, held by the file. A fixture that stated it
    // on the session was describing what production no longer does.
    timeline: new Timeline({
      boundaries: [0, SEGMENT_START_SECONDS, 25],
      cutGrid: "uniform"
    }),
    state: "ready",
    file: new SourceFile({ sourceKey: "source-1", fileIndex: 0, name: "video.mkv" }),
    // An ordinary session reads its own file, and its sound is inside it. The
    // three differ only for a soundtrack shipped as a file of its own.
    get inputFile() { return this.file; },
    get audioFile() { return this.file; },
    startedAt: Date.now(),
    createEntryMs: Date.now(),
    lastAccessedAt: Date.now(),
    run: null,
    lastError: "",
    consumers: new Set(),
    segmentFormat: overrides.segmentFormat ?? fmp4Format,
    useSyntheticPlaylist: true,
    playlistText: "#EXTM3U\n",
    initBytes: fmp4Format.extractInit(piece),
    firstSegmentLogged: false,
    waitEpoch: 0
  };
  manager.sessionsById.set(SESSION_ID, session);
  // The run in force. The fixture's segments live directly in the session
  // directory, which is exactly what one run's directory is here.
  startRunOn(session, { from: 0, usesExplicitCuts: true });
  return { manager, session, dirPath };
}

test("serving a segment records what its real start says about the container's index", async (t) => {
  const { manager, session, dirPath } = await managerWithReadySegment();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  // The tally is counted in the module tests; what this pins is that serving a
  // segment reaches it at all. A counter nothing increments reports a clean
  // index for every file forever, which is worse than no measurement.
  session.timeline.indexCheck = { checked: 0, disagreed: 0, maxDeviationSec: 0, firstDisagreementIndex: -1, seen: new Set() };

  await manager.getFileStream(SESSION_ID, "segment-00000.mp4", { requestSeq: 1 });

  assert.equal(session.timeline.indexCheck.checked, 1, "the boundary that was just produced must have been examined");
});

test("a segment that exists is served, not reported as still being produced", async (t) => {
  const { manager, dirPath, session } = await managerWithReadySegment();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });

  const result = await manager.getFileStream(SESSION_ID, "segment-00000.mp4", { requestSeq: 1 });

  assert.equal(result.kind, "file", "a finished segment on disk must come back as bytes");
  assert.equal(result.contentType, fmp4Format.segmentContentType);

  const chunks = [];
  for await (const chunk of result.stream) {
    chunks.push(chunk);
  }
  const served = Buffer.concat(chunks);
  assert.equal(served.toString("latin1", 4, 8), "moof", "the init header must be stripped off a media segment");

  // The piece's OWN start, carried into the fragment it belongs to. Two
  // releases tried moving it toward the playlist instead (2.24.1 per session,
  // 2.25.0 by one family offset) and both desynced picture from sound in the
  // field the same day: the first segment of a run is not cut, it begins where
  // the seek landed, and the picture must land on a keyframe while the sound
  // need not. Reading the piece's position is also the step that threw in
  // 2.9.124, and it still feeds the index tally and the grid correction.
  assert.equal(
    Number(served.readBigUInt64BE(served.indexOf("tfdt") + 8)),
    Math.round(SEGMENT_START_SECONDS * VIDEO_TIMESCALE),
    "the segment must be stamped with where it really begins"
  );
  assert.equal(
    session.timeline.indexCheck.checked,
    1,
    "and the piece's own position must still have been read, or nothing measures the index"
  );
});

test("a fault while preparing an existing segment is named, not turned into a wait", async (t) => {
  const broken = {
    ...fmp4Format,
    readSegmentStartSeconds() {
      throw new ReferenceError("readSelfContainedStartSeconds is not defined");
    }
  };
  const { manager, dirPath } = await managerWithReadySegment({ segmentFormat: broken });
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });

  const result = await manager.getFileStream(SESSION_ID, "segment-00000.mp4", { requestSeq: 1 });

  assert.equal(
    result.kind,
    "failed",
    "answering 'warming-up' hides the fault and holds every request until the viewer gives up"
  );
  assert.match(result.message, /readSelfContainedStartSeconds is not defined/);
});

test("a run's FIRST segment is served once the encoder has passed it, without waiting for a next one", async (t) => {
  const { manager, session, dirPath } = await managerWithReadySegment();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  // The shape a resume takes: a run begun mid-file, so its first segment has no
  // successor and nothing is producing one. Waiting for that successor is what
  // held #317 for 46 s and then answered 404 to a browser that had given up.
  await rm(path.join(dirPath, "segment-00001.mp4"));
  session.progress = { processedSeconds: SEGMENT_START_SECONDS + 10 };

  const result = await manager.getFileStream(SESSION_ID, "segment-00000.mp4", { requestSeq: 1 });

  assert.equal(
    result.kind,
    "file",
    "the encoder is past this segment's end, so it is finished — the absence of a next one says nothing"
  );
});

test("a segment is found in the run directory that produced it, newest run first", async (t) => {
  const { manager, dirPath } = await managerWithReadySegment();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  // Runs write into a directory each — that is what lets a restart begin
  // without waiting for its predecessor to die, which measured 0.7-1.3 s of
  // every seek. A later run's answer supersedes an earlier one's, because the
  // older file may be the truncated output of a run that was killed mid-write.
  const { mkdir } = await import("node:fs/promises");
  const piece = selfContainedPiece(SEGMENT_START_SECONDS);
  await mkdir(path.join(dirPath, "run-1"), { recursive: true });
  await mkdir(path.join(dirPath, "run-2"), { recursive: true });
  await writeFile(path.join(dirPath, "run-1", "segment-00000.mp4"), Buffer.alloc(8));
  await writeFile(path.join(dirPath, "run-2", "segment-00000.mp4"), piece);
  await writeFile(path.join(dirPath, "run-2", "segment-00001.mp4"), piece);
  await rm(path.join(dirPath, "segment-00000.mp4"));
  await rm(path.join(dirPath, "segment-00001.mp4"));

  const result = await manager.getFileStream(SESSION_ID, "segment-00000.mp4", { requestSeq: 1 });

  assert.equal(result.kind, "file", "a segment produced by a run must be found in that run's directory");
  const chunks = [];
  for await (const chunk of result.stream) {
    chunks.push(chunk);
  }
  assert.ok(
    Buffer.concat(chunks).length > 8,
    "the newest run's output must win — the older file here is the 8-byte stub a killed run leaves"
  );
});

test("serving a run's own segment moves the run out of STARTING", async (t) => {
  const { manager, session, dirPath } = await managerWithReadySegment();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  // The table lives in `encode/encode-run-state.js` and is tested there as a graph.
  // What this pins is that a real serve REACHES it: a state nothing writes
  // describes every run as still starting, for ever, and the log built on it
  // would say so too.
  // A run that has not yet made anything: starting.
  startRunOn(session, { from: 0, producing: false, usesExplicitCuts: true });
  assert.equal(session.run.state, ENCODE_RUN_STATE.STARTING);

  await manager.getFileStream(SESSION_ID, "segment-00000.mp4", { requestSeq: 1 });

  assert.equal(session.run.state, ENCODE_RUN_STATE.PRODUCING);
});

test("a segment left by an earlier run does not claim the new run has produced", async (t) => {
  const { manager, session, dirPath } = await managerWithReadySegment();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  // A seek places the new run in a directory of its own; the previous run's
  // segments stay servable and are served from theirs. They say nothing about
  // what the run now starting has done — and a run believed to be producing is
  // one the look-ahead may suspend and the seek path may wave through as
  // "already covered by the running encode".
  //
  // Deliberately a segment ABOVE the new run's start index, because that is the
  // case an index comparison gets wrong: after a backward seek the old run's
  // output sits ahead of the new run's beginning.
  const run = startRunOn(session, { from: 0, producing: false, usesExplicitCuts: true });
  run.dirPath = path.join(dirPath, "run-7");

  await manager.getFileStream(SESSION_ID, "segment-00000.mp4", { requestSeq: 1 });

  assert.equal(session.run.state, ENCODE_RUN_STATE.STARTING);
});
