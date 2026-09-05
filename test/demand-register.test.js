/**
 * @file What is wanted, by whom, and how urgently.
 *
 * These are the rules the download layer and the memory store both read, so a
 * defect here is a defect in two places at once. Everything is numbers: no
 * torrent, no library, no piece store.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { DemandRegister } from "../services/demand/DemandRegister.js";
import { unionOf, Window } from "../services/demand/Window.js";
import {
  isConditional,
  mayDisplaceSlowPeer,
  selectionPriority,
  Urgency
} from "../services/demand/Urgency.js";
import { nearestFirst, piecesNeededFor, piecesOf, piecesWithin } from "../services/demand/pieces.js";

const MEGABYTE = 1024 * 1024;

test("a window states bytes and refuses what it cannot mean", () => {
  const window = new Window({
    claimant: "video", fileIndex: 0, byteStart: 100, byteEnd: 199, urgency: Urgency.NEAR
  });
  assert.equal(window.byteLength, 100, "inclusive at both ends");

  assert.throws(() => new Window({
    claimant: "", fileIndex: 0, byteStart: 0, byteEnd: 1, urgency: 0
  }), /claimant/, "a window nobody can release is a leak with a name missing");
  assert.throws(() => new Window({
    claimant: "video", fileIndex: 0, byteStart: 200, byteEnd: 100, urgency: 0
  }), /Byte end/);
  assert.throws(() => new Window({
    claimant: "video", fileIndex: -1, byteStart: 0, byteEnd: 1, urgency: 0
  }), /File index/);
});

test("windows of different files are never merged", () => {
  const register = new DemandRegister();
  register.state({ claimant: "a", fileIndex: 0, byteStart: 0, byteEnd: 99, urgency: Urgency.NEAR });
  register.state({ claimant: "b", fileIndex: 1, byteStart: 0, byteEnd: 99, urgency: Urgency.NEAR });

  // Byte 50 of file 0 and byte 50 of file 1 are different bytes. Two viewers on
  // two episodes of one release is the ordinary case, not an edge one.
  assert.deepEqual(register.union(), [
    { byteStart: 0, byteEnd: 99 },
    { byteStart: 0, byteEnd: 99 }
  ]);
  assert.deepEqual(register.files(), [0, 1]);
});

test("the union of overlapping windows is their union, not their sum", () => {
  // Picture and sound are two readers of one file and their windows overlap by
  // construction. Adding them would report a demand that is not there.
  assert.deepEqual(
    unionOf([
      { byteStart: 0, byteEnd: 99 },
      { byteStart: 50, byteEnd: 149 }
    ]),
    [{ byteStart: 0, byteEnd: 149 }]
  );
  // Touching ranges are one run: 0-99 and 100-199 have nothing between them.
  assert.deepEqual(
    unionOf([
      { byteStart: 100, byteEnd: 199 },
      { byteStart: 0, byteEnd: 99 }
    ]),
    [{ byteStart: 0, byteEnd: 199 }]
  );
  assert.deepEqual(
    unionOf([
      { byteStart: 0, byteEnd: 99 },
      { byteStart: 200, byteEnd: 299 }
    ]),
    [{ byteStart: 0, byteEnd: 99 }, { byteStart: 200, byteEnd: 299 }],
    "a gap between them is a gap"
  );
});

test("a claimant states one window, and restating replaces it", () => {
  const register = new DemandRegister();
  register.state({ claimant: "video", fileIndex: 0, byteStart: 0, byteEnd: 99, urgency: Urgency.NEAR });
  register.state({ claimant: "video", fileIndex: 0, byteStart: 100, byteEnd: 199, urgency: Urgency.NEAR });

  // A reader walking a film restates its window many times a second. If those
  // accumulated, the download set would be the whole file within a minute.
  assert.equal(register.size, 1);
  assert.deepEqual(register.union(0), [{ byteStart: 100, byteEnd: 199 }]);
});

test("a withdrawal names its own claimant and nothing else", () => {
  const register = new DemandRegister();
  register.state({ claimant: "video", fileIndex: 0, byteStart: 0, byteEnd: 99, urgency: Urgency.NEAR });
  register.state({ claimant: "audio", fileIndex: 0, byteStart: 0, byteEnd: 99, urgency: Urgency.NEAR });

  assert.equal(register.withdraw("audio"), true);
  assert.equal(register.withdraw("audio"), false, "a second release withdraws nothing");
  assert.equal(register.withdraw("nobody"), false, "a stray release matches nothing");
  assert.equal(register.size, 1, "and video still wants what it wanted");
});

test("the speculative levels are stated only while nothing urgent is missing", () => {
  const register = new DemandRegister();
  register.state({ claimant: "video", fileIndex: 0, byteStart: 0, byteEnd: 99, urgency: Urgency.BLOCKED });
  register.state({ claimant: "fill", fileIndex: 0, byteStart: 1000, byteEnd: 9999, urgency: Urgency.TAIL });
  register.state({ claimant: "back", fileIndex: 0, byteStart: 0, byteEnd: 999, urgency: Urgency.BEHIND });

  // Something urgent is missing: the speculative levels are not stated at all.
  // Withdrawn, not lowered — a withdrawn window is not in the download set, so
  // a peer with nothing urgent to give cannot fall through to it and spend the
  // shared link on a piece nobody is waiting for.
  assert.deepEqual(
    register.levelsToState((window) => window.urgency !== Urgency.BLOCKED),
    [Urgency.BLOCKED, Urgency.NEAR, Urgency.AHEAD]
  );

  // Everything urgent has arrived: they are stated, in order.
  assert.deepEqual(
    register.levelsToState(() => true),
    [Urgency.BLOCKED, Urgency.NEAR, Urgency.AHEAD, Urgency.TAIL, Urgency.BEHIND]
  );

  // The tail is complete but the gap behind is not: the gap stays stated and
  // nothing below it exists to withhold.
  assert.deepEqual(
    register.levelsToState((window) => window.urgency !== Urgency.BEHIND),
    [Urgency.BLOCKED, Urgency.NEAR, Urgency.AHEAD, Urgency.TAIL, Urgency.BEHIND]
  );
});

test("only the level being waited on may take a block from a slow peer", () => {
  assert.equal(mayDisplaceSlowPeer(Urgency.BLOCKED), true);
  for (const urgency of [Urgency.NEAR, Urgency.AHEAD, Urgency.TAIL, Urgency.BEHIND]) {
    assert.equal(mayDisplaceSlowPeer(urgency), false);
  }
});

test("the library is given the only distinction it keeps", () => {
  // Measured against the vendored 2.8.5: distinct non-zero priorities order the
  // selection list once and are round-robined afterwards by `shufflePriority`.
  // Zero is the only value that stays put, always last.
  assert.equal(selectionPriority(Urgency.BLOCKED), 1);
  assert.equal(selectionPriority(Urgency.NEAR), 1);
  assert.equal(selectionPriority(Urgency.AHEAD), 1);
  assert.equal(selectionPriority(Urgency.TAIL), 0);
  assert.equal(selectionPriority(Urgency.BEHIND), 0);

  assert.equal(isConditional(Urgency.AHEAD), false);
  assert.equal(isConditional(Urgency.TAIL), true);
});

test("bytes become pieces in one place, and a partial piece is a whole piece", () => {
  const pieceLength = 4 * MEGABYTE;
  // A file starting one piece into the torrent, wanting its first byte.
  assert.deepEqual(
    piecesOf({ fileOffset: pieceLength, byteStart: 0, byteEnd: 0, pieceLength }),
    { from: 1, to: 1 }
  );
  // A range ending one byte into the next piece still needs that whole piece:
  // the protocol delivers and verifies nothing smaller.
  assert.deepEqual(
    piecesOf({ fileOffset: 0, byteStart: 0, byteEnd: pieceLength, pieceLength }),
    { from: 0, to: 1 }
  );
  assert.equal(piecesOf({ fileOffset: 0, byteStart: 10, byteEnd: 5, pieceLength }), null);
  assert.equal(piecesOf({ fileOffset: 0, byteStart: 0, byteEnd: 1, pieceLength: 0 }), null);
});

test("a budget buys whole places, and a window needs one more than it measures", () => {
  const pieceLength = 16 * MEGABYTE;
  // The failure this rounding hid: 64 MB of allowance is four places, and two
  // readers asking for 96 MB each want six. Counted in bytes the shortage is
  // plain; counted in floored pieces it is not.
  assert.equal(piecesWithin(64 * MEGABYTE, pieceLength), 4);
  assert.equal(piecesNeededFor(96 * MEGABYTE, pieceLength), 7, "six, plus the one it can straddle");
  assert.equal(piecesWithin(0, pieceLength), 0);
  assert.equal(piecesNeededFor(0, pieceLength), 0);
});

test("the gap behind the playhead is stated nearest first", () => {
  // WebTorrent walks a selection from its start upwards, so one claim over
  // everything behind the viewer would be fetched from the beginning of the
  // file — the end furthest from where a backward seek lands.
  const ranges = nearestFirst({ byteStart: 0, byteEnd: 999, parts: 4 });
  assert.equal(ranges.length, 4);
  assert.equal(ranges[0].byteEnd, 999, "the part nearest the playhead comes first");
  assert.equal(ranges[ranges.length - 1].byteStart, 0, "and the furthest comes last");
  for (const range of ranges) {
    assert.ok(range.byteStart <= range.byteEnd);
  }
  assert.deepEqual(nearestFirst({ byteStart: 10, byteEnd: 5, parts: 2 }), []);
});

test("a byte is as urgent as the most urgent thing that wants it", () => {
  const register = new DemandRegister();
  register.state({ claimant: "map:tail", fileIndex: 0, byteStart: 0, byteEnd: 999, urgency: Urgency.TAIL });
  register.state({ claimant: "map:near", fileIndex: 0, byteStart: 400, byteEnd: 599, urgency: Urgency.NEAR });

  assert.equal(register.urgencyAt(0, 100), Urgency.TAIL);
  assert.equal(register.urgencyAt(0, 500), Urgency.NEAR, "the overlap took the less urgent of the two");
  assert.equal(register.urgencyAt(0, 5000), null, "a byte nobody wants reported a level anyway");
  assert.equal(register.urgencyAt(1, 500), null, "byte 500 of another file is not this byte");
});
