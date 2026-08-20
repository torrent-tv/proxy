import test from "node:test";
import assert from "node:assert/strict";

/**
 * The rule this pins: a subtitle cursor counts the order cues were FOUND, not
 * where they sit in the film.
 *
 * Cues are read out of whichever clusters happen to be downloaded, and a
 * torrent does not arrive in film order — a seek pulls a later stretch first,
 * and the earlier one fills in afterwards. So the set of known cues grows in
 * the MIDDLE as well as at the end.
 *
 * A cursor in film time cannot survive that: measured 2026-08-20 on a viewer at
 * 272 s, one answer carried cues out to 1176 s, and from that moment every cue
 * between the two was filtered away for the rest of the session — the stretch
 * they were about to watch. 59 of 276 clusters had been read.
 *
 * The filter below is the route's, written out so the property can be checked
 * without a torrent: `?since=<n>` selects by found-order, `?after=<seconds>` is
 * the old behaviour kept for an older browser.
 */
const bySince = (cues, since) => cues.filter((cue) => (Number(cue.seq) || 0) > since);
const byAfter = (cues, after) => cues.filter((cue) => cue.startSeconds > after);

/** A late-arriving cluster from EARLIER in the film than what is already held. */
const held = [
  { startSeconds: 40, text: "found first, early in the film", seq: 1 },
  { startSeconds: 1176, text: "found second, far ahead", seq: 2 },
  { startSeconds: 300, text: "found third, behind the furthest held", seq: 3 }
];

test("a cue found after a further-ahead one is still delivered", () => {
  // The browser holds seq 1 and 2 and asks for what came after.
  const fresh = bySince(held, 2);
  assert.deepEqual(fresh.map((cue) => cue.startSeconds), [300]);
});

test("the same case in film time loses that cue for ever", () => {
  // This is what shipped in 2.43.1 and what the field session showed: the
  // browser's furthest cue is 1176 s, so the 300 s cue can never reach it.
  const fresh = byAfter(held, 1176);
  assert.deepEqual(fresh.map((cue) => cue.startSeconds), []);
});

test("a browser asking for the first time is sent everything", () => {
  assert.equal(bySince(held, 0).length, 3);
});

test("nothing new is answered with nothing", () => {
  assert.deepEqual(bySince(held, 3), []);
});

test("the cursor to send back is the highest found-order held", () => {
  const cursor = held.reduce((highest, cue) => Math.max(highest, Number(cue.seq) || 0), 0);
  assert.equal(cursor, 3);
});

test("a cursor is unaffected by the order cues are sorted into", () => {
  // The list is kept in film order for the WebVTT it becomes; the cursor must
  // not depend on that.
  const sorted = [...held].sort((left, right) => left.startSeconds - right.startSeconds);
  assert.deepEqual(bySince(sorted, 2).map((cue) => cue.startSeconds), [300]);
});
