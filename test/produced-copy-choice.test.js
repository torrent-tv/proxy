/**
 * @file A piece that cannot be played: waited for, or removed and made again.
 *
 * Field 2026-09-03. A run was suspended 548 ms after it started with
 * `segment-00025.mp4` newly opened, so the file stayed at zero bytes. From then
 * on the two halves of the proxy disagreed about it and neither could see the
 * other's reason: the look-ahead counted the NAME, found the numbering unbroken
 * through #83, called it `420s ahead of the viewer` and kept the encoder
 * stopped; the serving path read the FILE, found it short of a track, and
 * waited for a run that had produced nothing to finish it.
 *
 * The viewer's picture stood still for ten minutes on a transport measuring
 * 3-9 ms round trip.
 *
 * The question of WHICH copy answers is gone with the directory-per-run scheme:
 * there is one directory per output, runs are kept apart by their stretches,
 * and one name is one file. What is left is the question that remains real —
 * whether a file that cannot be played is being written now or was left by a
 * run that has ended.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { SourceFile } from "../services/source/SourceFile.js";
import { Timeline } from "../services/output/Timeline.js";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HlsSessionManager, usableSegmentIndices } from "../services/hls-session-manager.js";
import { discardOpenPiece } from "../services/encode/open-piece.js";
import { startRunOn } from "./helpers/encode-run.js";
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
 * A session with the output directory every run writes into.
 *
 * @returns {Promise<{ manager: HlsSessionManager, session: object, dirPath: string }>}
 */
async function sessionOnOneDirectory() {
  const dirPath = await mkdtemp(path.join(os.tmpdir(), "produced-copy-"));
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
      boundaries: [0, SEGMENT_SECONDS, 25, 37.5, 50],
      cutGrid: "uniform"
    }),
    state: "ready",
    file: new SourceFile({ sourceKey: "source-1", fileIndex: 0, name: "Drifters - 04.mkv" }),
    // An ordinary session reads its own file, and its sound is inside it. The
    // three differ only for a soundtrack shipped as a file of its own.
    get inputFile() { return this.file; },
    get audioFile() { return this.file; },
    startedAt: Date.now(),
    createEntryMs: Date.now(),
    lastAccessedAt: Date.now(),
    runs: new Set(),
    lastError: "",
    consumers: new Set(),
    viewers: new Map(),
    segmentFormat: fmp4Format,
    useSyntheticPlaylist: true,
    playlistText: "#EXTM3U\n",
    initBytes: fmp4Format.extractInit(wholePiece(0)),
    firstSegmentLogged: false,
    waitEpoch: 0
  };
  manager.sessionsById.set(SESSION_ID, session);
  // A run exists and is alive — the state the field case was in, and the one in
  // which the old test called every leftover "still being written".
  startRunOn(session, { from: 0, usesExplicitCuts: true });
  return { manager, session, dirPath };
}



test("a leftover of a run that has ended is not served, and answering does not delete it", async (t) => {
  const { manager, session, dirPath } = await sessionOnOneDirectory();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  // Opened by a run that is gone. It has a name and no bytes, so there is
  // nothing to serve.
  session.runs = new Set();
  await writeFile(path.join(dirPath, "segment-00001.mp4"), Buffer.alloc(0));

  const result = await manager.getFileStream(SESSION_ID, "segment-00001.mp4", { requestSeq: 1 });

  assert.equal(result.kind, "warming-up", "nothing servable exists yet, so the viewer waits");
  // AND ANSWERING A REQUEST DELETES NOTHING. It used to: this test was written
  // when the serving path cleared up after ended runs, and several runs of an
  // output share one directory — so what a request removed could be the piece a
  // LIVE run had just finished. Clearing up belongs to the ending of a run,
  // which is the only thing that knows what it left open and what it named
  // (`discardOpenPiece`, checked directly below). A file with no bytes is
  // ignored by everything that reads the directory, so leaving it costs nothing
  // and deleting it from here costs a segment.
  const left = (await readdir(dirPath)).filter((name) => name === "segment-00001.mp4");
  assert.deepEqual(left, ["segment-00001.mp4"]);
});

