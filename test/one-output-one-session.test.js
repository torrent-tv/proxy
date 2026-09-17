/**
 * @file Many viewers of one output are handed one session.
 *
 * This is the product behaviour the whole output key exists for: two people
 * watching the same film, in the same form, at whatever moments, are served by
 * one encode and one set of pieces. It had no check of any kind — every test
 * that needed a session either built one by hand or replaced
 * `createOrGetSession` with a stub — so the one line that decides it could have
 * been broken by any edit without a word.
 *
 * What is checked here is the decision, not the creation: a session under the
 * name this request produces already exists, and the request must be answered
 * with it rather than with a new one. The name is the format produced, so the
 * request is first taken as far as the format — the file's facts and its
 * keyframe table are given as already known — and making the FIRST session,
 * which reaches the disk, is a different subject.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { wireOutputs } from "../services/serving/wire-outputs.js";
import { AudioOutput, CutGrid, OutputSpec, VideoOutput } from "../services/output/OutputSpec.js";
import { Timeline } from "../services/output/Timeline.js";
import { SourceFile } from "../services/media/SourceFile.js";
import { viewersOf } from "../services/viewer/Viewer.js";

const TORRENT = "torrent:11f0929918e2b5aa2e5b71ecdbe5c0f1a4bbf7d1";

/**
 * What a browser asks for: this file, copied, sound inside the stream.
 *
 * @param {object} [over]
 * @returns {object}
 */
function request(over = {}) {
  return {
    sourceKey: TORRENT,
    fileIndex: 0,
    fileName: "film.mkv",
    transcodeVideo: false,
    transcodeAudio: false,
    audioTrackIndex: 0,
    segmentFormatId: "fmp4",
    ...over
  };
}

/**
 * The name the manager will look that request up under, built the way it builds
 * it: a copied picture carrying its own sound, cut at the file's keyframes.
 *
 * @returns {string}
 */
function specOfThatOutput() {
  return new OutputSpec({
    sourceKey: TORRENT,
    segmentFormatId: "fmp4",
    grid: new CutGrid({ kind: "keyframe", fileIndex: 0 }),
    video: new VideoOutput({ fileIndex: 0, encode: null }),
    audio: new AudioOutput({ fileIndex: 0, trackIndex: 0, transcode: false })
  });
}

/** @returns {string} */
function nameOfThatOutput() {
  return specOfThatOutput().toName();
}

/**
 * @param {object} manager
 * @returns {object} The session it is seeded with.
 */
function seedOneSession(manager) {
  const session = {
    id: nameOfThatOutput(),
    spec: specOfThatOutput(),
    outputKey: "seeded",
    state: "ready",
    file: new SourceFile({ sourceKey: TORRENT, fileIndex: 0, name: "film.mkv" }),
    timeline: new Timeline({ boundaries: [0, 4, 8], cutGrid: "keyframe" }),
    claims: new Set(),
    runs: new Set(),
    progress: { processedSeconds: 0, startPositionSeconds: 0, updatedAt: Date.now() },
    lastAccessedAt: Date.now(),
    // READY, because a joining viewer waits for the session to be able to
    // answer them, and this file is about which session answers rather than
    // about that wait. A session publishing its own playlist from the probed
    // duration has nothing to wait for; left out, every check here would sit
    // out the warm-up deadline and would be measuring that timer.
    useSyntheticPlaylist: true
  };
  manager.outputs.set(session.id, session);
  return session;
}

/**
 * What the proxy already knows about the file when a second viewer arrives:
 * what a probe said, and where its keyframes are.
 *
 * @param {object} manager
 */
function knownFile(manager) {
  manager.getCachedMediaInfo = () => ({ durationSeconds: 8, width: 1920, height: 1080, fps: 24 });
  manager.keyframeTables.learn({ sourceKey: TORRENT, fileIndex: 0 }, { times: [0, 4], format: "test" });
}

