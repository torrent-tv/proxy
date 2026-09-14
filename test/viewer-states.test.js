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

test("the intake hands the statement to the viewer on the output they are watching", async () => {
  const { recordViewerReport } = await import("../services/viewer/report-intake.js");
  const picture = { id: "picture", state: "ready", activeVariantId: "rung" };
  const rung = { id: "rung", state: "ready" };
  const sessions = new Map([
    ["picture", picture],
    ["rung", rung]
  ]);
  const viewers = {
    of(target, id) {
      target.viewers ??= new Map();
      if (!target.viewers.has(id)) {
        target.viewers.set(id, new Viewer(id, AT));
      }
      return target.viewers.get(id);
    }
  };

  // The page always addresses the PICTURE — it is never told which rung it is
  // on — and the statement belongs to the rung actually on screen.
  const taken = recordViewerReport({
    sessions,
    viewers,
    sessionId: "picture",
    report: { linkMbps: 8, bufferedAheadSec: 10, positionSeconds: 5, playing: true, consumerId: "one" },
    now: AT
  });

  assert.equal(taken, true);
  assert.equal(rung.viewers.get("one").positionSeconds(AT), 5);
  assert.equal(picture.viewers?.has("one") ?? false, false);
});

test("a link reading does not expire — presence is what decides whose it is", () => {
  const viewer = new Viewer("one", AT);
  viewer.report({ linkMbps: 8, bufferedAheadSec: 10, positionSeconds: 5, playing: true }, AT);

  // A link does not stop being what it was measured to be because nobody
  // measured it for a while. The page says as much by keeping its own last
  // figure rather than reporting nothing.
  assert.equal(viewer.linkReading()?.linkMbps, 8);
  assert.equal(viewer.linkReading()?.linkMbps, 8, "and an hour later it is still the last thing known");

  // What ends it is the person leaving, which is a different fact with a
  // different owner.
  assert.equal(viewer.isPresent(), true);
});

test("the worst reading is taken across the people who are still here", async () => {
  const { worstLinkReading } = await import("../services/viewer/link-readings.js");
  const output = {};
  const slow = new Viewer("slow", AT);
  slow.outputs.add("out");
  const fast = new Viewer("fast", AT);
  fast.outputs.add("out");
  output.viewers = new Map([
    ["slow", slow],
    ["fast", fast]
  ]);
  slow.report({ linkMbps: 2, bufferedAheadSec: 3, playing: true }, AT);
  fast.report({ linkMbps: 40, bufferedAheadSec: 90, playing: true }, AT);

  // The slowest link and the emptiest buffer, which may belong to two people.
  const worst = worstLinkReading(output);
  assert.equal(worst?.linkMbps, 2);
  assert.equal(worst?.bufferedAheadSec, 3);
  assert.equal(worst?.viewers, 2);

  // The slow one leaves. Their reading goes with them, however recent it was.
  slow.gone = true;
  const left = worstLinkReading(output);
  assert.equal(left?.linkMbps, 40);
  assert.equal(left?.viewers, 1);
});

test("a report into a session that is gone is refused rather than invented", async () => {
  const { recordViewerReport } = await import("../services/viewer/report-intake.js");
  const sessions = new Map([["dead", { id: "dead", state: "disposed" }]]);
  const viewers = { of() { throw new Error("must not be asked"); } };

  assert.equal(
    recordViewerReport({ sessions, viewers, sessionId: "dead", report: { bufferedAheadSec: 0 }, now: AT }),
    false
  );
  assert.equal(
    recordViewerReport({ sessions, viewers, sessionId: "never", report: { bufferedAheadSec: 0 }, now: AT }),
    false
  );
});
