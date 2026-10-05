/**
 * @file A failed encoder explains what is MISSING, and takes nothing away.
 *
 * Whether production failed used to be asked at the door, before the request
 * had even been looked at, so an output whose encoding ended in an error
 * answered 500 to every request — including requests for segments it had
 * already finished and which were lying on disk under their served names. The
 * viewer lost what was made as well as what was not, and a seek back into the
 * finished stretch could not be served either.
 *
 * A piece under its served name is whole by construction, whoever wrote it and
 * whatever has become of the encoder since. The failure belongs where a file is
 * absent: there it is the truthful answer, and holding the request instead only
 * spends the viewer's patience.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { wireOutputs } from "../../services/server/wire-outputs.js";
import { SourceFile } from "../../services/media/SourceFile.js";
import { Timeline } from "../../services/encode/output/Timeline.js";
import { Output } from "../../services/encode/output/Output.js";
import { KeyframeTable } from "../../services/media/container/KeyframeTable.js";
import { ENCODE_RUN_STATE } from "../../services/encode/encode-run-state.js";
import { fmp4Format } from "../../services/encode/segment-formats/fmp4.js";
import { EncodeRun } from "../../services/encode/EncodeRun.js";
import { fakeProcess, silentLogger } from "./helpers/encode-run.js";
import { waitForSessionFile } from "../../services/server/transcode-session-files.js";
import { outputSpec } from "./helpers/output-spec.js";

const SESSION_ID = "3333333344445555";
const OUTPUT_KEY = "failed-serves:fmt=fmp4:grid=uniform:video-only:v=0/copy";
// The other branch: a picture cut at the source's own keyframes, where the
// muxer is handed the cut times and writes each piece self-contained. It has no
// init FILE at all — the header is lifted out of the first piece — which is the
// case `#initFromFirstSegment` answers `null` for instead of throwing `ENOENT`.
const KEYFRAME_OUTPUT_KEY = "failed-serves-kf:fmt=fmp4:grid=kf@0:video-only:v=0/copy";

/**
 * One output with segment #0 finished on disk and its encoder dead.
 *
 * @returns {Promise<{ manager: object, dirPath: string, outputKey: string }>}
 */
async function outputWhoseEncoderDied({ failed = true, segments = [0], cutsAtGivenTimes = false } = {}) {
  const manager = wireOutputs({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090
  });
  manager.encodeRuns.planEncodersNow = () => {};
  manager.encodeRuns.planEncodersSoon = () => {};
  const outputKey = cutsAtGivenTimes ? KEYFRAME_OUTPUT_KEY : OUTPUT_KEY;
  manager.segmentStore.useFormat(outputKey, fmp4Format);
  const dirPath = manager.segmentStore.directoryFor(outputKey);
  // On the even grid — the branch that writes finished files outright, so their
  // existence is the proof and the fixture needs no header. The other branch
  // writes no init file at all.
  for (const index of segments) {
    await writeFile(path.join(dirPath, fmp4Format.segmentFileName(index)), Buffer.alloc(256, 0x5a));
  }

  const session = {
    id: SESSION_ID,
    spec: cutsAtGivenTimes
      ? outputSpec({ transcodeVideo: false, cutGrid: "keyframe" })
      : outputSpec({ transcodeVideo: true, cutGrid: "uniform" }),
    outputKey,
    dirPath,
    timeline: new Timeline({
      boundaries: [0, 12.5, 25, 37.5, 50, 62.5],
      cutGrid: cutsAtGivenTimes ? "keyframe" : "uniform"
    }),
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
    output: new Output({ encodeWidth: 0, encodeHeight: 0, outputFps: 25, softwarePreset: null, applyTonemap: false }),
    keyframes: new KeyframeTable().learn({ times: [0, 12.5, 25, 37.5, 50], format: "matroska" }),
    audioOnly: false,
    waitEpoch: 0
  };
  manager.outputs.set(SESSION_ID, session);
  manager.viewers.of(session, "viewer-a").moveTo(0);
  // The encoder ended for good, which is what every request below is asked
  // against.
  if (failed) {
    manager.encodeOrchestrator.noteEnded({
      address: outputKey,
      run: { state: ENCODE_RUN_STATE.ENDED_FAILED },
      lastError: "ffmpeg exited with code 255"
    });
    assert.equal(manager.encodeRuns.hasFailed(session), true, "the fixture must describe a failed output");
  }
  return { manager, dirPath, outputKey };
}