test("a second viewer of one output is served by the session that exists", async (t) => {
  const manager = wireOutputs({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090
  });
  t.after(() => manager.lifecycle.disposeAll());
  // No plan runs here: this file is about which session answers a request, and
  // placing encoders would spawn real processes.
  manager.encodeRuns.planEncodersNow = () => {};
  manager.encodeRuns.planEncodersSoon = () => {};
  knownFile(manager);
  const seeded = seedOneSession(manager);

  const answered = await manager.viewerRequests.createOrGetSession(request({ consumerId: "viewer-two" }));

  assert.equal(answered, seeded, "one output, one session");
  assert.ok(viewersOf(seeded).has("viewer-two"), "and the second viewer is on it");
});

test("a request whose parameters differ is not that session", async (t) => {
  // The other half, and it is what makes the first mean anything: the name is
  // the output's, so a request producing something else must not find it. Here
  // the sound is to be re-encoded, which is a different output and a different
  // set of bytes.
  const manager = wireOutputs({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090,
    // A session made for real here waits for a playlist that nothing is going
    // to write. Zero, so this check spends no time on a deadline it is not
    // about — the deadline has its own subject elsewhere.
    startupWaitMs: 0
  });
  t.after(() => manager.lifecycle.disposeAll());
  manager.encodeRuns.planEncodersNow = () => {};
  manager.encodeRuns.planEncodersSoon = () => {};
  const seeded = seedOneSession(manager);

  let answered = null;
  try {
    answered = await manager.viewerRequests.createOrGetSession(request({ consumerId: "viewer-two", transcodeAudio: true }));
  } catch {
    // Making a session for real needs a probe and a disk, which this file does
    // not give it. Failing there is the proof: it did not take the seeded one.
    answered = null;
  }

  assert.notEqual(answered, seeded);
  assert.ok(!viewersOf(seeded).has("viewer-two"), "and nobody was added to somebody else's output");
});

test("two screens that come to the same format share one output, and a different format does not", async (t) => {
  const manager = wireOutputs({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090,
    startupWaitMs: 0,
    // A host with no ladder to choose from: the box asked for, fitted to the
    // source, is what is produced.
    videoEncoder: { kind: "vaapi", name: "h264_vaapi", inputArgs: [] }
  });
  t.after(() => manager.lifecycle.disposeAll());
  manager.encodeRuns.planEncodersNow = () => {};
  manager.encodeRuns.planEncodersSoon = () => {};
  knownFile(manager);
  const spec = new OutputSpec({
    sourceKey: TORRENT,
    segmentFormatId: "fmp4",
    grid: new CutGrid({ kind: "uniform", fileIndex: 0 }),
    video: new VideoOutput({
      fileIndex: 0,
      encode: { encoder: "h264_vaapi", width: 1920, height: 1080, fps: 24, preset: null, tonemap: false }
    }),
    audio: new AudioOutput({ fileIndex: 0, trackIndex: 0, transcode: false })
  });
  const seeded = { ...seedOneSession(manager), id: spec.toName(), spec, timeline: new Timeline({ boundaries: [0, 4, 8], cutGrid: "uniform" }) };
  manager.outputs.delete(nameOfThatOutput());
  manager.outputs.set(seeded.id, seeded);

  // A taller window than the film: fitted to the source it is the same 1920x1080.
  const joined = await manager.viewerRequests.createOrGetSession(
    request({ consumerId: "tall-window", transcodeVideo: true, targetWidth: 1920, targetHeight: 1200 })
  );
  assert.equal(joined, seeded, "the key names the format produced, not the window it was asked for");

  let other = null;
  try {
    other = await manager.viewerRequests.createOrGetSession(
      request({ consumerId: "small-window", transcodeVideo: true, targetWidth: 1280, targetHeight: 720 })
    );
  } catch {
    other = null;
  }
  assert.notEqual(other, seeded, "a smaller picture is another output");
  assert.ok(!viewersOf(seeded).has("small-window"));
});
