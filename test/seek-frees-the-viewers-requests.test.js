/**
 * @file A seek must free the requests it made pointless, on every output that
 * viewer watches, and only theirs.
 *
 * hls.js keeps ONE fragment load outstanding per track, so a request held for a
 * segment the viewer has just left blocks the request for where they now are.
 * Measured 2026-08-04: 57 s of a 58 s backward seek was that wait, and the
 * segment they wanted was served in 15 ms once it was asked for.
 *
 * The guard against it was built — the route compares a seek epoch and asks
 * whether each held request is still wanted — and nothing moved that epoch: no
 * caller of `invalidateWaits` was a seek.
 *
 * TWO THINGS THIS CHECK HAS TO DO, and the first version of it did neither.
 * It must wait until the store really HOLDS the waits, because a seek that
 * happens before they are registered frees nothing and passes all the same; and
 * it must cover the three outputs one viewer watches — the picture the browser
 * addresses, the step on their screen, their soundtrack — because waking only
 * the one the browser named leaves two thirds of their requests standing.
 *
 * And waking is not cancelling: one viewer's seek must leave another viewer's
 * request for the same segment of the same output exactly where it was.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { wireOutputs } from "../services/server/wire-outputs.js";
import { waitForSessionFile } from "../routes/transcode/session-file/get.js";
import { SourceFile } from "../services/media/SourceFile.js";
import { Timeline } from "../services/encode/output/Timeline.js";
import { Output } from "../services/encode/output/Output.js";
import { KeyframeTable } from "../services/media/container/KeyframeTable.js";
import { fmp4Format } from "../services/encode/segment-formats/fmp4.js";
import { outputSpec } from "./helpers/output-spec.js";

const SESSION_ID = "2222222233334444";
const OUTPUT_KEY = "seek-frees:fmt=fmp4:grid=uniform:video-only:v=0/copy";
const STEP_ID = "3333333344445555";
const STEP_KEY = "seek-frees:fmt=fmp4:grid=uniform:video-only:v=0/libx264/960x540";
const SOUND_ID = "4444444455556666";
const SOUND_KEY = "seek-frees:fmt=fmp4:grid=uniform:audio-only:a=0/0/aac";
/** Long enough that running out of it is a failure and never the measurement. */
const HOLD_MS = 30_000;

/**
 * One output of the film, with nothing produced for it yet.
 *
 * @param {object} manager
 * @param {{ id: string, key: string, audioOnly?: boolean, height?: number }} what
 * @returns {object}
 */
function outputOn(manager, { id, key, audioOnly = false, height = 0 }) {
  manager.segmentStore.useFormat(key, fmp4Format);
  const dirPath = manager.segmentStore.directoryFor(key);
  const session = {
    id,
    spec: outputSpec({ transcodeVideo: height > 0, height, audioOnly, cutGrid: "uniform" }),
    outputKey: key,
    dirPath,
    timeline: new Timeline({ boundaries: [0, 12.5, 25, 37.5, 50, 62.5], cutGrid: "uniform" }),
    state: "ready",
    file: new SourceFile({ sourceKey: "source-1", fileIndex: 0, name: "video.mkv" }).learn({ durationSeconds: 62.5 }),
    get inputFile() { return this.file; },
    get audioFile() { return this.file; },
    lastAloneSpeed: 2,
    startedAt: Date.now(),
    lastAccessedAt: Date.now(),
    runs: new Set(),
    lastError: "",
    consumers: new Set(),
    viewers: new Map(),
    segmentCount: 5,
    segmentFormat: fmp4Format,
    useSyntheticPlaylist: true,
    playlistText: "#EXTM3U\n",
    output: new Output({ encodeWidth: 0, encodeHeight: height, outputFps: 25, softwarePreset: null, applyTonemap: false }),
    keyframes: new KeyframeTable().learn({ times: [0, 12.5, 25, 37.5, 50], format: "matroska" }),
    audioOnly,
    waitEpoch: 0
  };
  manager.outputs.set(id, session);
  return session;
}

/**
 * Wait until the store really holds this many waits on an output.
 *
 * The deadline is a backstop and never the measurement: what is waited for is
 * the registration itself, which is the store's own state.
 *
 * @param {object} manager
 * @param {string} key
 * @param {number} howMany
 * @returns {Promise<void>}
 */