/**
 * Wait until the store really holds a wait for this output.
 *
 * A check that ends a wait it has not yet registered proves nothing: it passes
 * on the code that answers a request AFTER the event just as well as on the code
 * that answers one already standing. The deadline is a backstop, never the
 * measurement.
 *
 * @param {object} store
 * @param {string} key
 * @param {number} [howMany]
 * @returns {Promise<void>}
 */
async function untilWaitsAreRegistered(store, key, howMany = 1) {
  const giveUpAt = Date.now() + 5_000;
  while (store.waitingFor(key) < howMany) {
    if (Date.now() > giveUpAt) {
      throw new Error(`no wait registered on ${key} after 5s — the check would prove nothing`);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("a segment that is on disk is served although the encoder failed", async (t) => {
  const { manager, dirPath } = await outputWhoseEncoderDied();
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });

  const answer = await manager.serving.getFileStream(SESSION_ID, "segment-00000.mp4", { consumerId: "viewer-a" });

  assert.equal(answer.kind, "file", `what is made is made — the answer was ${answer.kind}`);
  assert.equal(answer.contentType, fmp4Format.segmentContentType);
});

test("a segment that is not there says the encoder failed, instead of being held", async (t) => {
  const { manager, dirPath } = await outputWhoseEncoderDied();
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });

  const answer = await manager.serving.getFileStream(SESSION_ID, "segment-00003.mp4", { consumerId: "viewer-a" });

  assert.equal(answer.kind, "failed", "nothing is going to write it, and the viewer is owed the reason");
  assert.match(answer.message, /255/);
});

test("the playlist is a fact of the timeline and outlives the encoder", async (t) => {
  const { manager, dirPath } = await outputWhoseEncoderDied();
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });

  const answer = await manager.serving.getFileStream(SESSION_ID, "index.m3u8", { consumerId: "viewer-a" });

  assert.equal(answer.kind, "file");
  assert.equal(answer.isPlaylist, true);
});

test("a failure reaches a request that was ALREADY waiting", async (t) => {
  // The case the other checks in this file do not reach: they set the failure
  // and then ask. A wait that began BEFORE it is ended by the publication, by a
  // wake, by the requester going or by its own deadline — and a failure is none
  // of those, so it sat out the whole deadline for a piece nothing was going to
  // make, and where the page states no deadline, until the viewer disconnected.
  const { manager, dirPath } = await outputWhoseEncoderDied({ failed: false });
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  const session = manager.outputs.get(SESSION_ID);
  const child = fakeProcess();
  const run = new EncodeRun({
    address: OUTPUT_KEY,
    encoder: { name: "libx264", kind: "software" },
    from: 3,
    to: 4,
    buildArgs: () => [],
    spawn: () => child,
    logger: silentLogger,
    lastSegmentIndex: () => 4,
    because: "a check asked for it",
    onEnded: (ended) => manager.encodeRuns.noteRunEnded(session, run, ended)
  });
  manager.encodeOrchestrator.adopt(OUTPUT_KEY, run);

  // Held with a deadline long enough that running it out IS the failure.
  const held = waitForSessionFile(manager.serving, SESSION_ID, "segment-00003.mp4", {
    holdMs: 30_000,
    consumerId: "viewer-a"
  });
  // The wait must EXIST before it can be said to have been woken.
  await untilWaitsAreRegistered(manager.segmentStore, OUTPUT_KEY);

  child.exit(255);

  // Bounded, because a regression here would otherwise HANG for the whole
  // thirty-second hold and take the rest of the file down with it.
  const answer = await settledWithin(held, 5_000);

  assert.notEqual(answer, STILL_WAITING, "it was left to sit out its whole hold");
  assert.equal(answer.kind, "failed", "a wait nothing will satisfy must be told");
});

/** What a race answers when the promise did not settle in time. */
const STILL_WAITING = Symbol("still waiting");

/**
 * The promise's answer, or {@link STILL_WAITING} if it has not settled yet.
 *
 * Used for BOTH directions, and the direction decides what the bound means. On
 * "it must be told", the bound is a backstop that turns a regression into a
 * failure in seconds instead of a test that hangs until the hold runs out — and
 * a hanging test is worse than an absent one, because it takes the rest of the
 * file down with it (measured here: three checks cancelled by one hang). On
 * "it must go on waiting", the bound IS the grace, and it cannot fail red — it
 * can only pass too easily.
 *
 * @param {Promise<unknown>} promise
 * @param {number} withinMs
 * @returns {Promise<unknown>}
 */