test("the current run's own unfinished piece is waited for, never deleted", async (t) => {
  const { manager, session, dirPath } = await sessionOnOneDirectory();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  // The same file, in the directory of the run that is alive. It is being
  // written right now. Deleting it is the 2026-08-06 incident: #225 was removed
  // 14 s into the run producing it, which then wrote on into a file nobody
  // could open, and the segment never appeared.
  //
  // The live run begins at #1, so #1 is its own first piece.
  startRunOn(session, { from: 1, producing: false, usesExplicitCuts: true });
  await writeFile(path.join(dirPath, "segment-00001.mp4"), Buffer.alloc(0));

  const result = await manager.getFileStream(SESSION_ID, "segment-00001.mp4", { requestSeq: 1 });

  assert.equal(result.kind, "warming-up");
  const left = (await readdir(dirPath)).filter((name) => name === "segment-00001.mp4");
  assert.deepEqual(left, ["segment-00001.mp4"], "the live run's own output must be left alone");
});

test("the look-ahead does not count a file with nothing in it", async (t) => {
  const dirPath = await mkdtemp(path.join(os.tmpdir(), "usable-indices-"));
  t.after(async () => {
    await rm(dirPath, { recursive: true, force: true });
  });
  await writeFile(path.join(dirPath, "segment-00000.mp4"), wholePiece(0));
  await writeFile(path.join(dirPath, "segment-00001.mp4"), Buffer.alloc(0));

  assert.deepEqual(
    [...usableSegmentIndices([dirPath], fmp4Format, new Set())].sort((a, b) => a - b),
    [0],
    "an empty file bridged the hole and bought the encoder a suspension it had not earned"
  );

  // The same number, made properly: now it genuinely is ready.
  await writeFile(path.join(dirPath, "segment-00001.mp4"), wholePiece(SEGMENT_SECONDS));
  assert.deepEqual(
    [...usableSegmentIndices([dirPath], fmp4Format, new Set())].sort((a, b) => a - b),
    [0, 1],
    "a copy with bytes in it, which is what the serving path will find"
  );
});

test("what the output holds is asked of the filesystem once per file", async (t) => {
  const dirPath = await mkdtemp(path.join(os.tmpdir(), "usable-memo-"));
  t.after(async () => {
    await rm(dirPath, { recursive: true, force: true });
  });
  await writeFile(path.join(dirPath, "segment-00000.mp4"), wholePiece(0));
  const known = new Set();

  usableSegmentIndices([dirPath], fmp4Format, known);

  assert.deepEqual(
    [...known],
    [path.join(dirPath, "segment-00000.mp4")],
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

  // WHAT THE RUN NAMED IS WHAT IT FINISHED. It named #0 on the ready channel and
  // was killed with #1 open, so #1 goes and #0 stays. Asking the file instead
  // cannot answer: a piece cut short still decodes, which is how 3.92 s of a
  // declared 5.589 s reached a viewer on 2026-09-06.
  assert.equal(
    await discardOpenPiece(dirPath, fmp4Format, { from: 0, to: 1 }, null, "segment-00000.mp4"),
    1
  );
  assert.deepEqual(
    await readdir(dirPath),
    ["segment-00000.mp4"],
    "only the piece that was open goes; everything the run named stays"
  );
});

test("a run that named nothing can only have opened the first piece it was given", async (t) => {
  const dirPath = await mkdtemp(path.join(os.tmpdir(), "open-piece-unnamed-"));
  t.after(async () => {
    await rm(dirPath, { recursive: true, force: true });
  });
  await writeFile(path.join(dirPath, "segment-00000.mp4"), wholePiece(0));
  await writeFile(path.join(dirPath, "segment-00001.mp4"), wholePiece(SEGMENT_SECONDS));

  // THE CASE THIS CONTRACT WAS WRITTEN FOR. ffmpeg names a piece as it closes it
  // and opens the next, so a run that named nothing had only its first open. It
  // used to search the whole directory and take the highest number in it —
  // every run of an output writes into that one directory, so what it took was
  // a piece a LIVE run had just finished. Field 2026-09-06: the piece holding
  // 2:47-2:57 went that way, its number is spent for good because names only
  // grow, and the picture stood still for 647 s.
  assert.equal(await discardOpenPiece(dirPath, fmp4Format, null, null), 0);
  assert.deepEqual(
    await readdir(dirPath),
    ["segment-00001.mp4"],
    "the piece belonging to somebody else is not touched"
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
    await discardOpenPiece(dirPath, fmp4Format, { from: 0, to: 1 }, () => true, "segment-00001.mp4"),
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
    await discardOpenPiece(dirPath, fmp4Format, { from: 0, to: 1 }, (raw) =>
      fmp4Format.hasEveryTrack(fmp4Format.stripInit(raw), init), "segment-00001.mp4"),
    1,
    "a size above zero is not the same as a piece that can be played"
  );
});
