/**
 * @file How far ahead of the viewer a held segment request may sit.
 *
 * A request is released when the viewer has moved away from it. "Moved away"
 * used to mean more than `MAX_LOOKAHEAD_SEGMENTS` — eight segments, which
 * happened to match a browser holding thirty seconds and would refuse three
 * quarters of the requests of one holding the whole cushion. The width is the
 * encoder's own look-ahead now, which is the same figure the browser sizes its
 * buffer from. Roadmap item 4, step 2.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HlsSessionManager } from "../services/hls-session-manager.js";
import { fmp4Format } from "../services/segment-formats/fmp4.js";

const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const SEGMENT_SECONDS = 4;

/**
 * @returns {Promise<{ manager: HlsSessionManager, dirPath: string }>}
 */
async function managerWithSession() {
  const dirPath = await mkdtemp(path.join(os.tmpdir(), "held-request-"));
  const manager = new HlsSessionManager({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090
  });
  manager.sessionsById.set(SESSION_ID, {
    id: SESSION_ID,
    dirPath,
    state: "ready",
    segmentFormat: fmp4Format,
    segmentBoundaries: Array.from({ length: 201 }, (_, index) => index * SEGMENT_SECONDS),
    segmentCount: 200,
    useSyntheticPlaylist: true,
    // The viewer is at segment #25.
    furthestViewerSeconds: 100
  });
  return { manager, dirPath };
}

/**
 * @param {number} index
 * @returns {string}
 */
function segment(index) {
  return `segment-${String(index).padStart(5, "0")}.mp4`;
}

test("the width is the encoder's own look-ahead, in segments", async (t) => {
  const { manager, dirPath } = await managerWithSession();
  t.after(async () => {
    await rm(dirPath, { recursive: true, force: true });
  });

  const width = Math.ceil(manager.lookaheadSeconds / manager.segmentDurationSec);
  assert.equal(width, 30, "120 s of look-ahead over 4 s segments");
  assert.equal(manager.requestStillWanted(SESSION_ID, segment(25 + width)), true, "the far edge");
  assert.equal(
    manager.requestStillWanted(SESSION_ID, segment(25 + width + 1)),
    false,
    "past everything the encoder is allowed to have produced"
  );
});

test("a request the old eight-segment width would have refused is kept", async (t) => {
  const { manager, dirPath } = await managerWithSession();
  t.after(async () => {
    await rm(dirPath, { recursive: true, force: true });
  });

  // #34 is nine segments ahead of the viewer — inside a 120 s cushion and
  // outside the eight the width used to be. This is the request a browser
  // holding the whole cushion makes constantly.
  assert.equal(manager.requestStillWanted(SESSION_ID, segment(34)), true);
});

test("a segment behind the viewer is still released", async (t) => {
  const { manager, dirPath } = await managerWithSession();
  t.after(async () => {
    await rm(dirPath, { recursive: true, force: true });
  });

  assert.equal(manager.requestStillWanted(SESSION_ID, segment(24)), false);
});

test("a seek by one viewer does not release the request held for another", async (t) => {
  const { manager, dirPath } = await managerWithSession();
  t.after(async () => {
    await rm(dirPath, { recursive: true, force: true });
  });
  const session = manager.sessionsById.get(SESSION_ID);

  // Both are watching the same copied picture, so both are this one session.
  // One is at segment #25, the other far ahead at #150 — inside the fixture's
  // own 200-segment timeline, since a position past the end of the grid is
  // clamped to it and would prove nothing about the width.
  manager.requestSeek(SESSION_ID, 100, "behind");
  manager.requestSeek(SESSION_ID, 600, "ahead");

  // The shared field now holds the leader's position, which is what the
  // encoder is steered by and what every earlier release judged BOTH of them
  // against.
  assert.equal(session.furthestViewerSeconds, 600);

  assert.equal(
    manager.requestStillWanted(SESSION_ID, segment(26), "behind"),
    true,
    "the segment the viewer behind is waiting for is still theirs to wait for"
  );
  assert.equal(
    manager.requestStillWanted(SESSION_ID, segment(26), "ahead"),
    false,
    "and for the one in front it is a place they have left"
  );
});

test("a viewer's own head moves with their seek", async (t) => {
  const { manager, dirPath } = await managerWithSession();
  t.after(async () => {
    await rm(dirPath, { recursive: true, force: true });
  });

  // Their last request was at #25; they jump to 600 s, which is #150. The
  // segment at the target must be wanted — refusing it there is the freeze of
  // 2026-08-18.
  manager.requestSeek(SESSION_ID, 600, "viewer");
  assert.equal(manager.requestStillWanted(SESSION_ID, segment(150), "viewer"), true);
  assert.equal(manager.requestStillWanted(SESSION_ID, segment(25), "viewer"), false);
});

test("a viewer nobody can name is judged against the one shared position", async (t) => {
  const { manager, dirPath } = await managerWithSession();
  t.after(async () => {
    await rm(dirPath, { recursive: true, force: true });
  });

  // A plain HTTP transport builds its own URLs and carries no id. The old
  // behaviour is what remains, which for a single viewer is the same thing.
  assert.equal(manager.requestStillWanted(SESSION_ID, segment(26), ""), true);
  assert.equal(manager.requestStillWanted(SESSION_ID, segment(24), ""), false);
});
