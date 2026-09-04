/**
 * @file One object per person watching, and one deletion to forget them.
 *
 * It was six maps hung on the session, each keyed by consumer id, and the
 * forgetting was already wrong: releasing a consumer emptied none of them, so a
 * viewer who had left went on counting as wanting their soundtrack until their
 * head expired, and their entries stayed for the life of the session.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HlsSessionManager } from "../services/hls-session-manager.js";
import { Viewer, viewerOf, viewersOf } from "../services/viewer/Viewer.js";

const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

test("a viewer nobody has heard from is not watching", () => {
  const viewer = new Viewer("someone");
  const now = 1_000_000;

  assert.equal(viewer.isLive(now, 60_000), false, "no head at all: they have never asked");
  viewer.head = { segment: 4, seconds: 16, at: now - 10_000 };
  assert.equal(viewer.isLive(now, 60_000), true);
  viewer.head = { segment: 4, seconds: 16, at: now - 120_000 };
  assert.equal(viewer.isLive(now, 60_000), false, "the tab is gone and nothing released it");
});

test("a stated position outranks the segment they last asked for", () => {
  const viewer = new Viewer("someone");
  assert.equal(viewer.positionSeconds(), null);

  viewer.head = { segment: 10, seconds: 40, at: 1 };
  assert.equal(viewer.positionSeconds(), 40, "where their player is reading");

  viewer.head = { segment: 10, seconds: 40, at: 1, seeked: 900 };
  assert.equal(viewer.positionSeconds(), 900, "a seek is the viewer saying where they are");
});

test("asking for a viewer twice is the same viewer", () => {
  const session = {};
  const first = viewerOf(session, "one");
  first.audio = { trackIndex: 3, transcode: false };

  assert.equal(viewerOf(session, "one"), first);
  assert.equal(viewerOf(session, "one").audio.trackIndex, 3);
  assert.notEqual(viewerOf(session, "two"), first);
  assert.equal(viewersOf(session).size, 2);
});

test("releasing a consumer forgets everything that was true of them alone", async (t) => {
  const dirPath = await mkdtemp(path.join(os.tmpdir(), "viewer-"));
  t.after(async () => {
    await rm(dirPath, { recursive: true, force: true });
  });
  const manager = new HlsSessionManager({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090
  });
  const session = {
    id: SESSION_ID,
    dirPath,
    state: "live",
    fileName: "video.mkv",
    consumers: new Set(["staying", "leaving"]),
    viewers: new Map(),
    lastAccessedAt: Date.now()
  };
  manager.sessionsById.set(SESSION_ID, session);

  const leaving = viewerOf(session, "leaving");
  leaving.audio = { trackIndex: 2, transcode: true };
  leaving.activeVariantId = "some-variant";
  leaving.head = { segment: 40, seconds: 160, at: Date.now() };
  viewerOf(session, "staying").audio = { trackIndex: 0, transcode: false };

  await manager.releaseSessionConsumer(SESSION_ID, "leaving", "the tab was closed");

  assert.equal(session.viewers.has("leaving"), false, "one deletion, not six");
  assert.equal(session.viewers.has("staying"), true, "and it takes nobody else with it");
  assert.equal(session.consumers.size, 1);
});
