/**
 * @file What the HTTP layer asks of the components, checked from the HTTP layer.
 *
 * Written as the net under the dismantling of `hls-session-manager.js`, which
 * was 9608 lines and 142 methods and is now gone: its members are methods of
 * the components that own them, wired by `services/server/wire-outputs.js`.
 * Most tests that build those components name something INSIDE them — a field,
 * a fake output shaped the way one happens to be shaped — so they move when the
 * code moves, and a test that moves with the code cannot say the code still
 * works.
 *
 * This one is derived from the other side: from what the HTTP layer asks of
 * the components. That contract does not move. A route calling a member that no longer exists
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
import { SourceFile } from "../../services/media/SourceFile.js";
import { Timeline } from "../../services/encode/output/Timeline.js";
import { managerWithOwnStore } from "./helpers/manager.js";
import { fmp4Format } from "../../services/encode/segment-formats/fmp4.js";
import { Output } from "../../services/encode/output/Output.js";
import { outputSpec } from "./helpers/output-spec.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(HERE, "..", "..");
const SESSION_ID = "aaaaaaaabbbbcccc";
/** The components the HTTP layer is handed. */
const COMPONENTS = ["serving", "viewerRequests", "renditions", "lifecycle", "quality", "outputs", "coldStarts", "viewers", "encodeRuns"];

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
 * What the HTTP layer asks of each component, read from the HTTP layer.
 *
 * Deliberately not a list kept here: a list is a second statement of the same
 * fact, and the two drift. The callers are the statement. A route names the
 * component it was handed (`serving.getFileStream`); `server.js` names it
 * through what the wiring returned (`outputParts.serving.getFileStream`).
 *
 * @returns {Map<string, string[]>} `component.member` to the files that ask for it.
 */
function membersTheHttpLayerCalls() {
  /** @type {Map<string, string[]>} */
  const asked = new Map();
  const sources = [path.join(PROXY, "server.js"), ...jsFilesUnder(path.join(PROXY, "routes"))];
  const pattern = new RegExp(String.raw`\b(${COMPONENTS.join("|")})\.([A-Za-z][A-Za-z0-9]*)\(`, "g");
  for (const file of sources) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(pattern)) {
      const asking = `${match[1]}.${match[2]}`;
      const where = asked.get(asking) ?? [];
      where.push(path.relative(PROXY, file));
      asked.set(asking, where);
    }
  }
  return asked;
}