async function untilWaitsAreRegistered(manager, key, howMany) {
  const giveUpAt = Date.now() + 5_000;
  while (manager.segmentStore.waitingFor(key) < howMany) {
    if (Date.now() > giveUpAt) {
      throw new Error(`only ${manager.segmentStore.waitingFor(key)} wait(s) on ${key} after 5s`);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * The picture, one quality step and one soundtrack of a film, with two viewers
 * on the picture and one of them also on the step and the soundtrack.
 *
 * @returns {{ manager: object, session: object, step: object, sound: object }}
 */
function filmWithThreeOutputs() {
  const manager = wireOutputs({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090
  });
  // No plan runs here: this is about the path that answers a request, and
  // letting the plan run would spawn real encoders.
  manager.encodeRuns.planEncodersNow = () => {};
  manager.encodeRuns.planEncodersSoon = () => {};
  const session = outputOn(manager, { id: SESSION_ID, key: OUTPUT_KEY });
  const step = outputOn(manager, { id: STEP_ID, key: STEP_KEY, height: 540 });
  const sound = outputOn(manager, { id: SOUND_ID, key: SOUND_KEY, audioOnly: true });
  for (const consumerId of ["viewer-a", "viewer-b"]) {
    manager.viewers.of(session, consumerId).moveTo(0);
  }
  for (const output of [step, sound]) {
    manager.viewers.of(step === output ? step : sound, "viewer-a").moveTo(0);
  }
  return { manager, session, step, sound };
}

/**
 * @param {object} manager
 * @param {string} consumerId
 * @param {string} sessionId
 * @returns {Promise<{ kind: string }>}
 */
function holdFor(manager, consumerId, sessionId = SESSION_ID) {
  return waitForSessionFile(manager.serving, sessionId, "segment-00000.mp4", {
    holdMs: HOLD_MS,
    consumerId
  });
}

test("a seek frees the seeker's requests on every output they watch", async (t) => {
  const { manager, session, step, sound } = filmWithThreeOutputs();
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    for (const output of [session, step, sound]) {
      await rm(output.dirPath, { recursive: true, force: true });
    }
  });

  const onPicture = holdFor(manager, "viewer-a");
  const onStep = holdFor(manager, "viewer-a", STEP_ID);
  const onSound = holdFor(manager, "viewer-a", SOUND_ID);
  let stayed = "still held";
  const stayer = holdFor(manager, "viewer-b").then((result) => {
    stayed = result.kind;
    return result;
  });
  // Every one of them must EXIST before the seek, or the check proves nothing.
  await untilWaitsAreRegistered(manager, OUTPUT_KEY, 2);
  await untilWaitsAreRegistered(manager, STEP_KEY, 1);
  await untilWaitsAreRegistered(manager, SOUND_KEY, 1);

  const startedAt = Date.now();
  assert.equal(manager.viewerRequests.requestSeek(SESSION_ID, 50, "viewer-a"), true);

  const released = await Promise.all([onPicture, onStep, onSound]);
  const heldMs = Date.now() - startedAt;

  for (const [index, answer] of released.entries()) {
    assert.equal(
      answer.kind,
      "superseded",
      `the request on output ${index} was made for a position its viewer has left`
    );
  }
  assert.ok(heldMs < HOLD_MS / 2, `they were freed after ${heldMs}ms, which is the hold running out`);

  // A grace before asserting that something did NOT happen: it can only ever
  // pass too easily, never fail by luck.
  await delay(300);
  assert.equal(stayed, "still held", "the other viewer is where they were and still wants this segment");
  void stayer;
});

test("the request that was kept is served when its segment appears", async (t) => {
  const { manager, session, step, sound } = filmWithThreeOutputs();
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    for (const output of [session, step, sound]) {
      await rm(output.dirPath, { recursive: true, force: true });
    }
  });

  const seeker = holdFor(manager, "viewer-a");
  const stayer = holdFor(manager, "viewer-b");
  await untilWaitsAreRegistered(manager, OUTPUT_KEY, 2);
  manager.viewerRequests.requestSeek(SESSION_ID, 50, "viewer-a");
  assert.equal((await seeker).kind, "superseded");

  // The piece the viewer who stayed was waiting for, written as a run writes
  // it: under its served name, which is the whole of what says it is closed.
  await writeFile(path.join(session.dirPath, fmp4Format.segmentFileName(0)), Buffer.alloc(256, 0x5a));

  const answer = await stayer;

  assert.equal(answer.kind, "file", `a wake is a re-check, not a cancellation — got ${answer.kind}`);
});
