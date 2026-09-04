/**
 * @file When several runs have written the same segment number, which copy
 * answers — and what happens to the one that cannot.
 *
 * Field 2026-09-03. A run was suspended 548 ms after it started with
 * `segment-00025.mp4` newly opened, so the file stayed at zero bytes. From then
 * on the two halves of the proxy disagreed about it and neither could see the
 * other's reason: the look-ahead counted the NAME, found the numbering unbroken
 * through #83, called it `420s ahead of the viewer` and kept the encoder
 * stopped; the serving path read the FILE, found it short of a track, and
 * waited for a run that had produced nothing to finish it. A complete copy of
 * #25 lay in the previous run's directory the whole time and was never reached,
 * because the search returned the first name it found and stopped.
 *
 * The viewer's picture stood still for ten minutes with the bytes they needed
 * already on the disk, on a transport measuring 3-9 ms round trip.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Timeline } from "../services/output/Timeline.js";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  HlsSessionManager,
  discardOpenPiece,
  usableSegmentIndices
} from "../services/hls-session-manager.js";
import { fmp4Format } from "../services/segment-formats/fmp4.js";

const MOVIE_TIMESCALE = 1000;
const VIDEO_TIMESCALE = 90_000;
const AUDIO_TIMESCALE = 48_000;
const SEGMENT_SECONDS = 12.5;
const SESSION_ID = "aef21c88-a8d6-4a9a-8e7a-d0a9536351cf";

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
 * @param {number} offsetSeconds
 * @returns {Buffer}
 */
function emptyEdit(offsetSeconds) {
  const body = Buffer.alloc(16);
  body.writeUInt32BE(1, 4);
  body.writeUInt32BE(Math.round(offsetSeconds * MOVIE_TIMESCALE), 8);
  body.writeInt32BE(-1, 12);
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
  tfdtBody.writeUInt8(1, 0);
  tfdtBody.writeBigUInt64BE(0n, 4);
  return box("traf", Buffer.concat([box("tfhd", tfhdBody), box("tfdt", tfdtBody)]));
}

/**
 * A piece shaped like the `segment` muxer's output, carrying both tracks.
 *
 * @param {number} offsetSeconds
 * @returns {Buffer}
 */
function wholePiece(offsetSeconds) {
  const mvhdBody = Buffer.alloc(100);
  mvhdBody.writeUInt32BE(MOVIE_TIMESCALE, 12);
  const moov = box("moov", Buffer.concat([
    box("mvhd", mvhdBody),
    trak(1, VIDEO_TIMESCALE, offsetSeconds),
    trak(2, AUDIO_TIMESCALE, offsetSeconds)
  ]));
  const moof = box("moof", Buffer.concat([traf(1), traf(2)]));
  return Buffer.concat([
    box("ftyp", Buffer.alloc(16, 0)),
    moov,
    moof,
    box("mdat", Buffer.alloc(64, 0x5a)),
    box("mfra", Buffer.alloc(24, 0))
  ]);
}

/**
 * The same shape with ONE track in the fragment — what a run killed mid-write
 * leaves when it had muxed the picture and not yet the sound.
 *
 * @param {number} offsetSeconds
 * @returns {Buffer}
 */
function halfPiece(offsetSeconds) {
  const mvhdBody = Buffer.alloc(100);
  mvhdBody.writeUInt32BE(MOVIE_TIMESCALE, 12);
  const moov = box("moov", Buffer.concat([
    box("mvhd", mvhdBody),
    trak(1, VIDEO_TIMESCALE, offsetSeconds),
    trak(2, AUDIO_TIMESCALE, offsetSeconds)
  ]));
  return Buffer.concat([
    box("ftyp", Buffer.alloc(16, 0)),
    moov,
    box("moof", traf(1)),
    box("mdat", Buffer.alloc(64, 0x5a))
  ]);
}

/**
 * A session whose runs are laid out on disk exactly as the field case was.
 *
 * @returns {Promise<{ manager: HlsSessionManager, session: object, dirPath: string }>}
 */
