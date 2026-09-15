/**
 * @file The net under the dismantling of `hls-session-manager.js`.
 *
 * The file is 9608 lines and 142 methods, and it is being taken apart into the
 * seven layers. Twenty-one tests already construct it, but every one of them
 * names something INSIDE it — a private field, a fake session shaped the way
 * the manager happens to shape one — so every one of them moves when the code
 * moves, and a test that moves with the code cannot say the code still works.
 *
 * This one is derived from the other side: from what the HTTP layer asks of it.
 * That contract does not move. A route calling a member that no longer exists
 * is the exact failure a nine-step move risks, and it is silent — Fastify
 * answers 500 at runtime, months later, on a path no unit test walks.
 *
 * So the first check READS `routes/` and `server.js` rather than listing what
 * the manager has. It cannot go stale: adding a call to a route adds it to the
 * requirement, and removing the member it names breaks this test the same
 * minute.
 *
 * The second is a characteristic record rather than a judgement: what the
 * progress report carries today. Eighteen figures reach the page from it and
 * nothing on this side of the wire knows which of them the page needs, so the
 * honest statement is "these are the ones there were" — the point being that a
 * move must not change them, not that they are the right ones.
 *
 * Every manager here has a store root of its own, for the reason
 * `helpers/manager.js` records.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SourceFile } from "../services/source/SourceFile.js";
import { Timeline } from "../services/output/Timeline.js";
import { HlsSessionManager } from "../services/hls-session-manager.js";
import { managerWithOwnStore } from "./helpers/manager.js";
import { fmp4Format } from "../services/segment-formats/fmp4.js";
import { Output } from "../services/output/Output.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(HERE, "..");
const SESSION_ID = "aaaaaaaabbbbcccc";

/**
 * Every `.js` file under a directory, at any depth.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function jsFilesUnder(dir) {
  /** @type {string[]} */
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...jsFilesUnder(full));
      continue;
    }
    if (entry.name.endsWith(".js")) {
      found.push(full);
    }
  }
  return found;
}

/**
 * What the HTTP layer asks of the session manager, read from the HTTP layer.
 *
 * Deliberately not a list kept here: a list is a second statement of the same
 * fact, and the two drift. The callers are the statement.
 *
 * @returns {Map<string, string[]>} Member name to the files that ask for it.
 */
function membersTheHttpLayerCalls() {
  /** @type {Map<string, string[]>} */
  const asked = new Map();
  const sources = [path.join(PROXY, "server.js"), ...jsFilesUnder(path.join(PROXY, "routes"))];
  for (const file of sources) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/hlsSessionManager\.([A-Za-z][A-Za-z0-9]*)/g)) {
      const member = match[1];
      // A JSDoc `@param` names the type, not a call. Counting those would put
      // the class's own name into the requirement.
      const where = asked.get(member) ?? [];
      where.push(path.relative(PROXY, file));
      asked.set(member, where);
    }
  }
  return asked;
}

/**
 * A manager with nothing running behind it, over a store of its own.
 *
 * Its two timers are unref'd, so nothing here keeps the process alive.
 *
 * @returns {HlsSessionManager}
 */
function bareManager() {
  return managerWithOwnStore().manager;
}

/**
 * A session shaped like a live one, with no encoder behind it.
 *
 * @param {{ id?: string }} [params]
 * @returns {object}
 */
function fakeSession({ id = SESSION_ID } = {}) {
  return {
    id,
    outputKey: "surface:fmt=fmp4:grid=kf@0:video-only:v=0/copy",
    dirPath: path.join(PROXY, "test", "does-not-exist"),
    state: "ready",
    file: new SourceFile({ sourceKey: "torrent:abc", fileIndex: 0, name: "video.mkv" })
      .learn({ width: 1920, height: 1080 }),
    get inputFile() { return this.file; },
    get audioFile() { return this.file; },
    timeline: new Timeline({
      boundaries: Array.from({ length: 11 }, (_, index) => index * 4),
      cutGrid: "keyframe"
    }),
    segmentFormat: fmp4Format,
    output: new Output({
      encodeWidth: 0,
      encodeHeight: 0,
      outputFps: 24,
      softwarePreset: null,
      applyTonemap: false
    }),
    transcodeVideo: false,
    transcodeAudio: true,
    audioTrackIndex: 0,
    audioSourceTrackIndex: 0,
    startedAt: Date.now(),
    createEntryMs: Date.now(),
    lastAccessedAt: Date.now(),
    ffmpeg: null,
    lastError: "",
    consumers: new Set(),
    viewers: new Map(),
    encodeRunGeneration: 0,
    encodeStartIndex: 0,
    requestSeqCounter: 0,
    waitEpoch: 0,
    useSyntheticPlaylist: true,
    playlistText: "#EXTM3U\n",
    segmentCount: 10,
    progress: { state: "running", processedSeconds: 0, startPositionSeconds: 0, speed: "1.0x" }
  };
}

test("every call the HTTP layer makes is answered", () => {
  const manager = bareManager();
  const asked = membersTheHttpLayerCalls();
  // If this ever reads zero the extraction has broken, and the test would then
  // pass by asking nothing at all.
  assert.ok(asked.size >= 15, `expected the HTTP layer to ask for members, found ${asked.size}`);

  const missing = [];
  for (const [member, callers] of asked) {
    if (!(member in manager)) {
      missing.push(`${member} (asked by ${[...new Set(callers)].join(", ")})`);
    }
  }
  assert.deepEqual(missing, [], `the HTTP layer calls members the manager does not have:\n${missing.join("\n")}`);
});

