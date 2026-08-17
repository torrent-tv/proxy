/**
 * @file A segment request below the running encode must not be held for ever.
 *
 * The encoder only moves forward from where its run began, so a request BELOW
 * that point cannot be answered by anything the run does. Every other far
 * request is a claim the running encode may yet reach; this one is a hole.
 *
 * Measured 2026-08-11: a quality switch placed a run at segment #770 while the
 * player needed #757, and the request was held for two minutes forty-one while
 * the encoder produced 409 s of video nobody had asked for at 2.48x. The
 * placement that caused it is fixed; this is the guard that stops the SHAPE
 * from hanging a session again, whatever puts it there.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HlsSessionManager } from "../services/hls-session-manager.js";
import { fmp4Format } from "../services/segment-formats/fmp4.js";

const SESSION_ID = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
const SEGMENT_SECONDS = 4;
const RUN_STARTS_AT = 770;
const WANTED = 757;

/**
 * A session whose run began well past the segment being asked for.
 *
 * @returns {Promise<{ manager: HlsSessionManager, session: object, dirPath: string, restarts: number[] }>}
 */
async function managerWithRunAhead() {
  const dirPath = await mkdtemp(path.join(os.tmpdir(), "behind-head-"));
  const manager = new HlsSessionManager({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090
  });
  const session = {
    id: SESSION_ID,
    dirPath,
    state: "ready",
    fileName: "film.avi",
    startedAt: Date.now(),
    createEntryMs: Date.now(),
    lastAccessedAt: Date.now(),
    lastError: "",
    consumers: new Set(),
    segmentFormat: fmp4Format,
    transcodeVideo: true,
    useSyntheticPlaylist: true,
    playlistText: "#EXTM3U\n",
    segmentBoundaries: Array.from({ length: 1937 }, (_, index) => index * SEGMENT_SECONDS),
    segmentCount: 1936,
    encodeStartIndex: RUN_STARTS_AT,
    encodeRunGeneration: 0,
    lastRestartAt: 0,
    seekFailureTarget: -1,
    seekFailureCount: 0,
    seekSettleTimer: null,
    seekTarget: null,
    waitEpoch: 0,
    firstWantedAt: new Map(),
    runState: "PRODUCING",
    ffmpeg: { pid: 4321, exitCode: null, signalCode: null, kill() {}, once(event, handler) { if (event === "exit") handler(); } },
    progress: { state: "running", processedSeconds: RUN_STARTS_AT * SEGMENT_SECONDS + 400, startPositionSeconds: RUN_STARTS_AT * SEGMENT_SECONDS }
  };
  manager.sessionsById.set(SESSION_ID, session);
  const restarts = [];
  return { manager, session, dirPath, restarts };
}

test("a request behind the run is repaired once the player asks again", async (t) => {
  const { manager, session, dirPath } = await managerWithRunAhead();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  // Asked for a moment ago and still unanswerable. What decides is that the
  // player comes BACK for the same segment: it is the only one it wants, and no
  // amount of waiting could say that as clearly.
  session.firstWantedAt.set(WANTED, Date.now() - 1000);
  const name = fmp4Format.segmentFileName(WANTED);

  await manager.getFileStream(SESSION_ID, name, { requestSeq: 1 });

  assert.equal(session.seekTarget, null, "one poll is not yet evidence");

  await manager.getFileStream(SESSION_ID, name, { requestSeq: 2 });

  assert.equal(
    session.seekTarget,
    WANTED - 1,
    "the encoder must be moved back to it — one segment early, for the preceding keyframe"
  );
});

test("a burst of different segments behind the run is a scan, and moves nothing", async (t) => {
  const { manager, session, dirPath } = await managerWithRunAhead();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  // What hls.js does on a seek: dozens of indices within half a second, each
  // abandoned. Field log 2026-08-02: #178, #681, #725, #807, #74, #245, #387.
  const scanned = [WANTED, WANTED - 40, WANTED - 120, WANTED - 200, WANTED - 300];
  for (const index of scanned) {
    session.firstWantedAt.set(index, Date.now() - 1000);
  }
  // Asked ONCE each, which is what a scan is: the player opens them together
  // and abandons them together. Field log 2026-08-02 — #178, #681, #725, #807,
  // #74, #245, #387 within half a second, none of them repeated.
  for (const index of scanned) {
    await manager.getFileStream(SESSION_ID, fmp4Format.segmentFileName(index), { requestSeq: 1 });
  }

  assert.equal(
    session.seekTarget,
    null,
    "moving the encoder to one of these would be moving it to a number the player picked at random"
  );
});