async function settledWithin(promise, withinMs) {
  return await Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(STILL_WAITING), withinMs))
  ]);
}

test("a run that exits 0 having produced less than promised also reaches a waiting request", async (t) => {
  // ffmpeg exits 0 both at the end of the file and when its input stops
  // delivering, so a run that stopped short claims success. That ending is
  // terminal all the same — and it was the one branch of the exit handler that
  // returned before anybody waiting was told.
  const { manager, dirPath } = await outputWhoseEncoderDied({ failed: false });
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  const session = manager.outputs.get(SESSION_ID);
  const child = fakeProcess();
  const run = new EncodeRun({
    address: OUTPUT_KEY,
    encoder: { name: "libx264", kind: "software" },
    from: 3,
    to: 4,
    buildArgs: () => [],
    spawn: () => child,
    logger: silentLogger,
    lastSegmentIndex: () => 4,
    because: "a check asked for it",
    onEnded: (ended) => manager.encodeRuns.noteRunEnded(session, run, ended)
  });
  manager.encodeOrchestrator.adopt(OUTPUT_KEY, run);

  const held = waitForSessionFile(manager.serving, SESSION_ID, "segment-00003.mp4", {
    holdMs: 30_000,
    consumerId: "viewer-a"
  });
  await untilWaitsAreRegistered(manager.segmentStore, OUTPUT_KEY);

  // Zero, having made none of the two segments it was given.
  child.exit(0);

  const answer = await settledWithin(held, 5_000);

  assert.equal(manager.encodeRuns.hasFailed(session), true, "stopping short is a failure, not a finished file");
  assert.notEqual(answer, STILL_WAITING, "it was left to sit out its whole hold");
  assert.equal(answer.kind, "failed", "a wait nothing will satisfy must be told");
});

test("one run of two ending in failure tells nobody — the other is still making it", async (t) => {
  // The condition is the OUTPUT's state, not this run's ending. A run that
  // failed while another is alive on the same output has not made the segment
  // unobtainable, so a request for it goes on waiting rather than being handed
  // an error by the run that lost.
  const { manager, dirPath } = await outputWhoseEncoderDied({ failed: false });
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });
  const session = manager.outputs.get(SESSION_ID);
  const runOf = (from, to, child) => {
    const run = new EncodeRun({
      address: OUTPUT_KEY,
      encoder: { name: "libx264", kind: "software" },
      from,
      to,
      buildArgs: () => [],
      spawn: () => child,
      logger: silentLogger,
      lastSegmentIndex: () => 4,
      because: "a check asked for it",
      onEnded: (ended) => manager.encodeRuns.noteRunEnded(session, run, ended)
    });
    manager.encodeOrchestrator.adopt(OUTPUT_KEY, run);
    return run;
  };
  const dying = fakeProcess();
  const working = fakeProcess();
  runOf(3, 3, dying);
  runOf(4, 4, working);

  const held = waitForSessionFile(manager.serving, SESSION_ID, "segment-00003.mp4", {
    holdMs: 30_000,
    consumerId: "viewer-a"
  });
  await untilWaitsAreRegistered(manager.segmentStore, OUTPUT_KEY);

  dying.exit(255);

  assert.equal(
    manager.encodeRuns.hasFailed(session),
    false,
    "the output has not failed while a run is alive on it"
  );
  assert.equal(await settledWithin(held, 300), STILL_WAITING, "the request must go on waiting");
});

test("an init that will never be made says so instead of warming up for ever", async (t) => {
  // On the branch that lifts the header out of the first piece there is no file
  // to be missing: `#initFromFirstSegment` answers null rather than throwing, so
  // the catch that names a failure is never reached and the answer was always
  // "still warming up".
  //
  // THE FIXTURE MUST BE ON THAT BRANCH, and it was not: with a re-encode on the
  // even grid `cutsAtGivenTimes` is false, so the check read a missing init
  // FILE and exercised the `ENOENT` path instead — the one that was never
  // broken. A copy cut at the source's own keyframes is the configuration that
  // writes no init file at all.
  const { manager, dirPath } = await outputWhoseEncoderDied({ segments: [], cutsAtGivenTimes: true });
  t.after(async () => {
    await manager.lifecycle.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });

  const answer = await manager.serving.getFileStream(SESSION_ID, "init.mp4", { consumerId: "viewer-a" });

  assert.equal(answer.kind, "failed", "nothing is going to produce the header it would come from");
  assert.match(answer.message, /255/);
});