test("the progress report keeps every figure it carries today", async () => {
  const manager = bareManager();
  manager.sessionsById.set(SESSION_ID, fakeSession());
  const progress = await manager.getSessionProgress(SESSION_ID, "viewer-one");
  assert.ok(progress, "a live session has a progress report");

  // A characteristic record: what the page is given now. The claim is "a move
  // did not change this", never "this is the right set".
  const carried = [
    "sessionId",
    "state",
    "minimumBufferSeconds",
    "processedSeconds",
    "inputBytes",
    "startPositionSeconds",
    "totalSeconds",
    "percent",
    "remainingSeconds",
    "segmentDurationSec",
    "speed",
    "currentHeight",
    "offeredHeights",
    "requestedHeight",
    "expectedSessionCreateMs",
    "expectedFirstSegmentMs",
    "updatedAt",
    "error"
  ];
  const absent = carried.filter((key) => !(key in progress));
  assert.deepEqual(absent, [], `the progress report lost ${absent.join(", ")}`);
  assert.equal(progress.sessionId, SESSION_ID);
});

test("a session that is not there is answered, not invented", async () => {
  const manager = bareManager();
  const absent = "ffffffffffffffff";

  assert.equal(await manager.getSessionProgress(absent), null);
  assert.equal((await manager.getFileStream(absent, "segment-00000.mp4")).kind, "not-found");
  // A name no session could have must be refused before anything touches the
  // disk with it.
  assert.equal((await manager.getFileStream("../../etc", "segment-00000.mp4")).kind, "not-found");
});

test("what a viewer states about themselves is kept and answered", () => {
  const manager = bareManager();
  manager.sessionsById.set(SESSION_ID, fakeSession());

  // Nine public members had no test of any kind before the dismantling began,
  // and six of them are the viewer's own facts — the ones that move into
  // `viewer/`. They are cheap to state and were simply never stated.
  const first = manager.nextRequestSeq(SESSION_ID);
  const second = manager.nextRequestSeq(SESSION_ID);
  assert.ok(second > first, "each request is told apart from the one before it");

  // A SEEK DOES ONE THING: it puts the viewer where they now are. Recorded
  // here because it used to do eleven, and because the one remaining effect is
  // what every reading of a viewer's position now rests on.
  assert.equal(manager.requestSeek(SESSION_ID, 120, "viewer-one"), true);
  assert.equal(manager.viewerPositionOf(SESSION_ID, "viewer-one"), 120);
  assert.equal(manager.requestSeek("no-such-session", 120, "viewer-one"), false);

  // `seekEpoch` is NOT moved by a seek, whatever its name says: its two writers
  // are the variant switch and the soundtrack switch, and they move it on the
  // output the viewer has LEFT. Recorded as it is, so the dismantling can give
  // the fact its real name instead of discovering this by breaking it.
  assert.equal(manager.seekEpoch(SESSION_ID), 0, "a seek leaves the wait epoch alone");
  assert.equal(manager.seekEpoch("no-such-session"), 0);

  manager.noteInputBytes(SESSION_ID, 4096);
  manager.noteInputBytes(SESSION_ID, 1024);
  assert.equal(manager.sessionsById.get(SESSION_ID).inputBytes, 5120, "input bytes accumulate");

  // A far fragment is a reading and must never throw, whatever the player says.
  manager.recordFragmentFar(SESSION_ID, {
    sn: 40, track: "video", fragStartSec: 200, bufferEndSec: 130, currentTimeSec: 128
  });
  manager.recordFragmentFar("no-such-session", { sn: 1, track: "video" });
});

test("a session nobody has touched is disposed, one that is being watched is not", async () => {
  const manager = bareManager();
  const stale = fakeSession({ id: "1111111111111111" });
  const fresh = fakeSession({ id: "2222222222222222" });
  // Older than any TTL this manager could carry, without naming one here: the
  // period is the manager's business and this test is about the rule.
  stale.lastAccessedAt = Date.now() - (2 * 60 * 60 * 1000);
  manager.sessionsById.set(stale.id, stale);
  manager.sessionsById.set(fresh.id, fresh);

  await manager.cleanupExpired();

  assert.equal(manager.sessionsById.has(stale.id), false, "an untouched session goes");
  assert.equal(manager.sessionsById.has(fresh.id), true, "a session just read stays");
});

test("what a file declares and what this host could offer are answered without a session", () => {
  const manager = bareManager();
  const session = fakeSession();
  manager.sessionsById.set(SESSION_ID, session);

  // `declaredTracks` reads the session's own record and must answer even when
  // nothing has probed the file yet.
  assert.doesNotThrow(() => manager.declaredTracks(session));

  // The offer is predicted before any session exists — that is its whole point,
  // the menu being complete from the moment a file is opened.
  assert.equal(manager.predictOfferedHeights({ height: 0, width: 0 }), null, "an unknown picture offers nothing");
  const offered = manager.predictOfferedHeights({
    height: 1080, width: 1920, fps: 24, sourceKey: "torrent:abc", fileIndex: 0
  });
  // TWO ANSWERS, not one: what this host can hold when the picture is copied,
  // and what it can hold when it is re-encoded. The browser decides which of
  // the two applies, because whether it can play the source is its own fact.
  assert.ok(Array.isArray(offered?.copy), "the copied branch gets a list");
  assert.ok(Array.isArray(offered?.transcode), "the re-encoded branch gets a list");
});

test("a segment name that is not one is refused", async () => {
  const manager = bareManager();
  manager.sessionsById.set(SESSION_ID, fakeSession());

  for (const name of ["../key.txt", "segment-00000.mp4/../../x", "making-0-00000.mp4"]) {
    const answer = await manager.getFileStream(SESSION_ID, name);
    assert.equal(answer.kind, "not-found", `${name} must not be servable`);
  }
});
