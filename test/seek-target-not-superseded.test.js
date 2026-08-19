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
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HlsSessionManager } from "../services/hls-session-manager.js";
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
    state: "ready",
    fileName: "film.mkv",
    startedAt: Date.now(),
    lastAccessedAt: Date.now(),
    consumers: new Set(),
    segmentFormat: fmp4Format,
    transcodeVideo: false,
    useSyntheticPlaylist: true,
    segmentBoundaries: Array.from({ length: 400 }, (_, index) => index * SEGMENT_SECONDS),
    segmentCount: 399,
    encodeStartIndex: SEGMENT_AT_SEEK,
    waitEpoch: 1,
    viewerPositionSeconds: SEEK_TO_SECONDS,
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