async function sessionWithTwoRuns() {
  const dirPath = await mkdtemp(path.join(os.tmpdir(), "produced-copy-"));
  await mkdir(path.join(dirPath, "run-1"), { recursive: true });
  await mkdir(path.join(dirPath, "run-2"), { recursive: true });
  const manager = new HlsSessionManager({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090
  });
  const session = {
    id: SESSION_ID,
    dirPath,
    runDirPath: path.join(dirPath, "run-2"),
    runSerial: 2,
    // Where this file is cut, held by the file. A fixture that stated it
    // on the session was describing what production no longer does.
    timeline: new Timeline({
      boundaries: [0, SEGMENT_SECONDS, 25, 37.5, 50],
      cutGrid: "uniform"
    }),
    state: "ready",
    fileName: "Drifters - 04.mkv",
    startedAt: Date.now(),
    createEntryMs: Date.now(),
    lastAccessedAt: Date.now(),
    // A run exists and is alive — the state the field case was in, and the one
    // in which the old test called every leftover "still being written".
    ffmpeg: { pid: 0, killed: false, kill() {} },
    lastError: "",
    consumers: new Set(),
    viewers: new Map(),
    segmentFormat: fmp4Format,
    usesExplicitCuts: true,
    useSyntheticPlaylist: true,
    playlistText: "#EXTM3U\n",
    initBytes: fmp4Format.extractInit(wholePiece(0)),
    encodeStartIndex: 0,
    firstSegmentLogged: false,
    waitEpoch: 0
  };
  manager.sessionsById.set(SESSION_ID, session);
  return { manager, session, dirPath };
}

test("the complete copy answers when the newest run's is empty", async (t) => {
  const { manager, dirPath } = await sessionWithTwoRuns();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  // run-1 made this segment and finished it; run-2 opened it and was stopped.
  await writeFile(path.join(dirPath, "run-1", "segment-00001.mp4"), wholePiece(SEGMENT_SECONDS));
  await writeFile(path.join(dirPath, "run-1", "segment-00002.mp4"), wholePiece(25));
  await writeFile(path.join(dirPath, "run-2", "segment-00001.mp4"), Buffer.alloc(0));

  const result = await manager.getFileStream(SESSION_ID, "segment-00001.mp4", { requestSeq: 1 });

  assert.equal(
    result.kind,
    "file",
    "a complete copy exists one run away; holding here is what froze the picture for ten minutes"
  );
  const chunks = [];
  for await (const chunk of result.stream) {
    chunks.push(chunk);
  }
  assert.ok(Buffer.concat(chunks).length > 0, "and it must be the copy with bytes in it");
});

test("a copy short of a track is passed over for an older one that is whole", async (t) => {
  const { manager, dirPath } = await sessionWithTwoRuns();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  // Not empty — a terminated run closes its file properly, with only what it
  // had muxed by then, which after a seek-restart is routinely one track of two.
  await writeFile(path.join(dirPath, "run-1", "segment-00001.mp4"), wholePiece(SEGMENT_SECONDS));
  await writeFile(path.join(dirPath, "run-1", "segment-00002.mp4"), wholePiece(25));
  await writeFile(path.join(dirPath, "run-2", "segment-00001.mp4"), halfPiece(SEGMENT_SECONDS));

  const result = await manager.getFileStream(SESSION_ID, "segment-00001.mp4", { requestSeq: 1 });

  assert.equal(result.kind, "file", "a piece carrying one track of two is not servable; the whole one is");
});

test("a leftover of a run that has ended is removed, not waited on", async (t) => {
  const { manager, dirPath } = await sessionWithTwoRuns();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  // The only copy, and it belongs to a run that is gone. The current run —
  // run-2 — has written nothing, so calling this "still being written" waits on
  // a process that will never touch it.
  await writeFile(path.join(dirPath, "run-1", "segment-00001.mp4"), Buffer.alloc(0));

  const result = await manager.getFileStream(SESSION_ID, "segment-00001.mp4", { requestSeq: 1 });

  assert.equal(result.kind, "warming-up", "nothing servable exists yet, so the viewer waits");
  const left = await readdir(path.join(dirPath, "run-1"));
  assert.deepEqual(
    left,
    [],
    "and the unusable file must go, or the current run's own output is never looked for"
  );
});

test("the current run's own unfinished piece is waited for, never deleted", async (t) => {
  const { manager, session, dirPath } = await sessionWithTwoRuns();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  // The same file, in the directory of the run that is alive. It is being
  // written right now. Deleting it is the 2026-08-06 incident: #225 was removed
  // 14 s into the run producing it, which then wrote on into a file nobody
  // could open, and the segment never appeared.
  session.encodeStartIndex = 1;
  await writeFile(path.join(dirPath, "run-2", "segment-00001.mp4"), Buffer.alloc(0));

  const result = await manager.getFileStream(SESSION_ID, "segment-00001.mp4", { requestSeq: 1 });

  assert.equal(result.kind, "warming-up");
  const left = await readdir(path.join(dirPath, "run-2"));
  assert.deepEqual(left, ["segment-00001.mp4"], "the live run's own output must be left alone");
});