/**
 * A manager with nothing running behind it, over a store of its own.
 *
 * Its two timers are unref'd, so nothing here keeps the process alive.
 *
 * @returns {object}
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
    spec: outputSpec({ cutGrid: "keyframe", audioSeparate: true }),
    outputKey: "surface:fmt=fmp4:grid=kf@0:video-only:v=0/copy",
    dirPath: path.join(PROXY, "test", "does-not-exist"),
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
    useSyntheticPlaylist: true,
    playlistText: "#EXTM3U\n",
    segmentCount: 10,
    progress: { state: "running", processedSeconds: 0, startPositionSeconds: 0 }
  };
}

test("every call the HTTP layer makes is answered", () => {
  const parts = bareManager();
  const asked = membersTheHttpLayerCalls();
  // If this ever reads zero the extraction has broken, and the test would then
  // pass by asking nothing at all.
  assert.ok(asked.size >= 15, `expected the HTTP layer to ask for members, found ${asked.size}`);

  const missing = [];
  for (const [asking, callers] of asked) {
    const [component, member] = asking.split(".");
    if (!(parts[component] && member in parts[component])) {
      missing.push(`${asking} (asked by ${[...new Set(callers)].join(", ")})`);
    }
  }
  assert.deepEqual(missing, [], `the HTTP layer calls members no component has:\n${missing.join("\n")}`);
});

test("the progress report keeps every figure it carries today", async () => {
  const manager = bareManager();
  manager.outputs.set(SESSION_ID, fakeSession());
  const progress = await manager.viewerRequests.getSessionProgress(SESSION_ID, "viewer-one");
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
    "currentHeight",
    "offeredHeights",
    "requestedHeight",
    "updatedAt",
    "error"
  ];
  const absent = carried.filter((key) => !(key in progress));
  assert.deepEqual(absent, [], `the progress report lost ${absent.join(", ")}`);
  assert.equal(progress.sessionId, SESSION_ID);
});

test("a failed selected soundtrack fails playback progress even while video remains available", async () => {
  const manager = bareManager();
  const video = fakeSession();
  const audio = fakeSession({ id: "1111111122223333" });
  audio.outputKey = "soundtrack";
  manager.outputs.set(video.id, video);
  manager.outputs.set(audio.id, audio);
  manager.renditions.playbackAudioOutputFor = () => audio;
  manager.encodeRuns.wireStateOf = output => output === audio ? "failed" : "running";
  manager.encodeRuns.failureOf = output => output === audio ? "Closed audio piece has incomplete media." : "";
  const progress = await manager.viewerRequests.getSessionProgress(video.id, "viewer-one");
  assert.equal(progress.state, "failed");
  assert.equal(progress.error, "Closed audio piece has incomplete media.");
  manager.renditions.playbackAudioOutputFor = () => null;
  const current = await manager.viewerRequests.getSessionProgress(video.id, "viewer-one");
  assert.equal(current.state, "running");
  assert.equal(current.error, "");
});

test("a session that is not there is answered, not invented", async () => {
  const manager = bareManager();
  const absent = "ffffffffffffffff";

  assert.equal(await manager.viewerRequests.getSessionProgress(absent), null);
  assert.equal((await manager.serving.getFileStream(absent, "segment-00000.mp4")).kind, "not-found");
  // A name no session could have must be refused before anything touches the
  // disk with it.
  assert.equal((await manager.serving.getFileStream("../../etc", "segment-00000.mp4")).kind, "not-found");
});

test("what a viewer states about themselves is kept and answered", () => {
  const manager = bareManager();
  manager.outputs.set(SESSION_ID, fakeSession());

  // Nine public members had no test of any kind before the dismantling began,
  // and six of them are the viewer's own facts — the ones that move into
  // `viewer/`. They are cheap to state and were simply never stated.

  // A SEEK DOES ONE THING: it puts the viewer where they now are. Recorded
  // here because it used to do eleven, and because the one remaining effect is
  // what every reading of a viewer's position now rests on.
  assert.equal(manager.viewerRequests.requestSeek(SESSION_ID, 120, "viewer-one"), true);
  assert.equal(manager.viewerRequests.viewerPositionOf(SESSION_ID, "viewer-one"), 120);
  assert.equal(manager.viewerRequests.requestSeek("no-such-session", 120, "viewer-one"), false);

  // A seek wakes requests held on each output this viewer watches so each one
  // can check whether it is still the segment this viewer needs.
  assert.equal(manager.serving.seekEpoch(SESSION_ID), 1, "a seek invalidates waits on the watched output");
  assert.equal(manager.serving.seekEpoch("no-such-session"), 0);

  manager.encodeRuns.noteInputBytes(SESSION_ID, 4096);
  manager.encodeRuns.noteInputBytes(SESSION_ID, 1024);
  assert.equal(
    manager.encodeRuns.inputBytesOf(manager.outputs.get(SESSION_ID)),
    5120,
    "input bytes accumulate at their owner"
  );

  // A far fragment is a reading and must never throw, whatever the player says.
  manager.serving.recordFragmentFar(SESSION_ID, {
    sn: 40, track: "video", fragStartSec: 200, bufferEndSec: 130, currentTimeSec: 128
  });
  manager.serving.recordFragmentFar("no-such-session", { sn: 1, track: "video" });
});

test("what a file declares and what this host could offer are answered without a session", () => {
  const manager = bareManager();
  const session = fakeSession();
  manager.outputs.set(SESSION_ID, session);

  // `declaredTracks` reads the session's own record and must answer even when
  // nothing has probed the file yet.
  assert.doesNotThrow(() => manager.renditions.declaredTracks(session));

  // The offer is predicted before any session exists — that is its whole point,
  // the menu being complete from the moment a file is opened.
  assert.equal(manager.quality.predictOfferedHeights({ height: 0, width: 0 }), null, "an unknown picture offers nothing");
  const offered = manager.quality.predictOfferedHeights({
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
  manager.outputs.set(SESSION_ID, fakeSession());

  for (const name of ["../key.txt", "segment-00000.mp4/../../x", "making-0-00000.mp4"]) {
    const answer = await manager.serving.getFileStream(SESSION_ID, name);
    assert.equal(answer.kind, "not-found", `${name} must not be servable`);
  }
});