test("a request behind the run is left alone at first", async (t) => {
  const { manager, session, dirPath } = await managerWithRunAhead();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });

  await manager.getFileStream(SESSION_ID, fmp4Format.segmentFileName(WANTED), { requestSeq: 1 });

  assert.equal(
    session.seekTarget,
    null,
    "a burst around a reported seek settles by itself, and the seek is what should move the encoder"
  );
});

test("a seek already settling is not overridden", async (t) => {
  const { manager, session, dirPath } = await managerWithRunAhead();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  session.firstWantedAt.set(WANTED, Date.now() - 4000);
  // The viewer has stated where they are and it is about to be acted on.
  session.seekTarget = 1200;
  session.seekSettleTimer = setTimeout(() => {}, 60_000);
  t.after(() => clearTimeout(session.seekSettleTimer));

  await manager.getFileStream(SESSION_ID, fmp4Format.segmentFileName(WANTED), { requestSeq: 1 });

  assert.equal(
    session.seekTarget,
    1200,
    "a statement from the viewer outranks anything inferred from what the player is fetching"
  );
});

test("a playlist scan far below the run is left where it belongs", async (t) => {
  const { manager, session, dirPath } = await managerWithRunAhead();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  // A player that cannot get what it wants scans the playlist: field log
  // 2026-08-02, probes at #178, #681, #725, #807, #74, #245, #387 within half a
  // second. Steering on the lowest of those put the encoder at the start of the
  // film and left the viewer's own requests unreachable ahead of it — the exact
  // reason request-steering was removed from this proxy.
  const probe = 74;
  session.firstWantedAt.set(probe, Date.now() - 30_000);

  await manager.getFileStream(SESSION_ID, fmp4Format.segmentFileName(probe), { requestSeq: 1 });

  assert.equal(
    session.seekTarget,
    null,
    "a misplaced run is out by a buffer; a scan probe is out by anything, and the two must not be confused"
  );
});

test("a rung whose encoder was stopped is not brought back by a held request", async (t) => {
  const { manager, session, dirPath } = await managerWithRunAhead();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  // What a quality switch leaves behind: the rung nobody is watching, parked.
  session.ffmpeg = null;
  session.firstWantedAt.set(WANTED, Date.now() - 4000);

  await manager.getFileStream(SESSION_ID, fmp4Format.segmentFileName(WANTED), { requestSeq: 1 });

  assert.equal(
    session.seekTarget,
    null,
    "restarting it would put a second encoder on a host sized for one, for a rung nobody is watching"
  );
});

test("a request ahead of the run is not touched", async (t) => {
  const { manager, session, dirPath } = await managerWithRunAhead();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  const ahead = RUN_STARTS_AT + 400;
  session.firstWantedAt.set(ahead, Date.now() - 30_000);

  await manager.getFileStream(SESSION_ID, fmp4Format.segmentFileName(ahead), { requestSeq: 1 });

  assert.equal(
    session.seekTarget,
    null,
    "the running encode may yet reach it; restarting on a far request is what produced nine restarts in a minute"
  );
});

test("a request far beyond the repair's reach is answered at once, not held", async (t) => {
  const { manager, session, dirPath } = await managerWithRunAhead();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  // What a track change does: hls.js asks the new stream for segment #0 while
  // the run is hundreds of segments in. The repair cannot reach it, no seek is
  // coming, and the run only moves forward — so it can never be produced.
  // Measured 2026-08-15: held for the full minute, and the viewer watched a
  // spinner for 63 s after a track that had been made ready in 7.
  const answer = await manager.getFileStream(SESSION_ID, fmp4Format.segmentFileName(0), { requestSeq: 1 });

  assert.equal(answer.kind, "not-found", "answered, so the player can move on to what it can have");
  assert.equal(session.seekTarget, null, "and the encoder was not sent to the start of the film for it");
});

test("a request just behind the run is still held, because the repair will fetch it", async (t) => {
  const { manager, session, dirPath } = await managerWithRunAhead();
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  const name = fmp4Format.segmentFileName(WANTED);
  session.firstWantedAt.set(WANTED, Date.now() - 1000);

  const answer = await manager.getFileStream(SESSION_ID, name, { requestSeq: 1 });

  assert.equal(answer.kind, "warming-up", "within reach: the encoder is about to be moved there");
});
