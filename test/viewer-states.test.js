/**
 * @file The three states a viewer can be in, and what each is worth.
 *
 * Written against the failure of 2026-09-14: a page whose tab was hidden for
 * 145 seconds, which had measured nothing and therefore said nothing, was
 * carried 146 seconds into a film it had not begun — and the soundtrack's
 * encoder was placed there while the browser asked for segment #0 and was
 * refused for sixty seconds.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { Viewer } from "../services/viewer/Viewer.js";

const AT = 1_000_000;

test("a viewer who has stated nothing does not move, however long they are silent", () => {
  const viewer = new Viewer("one", AT);
  viewer.moveTo(0, AT);

  // 146 seconds of silence — the field figure exactly.
  assert.equal(viewer.positionSeconds(AT + 146_000), 0);
});

test("a viewer who has stated nothing is waiting, and their work is due now", () => {
  const viewer = new Viewer("one", AT);
  viewer.moveTo(0, AT);

  assert.equal(viewer.playing, false);
  assert.equal(viewer.waiting, true);
  assert.equal(viewer.wantsFilmNow(), true);
});

test("a playing viewer moves with the film, and no further than what they hold", () => {
  const viewer = new Viewer("one", AT);
  viewer.report({ bufferedAheadSec: 30, positionSeconds: 100, playing: true, waiting: false }, AT);

  // Ten seconds of silence, ten seconds of film.
  assert.equal(viewer.positionSeconds(AT + 10_000), 110);
  // Two minutes of silence buys only the thirty seconds they said they held.
  assert.equal(viewer.positionSeconds(AT + 120_000), 130);
});

test("a viewer holding nothing cannot move at all, even reported as playing", () => {
  const viewer = new Viewer("one", AT);
  viewer.report({ bufferedAheadSec: 0, positionSeconds: 0, playing: true, waiting: false }, AT);

  assert.equal(viewer.positionSeconds(AT + 146_000), 0);
});

test("a viewer who stopped the picture is not waiting, and nothing of theirs falls due", () => {
  const viewer = new Viewer("one", AT);
  viewer.report({ bufferedAheadSec: 42, positionSeconds: 100, playing: false, waiting: false }, AT);

  assert.equal(viewer.wantsFilmNow(), false);
  assert.equal(viewer.positionSeconds(AT + 60_000), 100);
});

test("a viewer starved of material is waiting, and is as urgent as one playing", () => {
  const playing = new Viewer("playing", AT);
  playing.report({ bufferedAheadSec: 30, positionSeconds: 100, playing: true, waiting: false }, AT);
  const starved = new Viewer("starved", AT);
  starved.report({ bufferedAheadSec: 0, positionSeconds: 100, playing: false, waiting: true }, AT);

  // Both want film now, and that is the whole point: the starved one used to
  // count as somebody who had chosen to stop.
  assert.equal(starved.wantsFilmNow(), true);
  assert.equal(playing.wantsFilmNow(), true);
  // And the starved one cannot be carried forward from where they stand,
  // because they hold nothing to play.
  assert.equal(starved.positionSeconds(AT + 60_000), 100);
});

test("a report without a link measurement still states everything about the viewer", () => {
  const viewer = new Viewer("one", AT);
  viewer.report({ bufferedAheadSec: 0, positionSeconds: 12, playing: false, waiting: true }, AT);

  assert.equal(viewer.positionSeconds(AT), 12);
  assert.equal(viewer.waiting, true);
  // Nothing was measured, so nothing is claimed about the link.
  assert.equal(viewer.netReport, null);
});

test("a page one release behind, which cannot say `waiting`, is read from what it does say", () => {
  const starved = new Viewer("starved", AT);
  starved.report({ linkMbps: 5, bufferedAheadSec: 0, positionSeconds: 0, playing: false }, AT);
  assert.equal(starved.waiting, true, "stopped and holding nothing is starved");

  const paused = new Viewer("paused", AT);
  paused.report({ linkMbps: 5, bufferedAheadSec: 40, positionSeconds: 0, playing: false }, AT);
  assert.equal(paused.waiting, false, "stopped while holding film is a viewer's own pause");
});

test("a seek does not carry the cushion of the place it left", () => {
  const viewer = new Viewer("one", AT);
  viewer.report({ bufferedAheadSec: 120, positionSeconds: 100, playing: true, waiting: false }, AT);

  viewer.moveTo(2000, AT + 1000);
  // Nothing is held at the new place until they say so, so the position stands.
  assert.equal(viewer.positionSeconds(AT + 61_000), 2000);
});

test("a page that is not on screen wants nothing now, whatever else it says", () => {
  const viewer = new Viewer("one", AT);
  viewer.report(
    { bufferedAheadSec: 0, positionSeconds: 100, playing: false, waiting: true, onScreen: false },
    AT
  );

  assert.equal(viewer.wantsFilmNow(), false);
});

test("the intake keeps a link reading only while it describes the link", async () => {
  const { takeViewerReport } = await import("../services/viewer/report-intake.js");
  const session = {};
  const viewers = {
    of(target, id) {
      target.viewers ??= new Map();
      if (!target.viewers.has(id)) {
        target.viewers.set(id, new Viewer(id, AT));
      }
      return target.viewers.get(id);
    }
  };

  takeViewerReport({
    viewers,
    session,
    consumerId: "one",
    report: { linkMbps: 8, bufferedAheadSec: 10, positionSeconds: 5, playing: true },
    now: AT,
    linkFreshMs: 30_000
  });
  assert.equal(session.viewers.get("one").netReport?.linkMbps, 8);

  // A second report, a minute later, from somebody else: the first viewer's
  // reading has aged past what it describes and stops deciding for them. Who is
  // still watching is a different question and is not touched.
  takeViewerReport({
    viewers,
    session,
    consumerId: "two",
    report: { bufferedAheadSec: 0, playing: false, waiting: true },
    now: AT + 60_000,
    linkFreshMs: 30_000
  });
  assert.equal(session.viewers.get("one").netReport, null);
  assert.equal(session.viewers.get("one").isPresent(), true);
  assert.equal(session.viewers.get("two").waiting, true);
});
