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
import { SourceFile } from "../services/source/SourceFile.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HlsSessionManager } from "../services/hls-session-manager.js";
import { Viewer, viewerOf, viewersOf } from "../services/viewer/Viewer.js";

const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

test("presence and position are two facts, and presence does not wait for a request", () => {
  const now = 1_000_000;
  const viewer = new Viewer("someone", now);

  // The whole of the 2026-09-05 failure in one assertion: a viewer who has
  // arrived and asked for nothing yet IS watching. Answered from the position
  // alone — which is written only when a segment is requested — this read
  // false, every encoder on their output was stopped for having nobody, and
  // the `init.mp4` they needed in order to request their first segment was
  // therefore never made.
  assert.equal(viewer.position, null, "nothing has placed them yet");
  assert.equal(viewer.isPresent(), true, "and they are still here");

  // SILENCE IS NOT ABSENCE, however long it lasts. A paused viewer, a hidden
  // tab whose timers the browser has throttled, and one holding two minutes of
  // cushion all say nothing and are all still watching — so there is no
  // interval that separates them from someone who has left, and the threshold
  // that used to try is gone.
  viewer.seen(now - 600_000);
  assert.equal(viewer.isPresent(), true, "ten minutes of silence is not leaving");

  // Something SAID they are gone: the browser released the session, or their
  // connection closed. That is the only way out.
  viewer.gone = true;
  assert.equal(viewer.isPresent(), false, "a statement is what ends it");
});

test("position is one fact with one writer, and a function of time", () => {
  const viewer = new Viewer("someone");
  assert.equal(viewer.positionSeconds(), null);

  viewer.moveTo(40, 1_000_000);
  viewer.playing = false;
  assert.equal(viewer.positionSeconds(1_000_000), 40);
  assert.equal(viewer.positionSeconds(1_060_000), 40, "a stopped picture covers no film");

  viewer.playing = true;
  assert.equal(viewer.positionSeconds(1_010_000), 50, "a playing one covers a second a second");

  // A seek is the same statement, and there is no second field for it to win
  // against: two writers taking turns on one reading is what made the priority
  // map jump backwards several times a second in the field on 2026-09-13.
  viewer.moveTo(900, 1_010_000);
  assert.equal(viewer.positionSeconds(1_010_000), 900);
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
    file: new SourceFile({ sourceKey: "source-1", fileIndex: 0, name: "video.mkv" }),
    // An ordinary session reads its own file, and its sound is inside it. The
    // three differ only for a soundtrack shipped as a file of its own.
    get inputFile() { return this.file; },
    get audioFile() { return this.file; },
    consumers: new Set(["staying", "leaving"]),
    viewers: new Map(),
    lastAccessedAt: Date.now()
  };
  manager.sessionsById.set(SESSION_ID, session);

  const leaving = viewerOf(session, "leaving");
  leaving.audio = { trackIndex: 2, transcode: true };
  leaving.activeVariantId = "some-variant";
  leaving.position = { segment: 40, seconds: 160, at: Date.now() };
  viewerOf(session, "staying").audio = { trackIndex: 0, transcode: false };

  await manager.releaseSessionConsumer(SESSION_ID, "leaving", "the tab was closed");

  assert.equal(session.viewers.has("leaving"), false, "one deletion, not six");
  assert.equal(session.viewers.has("staying"), true, "and it takes nobody else with it");
  assert.equal(session.consumers.size, 1);
});
