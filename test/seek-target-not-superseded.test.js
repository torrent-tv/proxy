/**
 * @file The segment the viewer just seeked TO must not be refused as stale.
 *
 * A seek bumps the wait epoch so that requests made for the position being left
 * stop being held. The request for the position being ARRIVED at races that
 * bump: hls.js asks for the new segment within milliseconds, and if the epoch
 * moves underneath it, the epoch check alone cannot tell the two apart.
 *
 * Measured 2026-08-18: the viewer seeked to 1061.0 s, `segment-00101` — the
 * segment at that very position — was answered 503 twice within 80 ms, the
 * player never asked for it again, and instead looped `a/0/segment-00103` and
 * `a/0/segment-00104` 737 and 736 times over 149 seconds while the picture
 * stood at `t=1061.0s readyState=1`. The session ended without another frame.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { SourceFile } from "../services/source/SourceFile.js";
import { Timeline } from "../services/output/Timeline.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HlsSessionManager } from "../services/hls-session-manager.js";
import { viewerOf } from "../services/viewer/Viewer.js";
import { fmp4Format } from "../services/segment-formats/fmp4.js";

const SESSION_ID = "aaaaaaaa-1111-2222-3333-444444444444";
const SEGMENT_SECONDS = 10.4;
const SEEK_TO_SECONDS = 1061;
const SEGMENT_AT_SEEK = Math.floor(SEEK_TO_SECONDS / SEGMENT_SECONDS);

/**
 * A session whose viewer has just landed at {@link SEEK_TO_SECONDS}.
 *
 * @returns {Promise<{ manager: HlsSessionManager, dirPath: string }>}
 */
async function managerAfterSeek() {
  const dirPath = await mkdtemp(path.join(os.tmpdir(), "seek-target-"));
  const manager = new HlsSessionManager({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090
  });
  manager.sessionsById.set(SESSION_ID, {
    id: SESSION_ID,
    dirPath,
    // Where this file is cut, held by the file. A fixture that stated it
    // on the session was describing what production no longer does.
    timeline: new Timeline({
      boundaries: Array.from({ length: 400 }, (_, index) => index * SEGMENT_SECONDS),
      cutGrid: "uniform"
    }),
    state: "ready",
    file: new SourceFile({ sourceKey: "source-1", fileIndex: 0, name: "film.mkv" }),
    // An ordinary session reads its own file, and its sound is inside it. The
    // three differ only for a soundtrack shipped as a file of its own.
    get inputFile() { return this.file; },
    get audioFile() { return this.file; },
    startedAt: Date.now(),
    lastAccessedAt: Date.now(),
    consumers: new Set(),
    segmentFormat: fmp4Format,
    transcodeVideo: false,
    useSyntheticPlaylist: true,
    segmentCount: 399,
    encodeStartIndex: SEGMENT_AT_SEEK,
    waitEpoch: 1,
    furthestViewerSeconds: SEEK_TO_SECONDS,
    runState: "PRODUCING"
  });
  return { manager, dirPath };
}

test("the segment at the seek target is still wanted", async () => {
  const { manager, dirPath } = await managerAfterSeek();

  assert.equal(
    manager.requestStillWanted(SESSION_ID, `segment-${String(SEGMENT_AT_SEEK).padStart(5, "0")}.mp4`),
    true,
    "this is the segment the viewer is waiting for; refusing it is what froze the field session"
  );

  await rm(dirPath, { recursive: true, force: true });
});

test("a segment behind the viewer is not wanted any more", async () => {
  const { manager, dirPath } = await managerAfterSeek();

  assert.equal(
    manager.requestStillWanted(SESSION_ID, `segment-${String(SEGMENT_AT_SEEK - 3).padStart(5, "0")}.mp4`),
    false,
    "a request for the position the viewer left is exactly what the epoch exists to release"
  );

  await rm(dirPath, { recursive: true, force: true });
});

