/**
 * @file A request issued before a seek must not steer the encoder.
 *
 * Field 2026-08-17: the viewer seeked to 2083.4 s, both runs restarted at
 * segment #373, and a request for #371 — issued before the seek and reissued by
 * the player a second later — moved the encoder to #370. The viewer was at
 * #374 and waited for the encoder to come back to them.
 *
 * The rule pinned here: a reported seek is the viewer STATING where they are; a
 * segment request is evidence about where the player is reading. Evidence may
 * refine a statement forward, never contradict it backwards.
 *
 * Both cases go through `getFileStream`, the way production reaches the repair,
 * and the second is the control: without a reported seek the very same traffic
 * DOES move the encoder, which is what makes the first case a measurement of
 * the guard rather than of the weather.
 */

import assert from "node:assert/strict";
import { Timeline } from "../services/output/Timeline.js";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { HlsSessionManager } from "../services/hls-session-manager.js";
import { ENCODE_RUN_STATE } from "../services/encode-run-state.js";
import { fmp4Format } from "../services/segment-formats/fmp4.js";

const SEGMENT_SECONDS = 4;
const RUN_STARTS_AT = 373;
const BEHIND_INDEX = 371;
const SESSION_ID = "22222222-3333-4444-5555-666666666666";

/**
 * A live session whose run begins at #373 and whose directory is empty, so any
 * segment request is a request for something not yet produced.
 *
 * @returns {Promise<{ manager: HlsSessionManager, session: object, dirPath: string }>}
 */
async function sessionWithRunAt373() {
  const dirPath = await mkdtemp(path.join(os.tmpdir(), "stale-seek-"));
  const manager = new HlsSessionManager({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090
  });
  const boundaries = [];
  for (let index = 0; index <= 600; index += 1) {
    boundaries.push(index * SEGMENT_SECONDS);
  }
  const session = {
    id: SESSION_ID,
    dirPath,
    // Where this file is cut, held by the file. A fixture that stated it
    // on the session was describing what production no longer does.
    timeline: new Timeline({
      boundaries: boundaries,
      cutGrid: "uniform"
    }),
    state: "ready",
    runState: ENCODE_RUN_STATE.PRODUCING,
    fileName: "film.mkv",
    createEntryMs: Date.now(),
    lastAccessedAt: Date.now(),
    consumers: new Set(),
    segmentFormat: fmp4Format,
    usesExplicitCuts: true,
    useSyntheticPlaylist: true,
    playlistText: "#EXTM3U\n",
    segmentCount: boundaries.length - 1,
    encodeStartIndex: RUN_STARTS_AT,
    // A live process: the repair refuses outright when nothing is encoding.
    ffmpeg: { pid: 1234, killed: false, exitCode: null, signalCode: null, kill() { this.killed = true; } },
    encodeRunGeneration: 0,
    runSerial: 1,
    behindHeadAsks: new Map(),
    firstWantedAt: new Map(),
    holdExplainedAt: new Map(),
    seekSettleTimer: null,
    seekTarget: null,
    seekFailureTarget: -1,
    seekFailureCount: 0,
    waitEpoch: 0,
    firstSegmentLogged: true,
    progress: { processedSeconds: RUN_STARTS_AT * SEGMENT_SECONDS, speed: "1.0x", startPositionSeconds: RUN_STARTS_AT * SEGMENT_SECONDS }
  };
  manager.sessionsById.set(SESSION_ID, session);
  return { manager, session, dirPath };
}

/**
 * The traffic that dragged the encoder back: the same index asked for twice,
 * first wanted long enough ago to pass the repair's patience guard.
 *
 * @param {object} session
 */
function askedTwiceLongEnough(session) {
  session.firstWantedAt.set(BEHIND_INDEX, Date.now() - 5_000);
  session.behindHeadAsks.set(BEHIND_INDEX, { count: 3, at: Date.now() });
}

/**
 * Put the session down without going through disposal.
 *
 * Disposal signals the encoder and waits for it to die, which a stub cannot do
 * — and none of that is what these tests are about. Clearing the map and any
 * armed timer leaves nothing running.
 *
 * @param {HlsSessionManager} manager
 * @param {object} session
 * @param {string} dirPath
 * @returns {Promise<void>}
 */
async function tidy(manager, session, dirPath) {
  if (session.seekSettleTimer) {
    clearTimeout(session.seekSettleTimer);
    session.seekSettleTimer = null;
  }
  manager.sessionsById.clear();
  manager.stop?.();
  await rm(dirPath, { recursive: true, force: true });
}

test("a request behind where the viewer said they are does not move the encoder", async (t) => {
  const { manager, session, dirPath } = await sessionWithRunAt373();
  t.after(async () => {
    await tidy(manager, session, dirPath);
  });

  // The viewer stated their position: 2083.4 s, which is segment #520 here.
  manager.requestSeek(SESSION_ID, 2083.4);
  session.encodeStartIndex = RUN_STARTS_AT;
  askedTwiceLongEnough(session);

  const answer = await manager.getFileStream(
    SESSION_ID,
    fmp4Format.segmentFileName(BEHIND_INDEX),
    { requestSeq: 1 }
  );

  assert.equal(answer.kind, "warming-up", "the request is answered, not obeyed");
  // The viewer's own seek legitimately armed a move to #519. What must NOT
  // happen is the stale request replacing that with #370 — which is exactly
  // what the field log shows: `seek settle → restart at segment #370`.
  assert.notEqual(
    session.seekTarget,
    BEHIND_INDEX - 1,
    "a request behind the viewer must not become the encoder's destination"
  );
  assert.equal(session.seekTarget, 519, "the viewer's own seek is what the encoder is going to");
});

test("the same traffic DOES move the encoder when the viewer has said nothing", async (t) => {
  const { manager, session, dirPath } = await sessionWithRunAt373();
  t.after(async () => {
    await tidy(manager, session, dirPath);
  });

  // No reported seek: a run placed wrongly is exactly what the repair is for,
  // and this is the case it must keep serving.
  askedTwiceLongEnough(session);

  await manager.getFileStream(SESSION_ID, fmp4Format.segmentFileName(BEHIND_INDEX), { requestSeq: 1 });

  assert.equal(
    session.seekTarget,
    BEHIND_INDEX - 1,
    "with nothing said by the viewer, a request stuck behind the head still repairs the run"
  );
  assert.notEqual(session.seekSettleTimer, null);
});

test("a request cannot move the viewer's position backwards", async (t) => {
  const { manager, session, dirPath } = await sessionWithRunAt373();
  t.after(async () => {
    await tidy(manager, session, dirPath);
  });

  manager.requestSeek(SESSION_ID, 2083.4);
  await manager.getFileStream(SESSION_ID, fmp4Format.segmentFileName(BEHIND_INDEX), { requestSeq: 1 });

  assert.equal(
    session.furthestViewerSeconds,
    2083.4,
    "a stale request must not rewrite what the viewer reported — that is how the repair came to believe it"
  );
});
