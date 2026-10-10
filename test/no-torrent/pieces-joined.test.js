import test from "node:test";
import assert from "node:assert/strict";
import { joinedWithinPieces, piecesOf } from "../../services/torrent/demand/pieces.js";

// Arithmetic only; no torrent.
//
// Ranges closer than a piece are stated to the torrent as one
// (torrent-tv/meta#166: one range per packet of an AVI soundtrack made a map
// of 350 191 zones). What the torrent fetches must not change.

function numbers(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** Every piece any of the ranges touches. */
function piecesTouched(ranges, fileOffset, pieceLength) {
  const pieces = new Set();
  for (const [byteStart, byteEnd] of ranges) {
    const { from, to } = piecesOf({ fileOffset, byteStart, byteEnd, pieceLength });
    for (let piece = from; piece <= to; piece++) pieces.add(piece);
  }
  return [...pieces].sort((left, right) => left - right);
}

test("ranges closer than a piece are joined and touch exactly the same pieces", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const random = numbers(seed);
    const pieceLength = 1 + Math.floor(random() * 5000);
    const fileOffset = Math.floor(random() * 3 * pieceLength);
    const ranges = [];
    let at = Math.floor(random() * pieceLength);
    for (let count = 0; count < 60; count++) {
      const length = 1 + Math.floor(random() * pieceLength * 0.3);
      ranges.push([at, at + length - 1]);
      at += length + Math.floor(random() * pieceLength * (random() < 0.2 ? 4 : 1.2));
    }
    const joined = joinedWithinPieces(ranges, pieceLength);
    assert.deepEqual(piecesTouched(joined, fileOffset, pieceLength), piecesTouched(ranges, fileOffset, pieceLength), `seed ${seed}`);
    for (let index = 1; index < joined.length; index++) {
      assert.ok(joined[index][0] - joined[index - 1][1] - 1 >= pieceLength, `seed ${seed}: a gap shorter than a piece is left`);
    }
  }
});

test("a gap of a whole piece is kept, and an unusable piece length changes nothing", () => {
  assert.deepEqual(joinedWithinPieces([[0, 9], [20, 29]], 10), [[0, 9], [20, 29]]);
  assert.deepEqual(joinedWithinPieces([[0, 9], [19, 29]], 10), [[0, 29]]);
  const ranges = [[0, 9], [12, 20]];
  assert.equal(joinedWithinPieces(ranges, Number.NaN), ranges);
});