test("a segment far beyond what the run will reach is not wanted", async () => {
  const { manager, dirPath } = await managerAfterSeek();

  assert.equal(
    manager.requestStillWanted(SESSION_ID, `segment-${String(SEGMENT_AT_SEEK + 200).padStart(5, "0")}.mp4`),
    false,
    "nothing will produce it before the viewer moves again"
  );

  await rm(dirPath, { recursive: true, force: true });
});

test("a playlist belongs to no position and is never stale", async () => {
  const { manager, dirPath } = await managerAfterSeek();

  assert.equal(manager.requestStillWanted(SESSION_ID, "index.m3u8"), true);
  assert.equal(manager.requestStillWanted(SESSION_ID, "init.mp4"), true);

  await rm(dirPath, { recursive: true, force: true });
});

test("a request as deep as the cushion the browser is told to hold is still wanted", async () => {
  const { manager, dirPath } = await managerAfterSeek();

  // The browser sizes its forward buffer from the proxy's own look-ahead, so
  // the deepest request it can make is one for the segment at the far edge of
  // that cushion. Refusing it would be refusing the very depth this proxy
  // asked for: at the old width — eight segments ahead of the viewer — three
  // quarters of a full cushion's requests were stale by definition.
  const edge = Math.floor((SEEK_TO_SECONDS + manager.lookaheadSeconds) / SEGMENT_SECONDS);

  assert.ok(edge - SEGMENT_AT_SEEK > 8, "the case only exists past the old eight-segment width");
  assert.equal(
    manager.requestStillWanted(SESSION_ID, `segment-${String(edge).padStart(5, "0")}.mp4`),
    true,
    "the far edge of the cushion the proxy itself keeps produced"
  );

  await rm(dirPath, { recursive: true, force: true });
});

test("the viewer who made the request is the one it is judged against", async () => {
  const { manager, dirPath } = await managerAfterSeek();
  const session = manager.sessionsById.get(SESSION_ID);
  session.viewers = new Map();
  // Two people watching one copied picture. The shared position belongs to the
  // one in front — it is the furthest segment anybody asked for — and the one
  // behind is a hundred segments back, waiting for a segment there.
  const behind = SEGMENT_AT_SEEK - 100;
  viewerOf(session, "behind").head = {
    segment: behind,
    seconds: behind * SEGMENT_SECONDS,
    at: Date.now()
  };

  assert.equal(
    manager.requestStillWanted(SESSION_ID, `segment-${String(behind).padStart(5, "0")}.mp4`, "behind"),
    true,
    "held for the viewer who is there, whatever the viewer in front is doing"
  );
  assert.equal(
    manager.requestStillWanted(SESSION_ID, `segment-${String(behind).padStart(5, "0")}.mp4`),
    false,
    "unnamed, it can only be judged against the shared position — which is the leader's"
  );

  await rm(dirPath, { recursive: true, force: true });
});

test("a seek moves the seeking viewer's own head, and nobody else's", async () => {
  const { manager, dirPath } = await managerAfterSeek();
  const session = manager.sessionsById.get(SESSION_ID);
  session.viewers = new Map();
  const staying = SEGMENT_AT_SEEK - 40;
  viewerOf(session, "staying").head = {
    segment: staying,
    seconds: staying * SEGMENT_SECONDS,
    at: Date.now()
  };

  const jumpTo = 120;
  manager.requestSeek(SESSION_ID, jumpTo, "jumping");

  assert.equal(
    manager.requestStillWanted(SESSION_ID, `segment-${String(Math.floor(jumpTo / SEGMENT_SECONDS)).padStart(5, "0")}.mp4`, "jumping"),
    true,
    "the segment at the seek target — the request that raced the epoch in 2026-08-18"
  );
  assert.equal(
    manager.requestStillWanted(SESSION_ID, `segment-${String(staying).padStart(5, "0")}.mp4`, "staying"),
    true,
    "somebody else's seek does not move where this viewer is"
  );

  await rm(dirPath, { recursive: true, force: true });
});
