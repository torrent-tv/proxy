/**
 * @file A piece short of a track is judged against ITS OWN header.
 *
 * The question "does this piece carry every track" has two possible answers and
 * they call for opposite actions, which is why asking it against the session's
 * cached header alone was not enough: a piece that disagrees with that header
 * may be short, or the header may be the odd one out. A self-contained piece
 * carries a `moov` of its own, so it can be compared with itself, and that
 * comparison tells the two apart without asking anything about encoders.
 *
 * WHAT THIS REPLACED. The action used to be chosen by "is any run of this
 * session alive?" — a question about the SESSION, asked about a fact of the
 * BYTES. A run anywhere in the film meant "still being written; waiting for
 * it", and nothing re-judged or re-made the piece afterwards, so one
 * misjudgement became permanent.
 *
 * Field 2026-09-14: `segment-00033.mp4` of a copied picture, already served
 * whole to one viewer at 5 099 421 bytes, was refused to a second viewer for
 * five minutes — four holds of sixty seconds each, then 503 — while the run in
 * force was at #192 and beyond. That viewer's picture stood still 196.2 s and
 * then a further 56.2 s.
 *
 * The run question is also unanswerable and does not need asking: a piece being
 * written is called `making-<tag>-NNNNN.mp4` and takes its served name by a
 * rename, which is atomic. A file under its served name is never being written.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { SourceFile } from "../services/media/SourceFile.js";
import { Timeline } from "../services/encode/output/Timeline.js";
import { managerWithOwnStore } from "./helpers/manager.js";
import { startRunOn } from "./helpers/encode-run.js";
import { fmp4Format } from "../services/encode/segment-formats/fmp4.js";
import { outputSpec } from "./helpers/output-spec.js";

const SESSION_ID = "3333333344445555";
const OUTPUT_KEY = "own-header:fmt=fmp4:grid=kf@0:video-only:v=0/copy";
const MOVIE_TIMESCALE = 1000;

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
 * @param {number} trackId
 * @returns {Buffer}
 */
function trak(trackId) {
  const tkhdBody = Buffer.alloc(84);
  tkhdBody.writeUInt32BE(trackId, 12);
  const mdhdBody = Buffer.alloc(20);
  mdhdBody.writeUInt32BE(90_000, 12);
  return box("trak", Buffer.concat([
    box("tkhd", tkhdBody),
    box("mdia", box("mdhd", mdhdBody))
  ]));
}

/**
 * A header declaring `tracks` tracks.
 *
 * @param {number} tracks
 * @returns {Buffer}
 */
