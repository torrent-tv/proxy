import test from "node:test";
import assert from "node:assert/strict";
import { passInputs, samePass } from "../../services/viewer/playback-pass.js";

// Arithmetic only; no torrent.
//
// A pass that turns a playback map into bytes hands back what the last pass
// resolved when it is worked out from the same things (torrent-tv/meta#178).

const tracks = [{ type: "video" }];
const demand = (index, extra = {}) => ({ outputKey: "picture", index, priority: 100, urgent: true, behind: false,
  deferred: false, from: index * 4, to: index * 4 + 4, sourceInterval: { from: index * 4, to: index * 4 + 4 },
  deadlineAt: 1_000 + index * 4_000, ...extra });
const passOf = (demands, { targets = new Map([["picture", 8_000_000]]), pieceLength = 4_194_304, shift = 0 } = {}) =>
  ({ tracks, ...passInputs({ pieceLength, shift, targets, demands }) });

test("deadlines worked out on a later clock do not make a pass new", () => {
  const before = passOf([demand(0), demand(1), demand(2)]);
  const later = passOf([demand(0, { deadlineAt: 1_900 }), demand(1, { deadlineAt: 5_900 }), demand(2, { deadlineAt: 9_900 })]);
  assert.ok(samePass(before, later));
});

test("a pass is new when what it asks for, or in what order, has changed", () => {
  const before = passOf([demand(0), demand(1), demand(2)]);
  // Another order of deadlines.
  assert.ok(!samePass(before, passOf([demand(1), demand(0), demand(2)])));
  // A segment made meanwhile is no longer asked for.
  assert.ok(!samePass(before, passOf([demand(1), demand(2)])));
  // Another level or priority.
  assert.ok(!samePass(before, passOf([demand(0), demand(1, { urgent: false }), demand(2)])));
  assert.ok(!samePass(before, passOf([demand(0), demand(1), demand(2, { priority: 99 })])));
  // A cut grid read again gives a number another interval.
  assert.ok(!samePass(before, passOf([demand(0), demand(1, { sourceInterval: { from: 4.04, to: 8 } }), demand(2)])));
  // Another target for the next run's input, another precision, another clock.
  assert.ok(!samePass(before, passOf([demand(0), demand(1), demand(2)], { targets: new Map([["picture", 9_000_000]]) })));
  assert.ok(!samePass(before, passOf([demand(0), demand(1), demand(2)], { pieceLength: 2_097_152 })));
  assert.ok(!samePass(before, passOf([demand(0), demand(1), demand(2)], { shift: 0.5 })));
  // Another output beside it.
  assert.ok(!samePass(before, passOf([demand(0), demand(1), demand(2)],
    { targets: new Map([["picture", 8_000_000], ["sound", null]]) })));
  // Other tracks.
  assert.ok(!samePass(before, { ...before, tracks: [{ type: "video" }] }));
  assert.ok(!samePass(undefined, before));
});
