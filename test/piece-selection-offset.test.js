/**
 * @file What WebTorrent's own selection bookkeeping does when a seek demotes
 * the pieces behind the playhead.
 *
 * This is the library's behaviour, not ours, and `prioritizeByteRange` depends
 * on it: a selection carries an `offset` — how many pieces from its start are
 * already downloaded — and the picker scans from `from + offset`
 * (`torrent.js`, `for (piece = next.from + next.offset; piece <= next.to; …)`).
 * `deselect` subtracts an interval and copies that offset into what survives,
 * so the remaining selection can end up scanning past its own end and yield
 * nothing at all.
 *
 * Measured consequence before the fix: a seek to 89.1% of a 4.7 GB film left
 * the seek target wanted by nobody, a later range-less read re-selected the
 * whole file, and the swarm walked it from the first missing piece — 2.47 GB
 * over 93 s before the segment could be served.
 *
 * If a WebTorrent upgrade changes any of this, these tests fail rather than the
 * behaviour silently regressing.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Selections } from "webtorrent/lib/selections.js";

// The numbers are the measured session: 588 pieces of 8 MiB, sequential
// download had reached 38.4% (piece 226), the viewer seeked to 89.1% (piece
// 523).
const LAST_PIECE = 587;
const DOWNLOADED_TO = 226;
const PLAYHEAD = 523;

/** Where the picker would start scanning this selection. */
const scanStart = (selection) => selection.from + selection.offset;

test("deselecting the gap behind the playhead leaves a selection that yields nothing", () => {
  const selections = new Selections();
  selections.insert({ from: 0, to: LAST_PIECE, offset: 0, priority: 1 });
  // What `_gcSelections` does as pieces arrive.
  selections.get(0).offset = DOWNLOADED_TO;

  selections.remove({ from: 0, to: PLAYHEAD - 1, isStreamSelection: false });

  assert.equal(selections.length, 1);
  const survivor = selections.get(0);
  assert.equal(survivor.from, PLAYHEAD, "the surviving selection starts at the playhead");
  assert.equal(survivor.offset, DOWNLOADED_TO, "and it kept the offset of the range it came from");
  assert.ok(
    scanStart(survivor) > survivor.to,
    `scan would start at piece ${scanStart(survivor)} of ${survivor.to} — nothing is downloadable`
  );
});

test("re-selecting the same range restores a scan that starts at the playhead", () => {
  const selections = new Selections();
  selections.insert({ from: 0, to: LAST_PIECE, offset: 0, priority: 1 });
  selections.get(0).offset = DOWNLOADED_TO;

  // Exactly what prioritizeByteRange does on a forward seek.
  selections.remove({ from: 0, to: PLAYHEAD - 1, isStreamSelection: false });
  selections.insert({ from: PLAYHEAD, to: LAST_PIECE, offset: 0, priority: 1 });

  assert.equal(selections.length, 1, "the dead selection was replaced, not added to");
  const selection = selections.get(0);
  assert.equal(scanStart(selection), PLAYHEAD, "the picker now starts at the seek target");
  assert.equal(selection.to, LAST_PIECE);
});

test("selecting the whole file again undoes the demotion", () => {
  const selections = new Selections();
  selections.insert({ from: 0, to: LAST_PIECE, offset: 0, priority: 1 });
  selections.get(0).offset = DOWNLOADED_TO;
  selections.remove({ from: 0, to: PLAYHEAD - 1, isStreamSelection: false });
  selections.insert({ from: PLAYHEAD, to: LAST_PIECE, offset: 0, priority: 1 });

  // A range-less read reporting position 0 used to land here.
  selections.insert({ from: 0, to: LAST_PIECE, offset: 0, priority: 1 });

  assert.equal(selections.length, 1);
  assert.equal(
    scanStart(selections.get(0)),
    0,
    "the whole file is selected again, so the picker falls back to the first missing piece"
  );
});
