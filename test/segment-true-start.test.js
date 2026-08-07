/**
 * @file A segment must be stamped with where it really begins.
 *
 * The playlist's answer comes from the container's keyframe index, and an index
 * can be wrong. Measured 2026-08-06 on a Matroska file whose index claimed a
 * keyframe at 157.99 s: the real ones around there were 153.820 and 164.247, so
 * ffmpeg cut at 153.820 and the segment was stamped 157.99 — telling the player
 * that picture belonged 4.17 s later than it did, while the subtitles, taken
 * straight from the source, kept the true times. Speech and text drifted apart
 * by exactly that much.
 *
 * The piece itself knows better: the `segment` muxer records its position as an
 * empty edit at the head of the track's edit list.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readSelfContainedStartSeconds } from "../services/segment-formats/mp4-boxes.js";

/**
 * A minimal MP4 carrying `moov > mvhd` and `moov > trak > edts > elst`, with a
 * leading empty edit of `offsetSeconds`.
 *
 * @param {{ offsetSeconds: number, timescale?: number, version?: 0 | 1 }} shape
 * @returns {Buffer}
 */
function pieceWithEmptyEdit({ offsetSeconds, timescale = 1000, version = 0 }) {
  const box = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + body.length, 0);
    head.write(type, 4, "latin1");
    return Buffer.concat([head, body]);
  };

  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt8(0, 0);                       // version 0
  mvhd.writeUInt32BE(timescale, 12);           // timescale

  const duration = Math.round(offsetSeconds * timescale);
  let elstBody;
  if (version === 1) {
    elstBody = Buffer.alloc(8 + 20);
    elstBody.writeUInt8(1, 0);
    elstBody.writeUInt32BE(1, 4);              // one entry
    elstBody.writeBigUInt64BE(BigInt(duration), 8);
    elstBody.writeBigInt64BE(-1n, 16);         // empty edit
  } else {
    elstBody = Buffer.alloc(8 + 12);
    elstBody.writeUInt8(0, 0);
    elstBody.writeUInt32BE(1, 4);              // one entry
    elstBody.writeUInt32BE(duration, 8);
    elstBody.writeInt32BE(-1, 12);             // empty edit
  }

  return Buffer.concat([
    box("ftyp", Buffer.alloc(16)),
    box("moov", Buffer.concat([
      box("mvhd", mvhd),
      box("trak", box("edts", box("elst", elstBody)))
    ]))
  ]);
}

test("the position is read from the empty edit, in seconds", () => {
  assert.equal(readSelfContainedStartSeconds(pieceWithEmptyEdit({ offsetSeconds: 153.82 })), 153.82);
  assert.equal(readSelfContainedStartSeconds(pieceWithEmptyEdit({ offsetSeconds: 0 })), 0);
});

test("a 64-bit edit list is read the same way", () => {
  const piece = pieceWithEmptyEdit({ offsetSeconds: 4321.5, version: 1 });
  assert.equal(readSelfContainedStartSeconds(piece), 4321.5);
});

test("the movie timescale is honoured, not assumed", () => {
  const piece = pieceWithEmptyEdit({ offsetSeconds: 12.5, timescale: 90_000 });
  assert.equal(
    readSelfContainedStartSeconds(piece),
    12.5,
    "reading the duration without dividing by the file's own timescale would give 1 125 000"
  );
});

test("a piece with no edit list says nothing rather than guessing", () => {
  const bare = Buffer.concat([Buffer.alloc(8), Buffer.from("ftyp", "latin1")]);
  assert.equal(readSelfContainedStartSeconds(bare), null);
});
