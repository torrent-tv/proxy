/**
 * @file A segment request steers nothing.
 *
 * Field 2026-08-17: the viewer seeked to 2083.4 s, both runs restarted at
 * segment #373, and a request for #371 — issued before the seek and reissued by
 * the player a second later — moved the encoder to #370. The viewer was at
 * #374 and waited for the encoder to come back to them.
 *
 * That was answered first by a guard: a request behind what the viewer had
 * REPORTED was refused, while the same traffic still moved the encoder when
 * nothing had been reported. The guard is gone with the thing it guarded. A
 * request for a file is not a statement about where anybody is, and nothing
 * about it belongs in the decision of where encoders go — that is read from the
 * priority map, which is built from where the viewers are and from nothing else.
 *
 * So the rule pinned here is now the whole rule, and it has no exception: a
 * request moves neither the encoder nor the viewer, whether or not the viewer
 * has said anything.
 */

import assert from "node:assert/strict";
import { SourceFile } from "../services/source/SourceFile.js";
import { Timeline } from "../services/output/Timeline.js";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { HlsSessionManager } from "../services/hls-session-manager.js";
import { startRunOn } from "./helpers/encode-run.js";
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
  const dirPath = await mkdtemp(path.join(os.tmpdir(), "stale-request-"));
  const manager = new HlsSessionManager({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090
  });
  const session = {
    id: SESSION_ID,
    dirPath,
    timeline: new Timeline({
      boundaries: Array.from({ length: 901 }, (_, index) => index * SEGMENT_SECONDS),
      cutGrid: "uniform"
    }),
    state: "ready",
    file: new SourceFile({ sourceKey: "source-1", fileIndex: 0, name: "film.mkv" }),
    get inputFile() { return this.file; },
    get audioFile() { return this.file; },
    segmentFormat: fmp4Format,
    segmentCount: 900,
    startedAt: Date.now(),
    createEntryMs: Date.now(),
    lastAccessedAt: Date.now(),
    runs: new Set(),
    consumers: new Set(),
    viewers: new Map(),
    progress: { processedSeconds: RUN_STARTS_AT * SEGMENT_SECONDS },
    useSyntheticPlaylist: true,
    playlistText: "#EXTM3U\n",
    lastError: "",
    firstSegmentLogged: false,
    waitEpoch: 0
  };
  manager.sessionsById.set(SESSION_ID, session);
  startRunOn(session, { from: RUN_STARTS_AT, usesExplicitCuts: true, speedX: 2 });
  return { manager, session, dirPath };
}

/**
 * @param {HlsSessionManager} manager
 * @param {object} session
 * @param {string} dirPath
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
  manager.requestSeek(SESSION_ID, 2083.4, "viewer-1");

  await manager.getFileStream(
    SESSION_ID,
    fmp4Format.segmentFileName(BEHIND_INDEX),
    { requestSeq: 1 }
  );

  // The field log's line was `seek settle → restart at segment #370`. Nothing
  // aims an encoder from here at all now, so there is no destination for a
  // stale request to become.
  assert.equal(
    session.seekTarget ?? null,
    null,
    "a request behind the viewer must not become the encoder's destination"
  );
  assert.equal(
    session.seekSettleTimer ?? null,
    null,
    "and it must not arm a restart"
  );
});

test("the same traffic moves nothing when the viewer has said nothing either", async (t) => {
  const { manager, session, dirPath } = await sessionWithRunAt373();
  t.after(async () => {
    await tidy(manager, session, dirPath);
  });

  // THE CONTROL, INVERTED. It used to be that without a reported seek this very
  // traffic DID move the encoder — the guard applied only to a viewer who had
  // spoken. That exception is the thing that was removed: a request is evidence
  // about what a player is reading, never about where a person is, and an
  // encoder placed from it is placed from a number the player picked.
  await manager.getFileStream(
    SESSION_ID,
    fmp4Format.segmentFileName(BEHIND_INDEX),
    { requestSeq: 1 }
  );

  assert.equal(session.seekTarget ?? null, null);
  assert.equal(session.seekSettleTimer ?? null, null);
});

test("a request cannot move the viewer's position backwards", async (t) => {
  const { manager, session, dirPath } = await sessionWithRunAt373();
  t.after(async () => {
    await tidy(manager, session, dirPath);
  });

  manager.requestSeek(SESSION_ID, 2083.4, "viewer-1");
  await manager.getFileStream(SESSION_ID, fmp4Format.segmentFileName(BEHIND_INDEX), { requestSeq: 1 });

  assert.equal(
    manager.viewers.get("viewer-1")?.positionSeconds(),
    2083.4,
    "a stale request must not rewrite what the viewer said about themselves"
  );
});
