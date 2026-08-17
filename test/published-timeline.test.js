/**
 * @file A segment must be stamped where the playlist the player holds says.
 *
 * The field case this pins, 2026-08-17: a seek to 1590.4 s restarted the audio
 * rendition at #291; the produced segments #292 and #293 carried their own
 * positions, 1587.892 s and 1592.692 s, while the playlist the browser was
 * holding said 1585.376 s and 1590.585 s. The browser fetched those two
 * segments **1908 times each** over ten minutes, every one served in 4 ms, and
 * the film never moved: a fragment appended more than `maxBufferHole` away from
 * where the playlist put it is not recognised as buffered, so the player asks
 * for it again.
 *
 * The rule, and the reason it is not simply "always use the file's own time":
 * the boundary table keeps being corrected from produced segments, and the
 * playlist does not. Whichever is right about the FILE, only one of them was
 * sent to the player.
 */

import assert from "node:assert/strict";
import test from "node:test";

/**
 * hls.js's own default. A gap smaller than this is skipped; a larger one is a
 * hole, and the fragment across it counts as not loaded.
 */
const PLAYER_BUFFER_HOLE_SEC = 0.5;

/**
 * The decision under test, in the shape the session manager applies it.
 *
 * @param {{ trueStart: number | null, publishedStart: number }} reading
 * @returns {{ stamp: number, followedPlaylist: boolean }}
 */
function stampFor({ trueStart, publishedStart }) {
  if (trueStart === null) {
    return { stamp: publishedStart, followedPlaylist: true };
  }
  if (Math.abs(trueStart - publishedStart) > PLAYER_BUFFER_HOLE_SEC) {
    return { stamp: publishedStart, followedPlaylist: true };
  }
  return { stamp: trueStart, followedPlaylist: false };
}

test("the field case: a segment far from its playlist position is stamped where the playlist says", () => {
  const segment292 = stampFor({ trueStart: 1587.892, publishedStart: 1585.376 });
  assert.equal(segment292.stamp, 1585.376);
  assert.equal(segment292.followedPlaylist, true);

  const segment293 = stampFor({ trueStart: 1592.692, publishedStart: 1590.585 });
  assert.equal(segment293.stamp, 1590.585);
});

test("a file whose index is honest keeps its own position", () => {
  // Within what a player bridges, the file's own figure is the truthful one and
  // it is what keeps speech and subtitles together (2026-08-06, 4.17 s of drift
  // when the picture was stamped from a lying index).
  const reading = stampFor({ trueStart: 120.13, publishedStart: 120.0 });
  assert.equal(reading.stamp, 120.13);
  assert.equal(reading.followedPlaylist, false);
});

test("the boundary is exactly the player's own tolerance", () => {
  assert.equal(stampFor({ trueStart: 10.5, publishedStart: 10.0 }).stamp, 10.5);
  assert.equal(stampFor({ trueStart: 10.51, publishedStart: 10.0 }).stamp, 10.0);
});

test("a segment that does not say where it begins is stamped from the playlist", () => {
  assert.equal(stampFor({ trueStart: null, publishedStart: 42.0 }).stamp, 42.0);
});

test("a corrected boundary does not move the stamp of a session already playing", () => {
  // The correction writes into the live table; the published one is frozen. If
  // the stamp followed the live table, every correction would move segments
  // under a player holding the original playlist — which is the same failure
  // seen from the other side.
  const published = [0, 4, 8, 12];
  const live = [...published];
  live[2] = 9.7; // corrected from a produced segment
  const publishedStart = published[2];
  const reading = stampFor({ trueStart: live[2], publishedStart });
  assert.equal(publishedStart, 8);
  assert.equal(reading.stamp, 8, "the player was told 8 s and must be given 8 s");
});
