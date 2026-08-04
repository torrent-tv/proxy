/**
 * Splitting a self-contained fMP4 piece into an init segment and a media
 * segment.
 *
 * The muxer that takes explicit cut times writes every piece whole —
 * `ftyp moov moof mdat … mfra` — but HLS wants one init named by `#EXT-X-MAP`
 * and media segments carrying only fragments. Cutting at the wrong offset does
 * not fail loudly; it produces something that parses as garbage, which is why
 * the boundaries are pinned here rather than trusted.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { fmp4Format } from "../services/segment-formats/fmp4.js";

/**
 * A piece shaped like the muxer's output. Sizes are what matters, not contents.
 *
 * @param {{ withIndex?: boolean }} [options]
 * @returns {{ piece: Buffer, initLength: number, fragmentsLength: number }}
 */
function makePiece({ withIndex = true } = {}) {
  const box = (type, bodyLength) => {
    const buffer = Buffer.alloc(8 + bodyLength);
    buffer.writeUInt32BE(8 + bodyLength, 0);
    buffer.write(type, 4, "latin1");
    buffer.fill(0x5a, 8);
    return buffer;
  };
  const ftyp = box("ftyp", 24);
  const moov = box("moov", 400);
  const moof = box("moof", 120);
  const mdat = box("mdat", 900);
  const mfra = box("mfra", 40);
  const parts = withIndex ? [ftyp, moov, moof, mdat, mfra] : [ftyp, moov, moof, mdat];
  return {
    piece: Buffer.concat(parts),
    initLength: ftyp.length + moov.length,
    fragmentsLength: moof.length + mdat.length
  };
}

test("the init is everything before the first fragment", () => {
  const { piece, initLength } = makePiece();
  const init = fmp4Format.extractInit(piece);
  assert.ok(init, "no init found in a piece that has one");
  assert.equal(init.length, initLength, "init must end exactly where the first fragment begins");
  assert.equal(init.toString("latin1", 4, 8), "ftyp", "init must start at the file header");
});

test("the media segment is the fragments alone, index dropped", () => {
  const { piece, initLength, fragmentsLength } = makePiece();
  const media = fmp4Format.stripInit(piece);
  assert.equal(media.toString("latin1", 4, 8), "moof", "a media segment must begin at a fragment");
  assert.equal(
    media.length,
    fragmentsLength,
    "the trailing random-access index must be dropped: its offsets describe a file that no longer exists"
  );
  assert.equal(piece.length, initLength + fragmentsLength + 48, "test fixture sanity");
});

test("a piece without a trailing index keeps everything to the end", () => {
  const { piece, fragmentsLength } = makePiece({ withIndex: false });
  assert.equal(fmp4Format.stripInit(piece).length, fragmentsLength);
});

test("a segment that is already fragments-only is left alone", () => {
  const alreadyMedia = fmp4Format.stripInit(makePiece().piece);
  assert.deepEqual(
    fmp4Format.stripInit(alreadyMedia),
    alreadyMedia,
    "stripping twice must not eat the first fragment"
  );
  assert.equal(
    fmp4Format.extractInit(alreadyMedia),
    null,
    "there is no init to lift out of a media segment, and inventing one would corrupt playback"
  );
});
