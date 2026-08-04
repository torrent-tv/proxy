/**
 * Stamping a segment's position onto its fragments.
 *
 * A segment produced by the explicit-cut muxer holds SEVERAL fragments per
 * track — `frag_keyframe` opens one at every keyframe, while a cut point comes
 * only every few keyframes. Writing the segment's start into each of them made
 * them all claim the same decode time, and the player re-fetched the segment
 * forever. The positions inside a segment must therefore survive.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { stampSegmentStartTime } from "../services/segment-formats/mp4-boxes.js";

/**
 * @param {string} type
 * @param {Buffer} body
 * @returns {Buffer}
 */
function box(type, body) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, body]);
}

/**
 * One fragment: `moof > traf > (tfhd, tfdt)`, plus the payload it describes.
 *
 * @param {{ trackId: number, decodeTime: number, version?: 0 | 1 }} fragment
 * @returns {Buffer}
 */
function makeFragment({ trackId, decodeTime, version = 1 }) {
  const tfhdBody = Buffer.alloc(8);
  tfhdBody.writeUInt32BE(trackId, 4);
  const tfdtBody = Buffer.alloc(version === 1 ? 12 : 8);
  tfdtBody[0] = version;
  if (version === 1) {
    tfdtBody.writeBigUInt64BE(BigInt(decodeTime), 4);
  } else {
    tfdtBody.writeUInt32BE(decodeTime, 4);
  }
  const traf = box("traf", Buffer.concat([box("tfhd", tfhdBody), box("tfdt", tfdtBody)]));
  return Buffer.concat([box("moof", traf), box("mdat", Buffer.alloc(16, 0x5a))]);
}

/**
 * Every `tfdt` in order, as `[trackId, decodeTime]`.
 *
 * @param {Buffer} segment
 * @returns {Array<[number, number]>}
 */
function readDecodeTimes(segment) {
  const found = [];
  let offset = 0;
  let trackId = 0;
  while (offset + 8 <= segment.length) {
    const size = segment.readUInt32BE(offset);
    const type = segment.toString("latin1", offset + 4, offset + 8);
    if (type === "tfhd") {
      trackId = segment.readUInt32BE(offset + 12);
    } else if (type === "tfdt") {
      const version = segment[offset + 8];
      found.push([
        trackId,
        version === 1 ? Number(segment.readBigUInt64BE(offset + 12)) : segment.readUInt32BE(offset + 12)
      ]);
    }
    // Descend into the containers on the way to `tfdt`; skip anything else
    // whole, so `mdat` is never walked into.
    offset += type === "moof" || type === "traf" ? 8 : size;
  }
  return found;
}

test("fragments keep their distance from the start of the segment", () => {
  // A 6 s segment holding three fragments at 0, 2 and 4 s of its own clock —
  // the shape measured on the field host.
  const timescale = 16_000;
  const segment = Buffer.concat([
    makeFragment({ trackId: 1, decodeTime: 0 }),
    makeFragment({ trackId: 1, decodeTime: 2 * timescale }),
    makeFragment({ trackId: 1, decodeTime: 4 * timescale })
  ]);

  const stamped = stampSegmentStartTime(segment, 6, new Map([[1, timescale]]));

  assert.deepEqual(
    readDecodeTimes(stamped).map(([, time]) => time / timescale),
    [6, 8, 10],
    "each fragment must land at the segment's start plus its own offset"
  );
});

test("each track is shifted by its own base", () => {
  const videoScale = 16_000;
  const audioScale = 44_100;
  // Audio does not start at zero: its frames do not align with the video's.
  const segment = Buffer.concat([
    makeFragment({ trackId: 1, decodeTime: 0 }),
    makeFragment({ trackId: 2, decodeTime: 1024 }),
    makeFragment({ trackId: 1, decodeTime: 2 * videoScale }),
    makeFragment({ trackId: 2, decodeTime: 1024 + 2 * audioScale })
  ]);

  const stamped = stampSegmentStartTime(
    segment,
    6,
    new Map([
      [1, videoScale],
      [2, audioScale]
    ])
  );

  assert.deepEqual(readDecodeTimes(stamped), [
    [1, 6 * videoScale],
    [2, 6 * audioScale],
    [1, 8 * videoScale],
    [2, 8 * audioScale]
  ]);
});

test("a single fragment is written outright, as before", () => {
  const stamped = stampSegmentStartTime(
    makeFragment({ trackId: 1, decodeTime: 1280 }),
    12,
    new Map([[1, 16_000]])
  );
  assert.deepEqual(readDecodeTimes(stamped), [[1, 12 * 16_000]]);
});

test("a 32-bit field too small for the position is left alone", () => {
  const segment = makeFragment({ trackId: 1, decodeTime: 0, version: 0 });
  const stamped = stampSegmentStartTime(segment, 1_000_000, new Map([[1, 90_000]]));
  assert.deepEqual(
    readDecodeTimes(stamped),
    [[1, 0]],
    "a wrapped value would send the player somewhere arbitrary; leaving it is the lesser harm"
  );
});