test("the look-ahead does not count a file with nothing in it", async (t) => {
  const dirPath = await mkdtemp(path.join(os.tmpdir(), "usable-indices-"));
  t.after(async () => {
    await rm(dirPath, { recursive: true, force: true });
  });
  const runTwo = path.join(dirPath, "run-2");
  const runOne = path.join(dirPath, "run-1");
  await mkdir(runTwo, { recursive: true });
  await mkdir(runOne, { recursive: true });
  await writeFile(path.join(runTwo, "segment-00000.mp4"), wholePiece(0));
  await writeFile(path.join(runTwo, "segment-00001.mp4"), Buffer.alloc(0));

  assert.deepEqual(
    [...usableSegmentIndices([runTwo, runOne], fmp4Format, new Set())].sort((a, b) => a - b),
    [0],
    "an empty file bridged the hole and bought the encoder a suspension it had not earned"
  );

  // The same number, made properly by an earlier run: now it genuinely is ready.
  await writeFile(path.join(runOne, "segment-00001.mp4"), wholePiece(SEGMENT_SECONDS));
  assert.deepEqual(
    [...usableSegmentIndices([runTwo, runOne], fmp4Format, new Set())].sort((a, b) => a - b),
    [0, 1],
    "some run holds a copy with bytes in it, which is what the serving path will find"
  );
});

test("what a run holds is asked of the filesystem once per file", async (t) => {
  const dirPath = await mkdtemp(path.join(os.tmpdir(), "usable-memo-"));
  t.after(async () => {
    await rm(dirPath, { recursive: true, force: true });
  });
  const runOne = path.join(dirPath, "run-1");
  await mkdir(runOne, { recursive: true });
  await writeFile(path.join(runOne, "segment-00000.mp4"), wholePiece(0));
  const known = new Set();

  usableSegmentIndices([runOne], fmp4Format, known);

  assert.deepEqual(
    [...known],
    [path.join(runOne, "segment-00000.mp4")],
    "a piece that has bytes never loses them, and this runs on the thread carrying the data channel"
  );
});

test("a run killed with a piece open leaves nothing behind", async (t) => {
  const dirPath = await mkdtemp(path.join(os.tmpdir(), "open-piece-"));
  t.after(async () => {
    await rm(dirPath, { recursive: true, force: true });
  });
  await writeFile(path.join(dirPath, "segment-00000.mp4"), wholePiece(0));
  await writeFile(path.join(dirPath, "segment-00001.mp4"), Buffer.alloc(0));

  assert.equal(await discardOpenPiece(dirPath, fmp4Format, null, null), 1);
  assert.deepEqual(
    await readdir(dirPath),
    ["segment-00000.mp4"],
    "only the piece that was open goes; everything the run finished stays"
  );
});

test("a run that finished its last piece keeps it", async (t) => {
  const dirPath = await mkdtemp(path.join(os.tmpdir(), "open-piece-good-"));
  t.after(async () => {
    await rm(dirPath, { recursive: true, force: true });
  });
  await writeFile(path.join(dirPath, "segment-00000.mp4"), wholePiece(0));
  await writeFile(path.join(dirPath, "segment-00001.mp4"), wholePiece(SEGMENT_SECONDS));

  assert.equal(
    await discardOpenPiece(dirPath, fmp4Format, null, () => true),
    null,
    "a stop between two cuts leaves good output; deleting it means encoding it twice"
  );
  assert.equal((await readdir(dirPath)).length, 2);
});

test("a last piece short of a track goes, even though it has bytes", async (t) => {
  const dirPath = await mkdtemp(path.join(os.tmpdir(), "open-piece-half-"));
  t.after(async () => {
    await rm(dirPath, { recursive: true, force: true });
  });
  await writeFile(path.join(dirPath, "segment-00000.mp4"), wholePiece(0));
  await writeFile(path.join(dirPath, "segment-00001.mp4"), halfPiece(SEGMENT_SECONDS));
  const init = fmp4Format.extractInit(wholePiece(0));

  assert.equal(
    await discardOpenPiece(dirPath, fmp4Format, null, (raw) =>
      fmp4Format.hasEveryTrack(fmp4Format.stripInit(raw), init)),
    1,
    "a size above zero is not the same as a piece that can be played"
  );
});
