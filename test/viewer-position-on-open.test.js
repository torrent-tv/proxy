/**
 * @file Opening a file at a position puts the SOUND there too.
 *
 * The audio rendition is a session of its own, and where it starts is computed
 * from where the viewer is. That reading had three sources and only two were
 * consulted — a position seeked to, and the last segment this session served —
 * both of which are written by things that have not happened yet at the moment
 * a file is opened at a position. So the answer was zero.
 *
 * Field 2026-08-21, `Minions.and.Monsters.1080p.mkv` reopened from the address
 * bar at 52:07:
 *
 *   18:02:55.124  8ed85605  start=3130s  -ss 3125.25  -an -map 0:v:0 -c:v copy
 *   18:02:55.632  33b0b046  start=0s     no -ss       -vn -map 0:a:0 -c:a aac
 *
 * The picture went to segment #781, the sound to #0. The player asked both for
 * #782; the picture had it, the sound re-encoded 57.5 s of a 3130 s film in the
 * 45 s the request lasted and then answered 404 — shown to the viewer as "the
 * proxy accepted the request but sent no video".
 */

import assert from "node:assert/strict";
import test from "node:test";

import { resolveViewerPosition } from "../services/hls-session-manager.js";

test("a file opened at a position has its viewer at that position", () => {
  // Nothing has been seeked and nothing served yet — the state at the instant
  // the audio rendition is created.
  assert.equal(resolveViewerPosition({ openedAt: 3130 }), 3130);
});

test("a seek beats everything else", () => {
  assert.equal(
    resolveViewerPosition({ seeked: 900, lastRequestedStart: 400, openedAt: 3130 }),
    900
  );
});

test("what has been served beats where the file was opened", () => {
  // The opening position is the oldest of the three readings: once a segment
  // has been served, that is where the reading is.
  assert.equal(resolveViewerPosition({ lastRequestedStart: 400, openedAt: 3130 }), 400);
});

test("with nothing to go on the answer is the beginning", () => {
  assert.equal(resolveViewerPosition({}), 0);
  assert.equal(resolveViewerPosition({ seeked: 0, lastRequestedStart: 0, openedAt: 0 }), 0);
  // Values that are not readings must not become one.
  assert.equal(resolveViewerPosition({ seeked: Number.NaN, openedAt: Number.NaN }), 0);
  assert.equal(resolveViewerPosition({ seeked: -5, openedAt: -5 }), 0);
  assert.equal(resolveViewerPosition({ lastRequestedStart: null, openedAt: undefined }), 0);
});
