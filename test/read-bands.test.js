/**
 * @file Claiming what a reader wants in four bands instead of one.
 *
 * Until now a reader claimed one band at one urgency, and WebTorrent's own
 * whole-file selection sat under it at priority 0 — so "what the viewer reaches
 * in seconds" and "the rest of the film" were indistinguishable to the picker.
 * The bands separate them, and their widths come from what has been measured
 * about this file on this swarm rather than from numbers chosen here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { bandWidthsFrom, bandsFrom, sameBands } from "../services/torrent-worker/piece-reader.js";
import { Urgency } from "../services/demand/Urgency.js";

const PIECE = 8 * 1024 * 1024;

test("the urgent band is the one being read, and the lead bands come behind it in order", () => {
  const bands = bandsFrom({
    urgent: { from: 100, to: 103 },
    pieceIndex: 100,
    firstPiece: 0,
    lastPiece: 1000,
    widths: { near: 5, far: 20 }
  });

  assert.deepEqual(
    bands,
    [
      { from: 100, to: 103, urgency: Urgency.NEAR },
      { from: 104, to: 108, urgency: Urgency.AHEAD },
      { from: 109, to: 128, urgency: Urgency.AHEAD }
    ],
    "no gap, no overlap, and each band strictly less urgent than the one in front"
  );
});

test("no band is speculative while the reader is still walking the file", () => {
  const bands = bandsFrom({
    urgent: { from: 0, to: 1 },
    pieceIndex: 0,
    firstPiece: 0,
    lastPiece: 100,
    widths: { near: 2, far: 2 }
  });

  assert.ok(
    bands.every((band) => band.urgency <= Urgency.AHEAD),
    "a band at 0 would be indistinguishable from the background fill of the whole torrent"
  );
});

test("what was never downloaded behind the viewer is not asked for until the lead reaches the end", () => {
  const stillFilling = bandsFrom({
    urgent: { from: 50, to: 52 },
    pieceIndex: 50,
    firstPiece: 0,
    lastPiece: 1000,
    widths: { near: 4, far: 8 }
  });
  assert.equal(
    stillFilling.length,
    3,
    "the film ahead is not covered yet, so the past must not compete with it"
  );

  const covered = bandsFrom({
    urgent: { from: 50, to: 52 },
    pieceIndex: 50,
    firstPiece: 0,
    lastPiece: 60,
    widths: { near: 4, far: 8 }
  });
  assert.deepEqual(
    covered[covered.length - 1],
    { from: 0, to: 49, urgency: Urgency.BEHIND },
    "once there is nothing left ahead, the gap behind the viewer is worth filling"
  );
});

test("a swarm with no surplus produces no far band, because there is nothing to get ahead with", () => {
  const widths = bandWidthsFrom({
    worstWaitSec: 2,
    medianIntervalSec: 10,
    downloadBytesPerSec: 1_000_000,
    consumeBytesPerSec: 1_000_000,
    pieceLength: PIECE,
    basePieces: 4
  });

  assert.equal(widths.far, 0, "download rate equals consumption, so no lead can be built");
  assert.equal(widths.measured, true);
});

test("the near band covers the worst interruption this reader has actually met", () => {
  // 4 s of a film eaten at 2 MB/s is 8 MB, which is one piece here.
  const widths = bandWidthsFrom({
    worstWaitSec: 4,
    medianIntervalSec: 30,
    downloadBytesPerSec: 3_000_000,
    consumeBytesPerSec: 2_000_000,
    pieceLength: PIECE,
    basePieces: 4
  });

  assert.equal(widths.near, 1, "worst wait × consumption, in pieces");
  // A surplus of 1 MB/s held for 30 s is 30 MB, which is four pieces here.
  assert.equal(widths.far, 4, "surplus × the interval it usually runs for, in pieces");
});

test("with nothing measured yet both lead bands fall back to the reader's own window", () => {
  const widths = bandWidthsFrom({
    worstWaitSec: null,
    medianIntervalSec: null,
    downloadBytesPerSec: 5_000_000,
    consumeBytesPerSec: 0,
    pieceLength: PIECE,
    basePieces: 6
  });

  assert.deepEqual(widths, { near: 6, far: 6, measured: false });
});

test("an unchanged claim is recognised, so it is not released and re-made on every read", () => {
  const bands = [
    { from: 1, to: 2, urgency: Urgency.NEAR },
    { from: 3, to: 9, urgency: Urgency.AHEAD }
  ];

  assert.equal(sameBands(bands, [...bands.map((band) => ({ ...band }))]), true);
  assert.equal(sameBands(bands, [{ from: 1, to: 2, urgency: Urgency.NEAR }]), false);
  assert.equal(
    sameBands(bands, [
      { from: 1, to: 2, urgency: Urgency.NEAR },
      { from: 3, to: 9, urgency: Urgency.BEHIND }
    ]),
    false,
    "the same range at another urgency is a different claim"
  );
});