function moovOf(tracks) {
  const mvhdBody = Buffer.alloc(100);
  mvhdBody.writeUInt32BE(MOVIE_TIMESCALE, 12);
  const traks = [];
  for (let id = 1; id <= tracks; id += 1) {
    traks.push(trak(id));
  }
  return box("moov", Buffer.concat([box("mvhd", mvhdBody), ...traks]));
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
 * A piece shaped like the `segment` muxer's output.
 *
 * @param {{ declares: number, carries: number }} shape - How many tracks its own
 *   header declares, and how many its fragments actually carry. The two differ
 *   only in a piece a run closed short.
 * @returns {Buffer}
 */
function selfContainedPiece({ declares, carries }) {
  const trafs = [];
  for (let id = 1; id <= carries; id += 1) {
    trafs.push(traf(id));
  }
  return Buffer.concat([
    box("ftyp", Buffer.alloc(16, 0)),
    moovOf(declares),
    box("moof", Buffer.concat(trafs)),
    box("mdat", Buffer.alloc(64, 0x5a)),
    box("mfra", Buffer.alloc(24, 0))
  ]);
}

/**
 * A manager with one session whose first two pieces are already on disk.
 *
 * @param {{ piece: Buffer, sessionHeader: Buffer }} params - The piece written
 *   for every number, and what the session has cached as its header.
 * @returns {Promise<{ manager: object, dirPath: string }>}
 */
async function managerHolding({ piece, sessionHeader }) {
  const { manager } = managerWithOwnStore();
  manager.segmentStore.useFormat(OUTPUT_KEY, fmp4Format);
  const dirPath = manager.segmentStore.directoryFor(OUTPUT_KEY);
  await writeFile(path.join(dirPath, "segment-00000.mp4"), piece);
  await writeFile(path.join(dirPath, "segment-00001.mp4"), piece);

  const session = {
    id: SESSION_ID,
    spec: outputSpec({ transcodeVideo: false }),
    outputKey: OUTPUT_KEY,
    dirPath,
    timeline: new Timeline({ boundaries: [0, 12.5, 25, 37.5, 50, 62.5], cutGrid: "uniform" }),
    state: "ready",
    file: new SourceFile({ sourceKey: "source-1", fileIndex: 0, name: "video.mkv" })
      .learn({ durationSeconds: 62.5 }),
    get inputFile() { return this.file; },
    get audioFile() { return this.file; },
    lastAloneSpeed: 2,
    startedAt: Date.now(),
    lastAccessedAt: Date.now(),
    runs: new Set(),
    lastError: "",
    segmentCount: 5,
    segmentFormat: fmp4Format,
    useSyntheticPlaylist: true,
    playlistText: "#EXTM3U\n",
    waitEpoch: 0
  };
  manager.outputs.set(SESSION_ID, session);
  // The header this output serves is the store's, one owner for it.
  manager.segmentStore.keepInit(OUTPUT_KEY, sessionHeader);
  // No plan runs here: this file is about the path that answers a request.
  manager.encodeRuns.planEncodersNow = () => {};
  manager.encodeRuns.planEncodersSoon = () => {};
  // A LIVE RUN, deliberately. Under the rule this replaced, a live run anywhere
  // was what turned a refusal into a permanent one — so both cases below are
  // asked with one running, which is the state the field failure happened in.
  startRunOn(session, { from: 0, usesExplicitCuts: true, speedX: 2 });
  return { manager, dirPath };
}

test("a piece that agrees with its own header is served, whatever the session's header says", async () => {
  // Two tracks declared, two carried: whole by its own account. The session's
  // cached header declares three — the state that cannot be told from a short
  // piece without asking the piece itself.
  const piece = selfContainedPiece({ declares: 2, carries: 2 });
  const { manager, dirPath } = await managerHolding({
    piece,
    sessionHeader: moovOf(3)
  });

  const answer = await manager.serving.getFileStream(SESSION_ID, "segment-00000.mp4");

  assert.equal(answer.kind, "file", "the piece is whole and must reach the viewer");
  await access(path.join(dirPath, "segment-00000.mp4"));
});

test("a piece that disagrees with its own header is removed, so it can be made again", async () => {
  // Two tracks declared, one carried: closed short by a run that was killed
  // mid-piece, which is what this check exists to catch.
  const piece = selfContainedPiece({ declares: 2, carries: 1 });
  const { manager, dirPath } = await managerHolding({
    piece,
    sessionHeader: moovOf(2)
  });

  const answer = await manager.serving.getFileStream(SESSION_ID, "segment-00000.mp4");

  assert.equal(answer.kind, "warming-up", "a short piece is not servable");
  await assert.rejects(
    () => access(path.join(dirPath, "segment-00000.mp4")),
    /ENOENT/,
    "and it is removed, or nothing will ever make it again"
  );
});

test("a live run elsewhere in the film does not make a short piece permanent", async () => {
  const piece = selfContainedPiece({ declares: 2, carries: 1 });
  const { manager, dirPath } = await managerHolding({
    piece,
    sessionHeader: moovOf(2)
  });
  // The field state exactly: the run in force is hundreds of segments ahead of
  // the piece being asked for.
  startRunOn(manager.outputs.get(SESSION_ID), { from: 192, usesExplicitCuts: true, speedX: 2 });

  await manager.serving.getFileStream(SESSION_ID, "segment-00000.mp4");

  await assert.rejects(
    () => access(path.join(dirPath, "segment-00000.mp4")),
    /ENOENT/,
    "a run a thousand segments away says nothing about these bytes"
  );
});
