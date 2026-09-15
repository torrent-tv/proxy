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
 * with it rather than with a new one. Making the FIRST session reaches the
 * probe, the realtime budget and the disk, which is a different subject.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { HlsSessionManager } from "../services/hls-session-manager.js";
import { AudioOutput, CutGrid, OutputSpec, VideoOutput } from "../services/output/OutputSpec.js";
import { Timeline } from "../services/output/Timeline.js";
import { SourceFile } from "../services/source/SourceFile.js";

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
function nameOfThatOutput() {
  return new OutputSpec({
    sourceKey: TORRENT,
    segmentFormatId: "fmp4",
    grid: new CutGrid({ kind: "keyframe", fileIndex: 0 }),
    video: new VideoOutput({ fileIndex: 0, encode: null }),
    audio: new AudioOutput({ fileIndex: 0, trackIndex: 0, transcode: false })
  }).toName();
}

/**
 * @param {HlsSessionManager} manager
 * @returns {object} The session it is seeded with.
 */
function seedOneSession(manager) {
  const session = {
    id: nameOfThatOutput(),
    outputKey: "seeded",
    state: "ready",
    file: new SourceFile({ sourceKey: TORRENT, fileIndex: 0, name: "film.mkv" }),
    timeline: new Timeline({ boundaries: [0, 4, 8], cutGrid: "keyframe" }),
    consumers: new Set(["viewer-one"]),
    viewers: new Map(),
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
  manager.sessionsById.set(session.id, session);
  return session;
}

test("a second viewer of one output is served by the session that exists", async (t) => {
  const manager = new HlsSessionManager({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090
  });
  t.after(() => manager.disposeAll());
  // No plan runs here: this file is about which session answers a request, and
  // placing encoders would spawn real processes.
  manager.planEncodersNow = () => {};
  manager.planEncodersSoon = () => {};
  const seeded = seedOneSession(manager);

  const answered = await manager.createOrGetSession(request({ consumerId: "viewer-two" }));

  assert.equal(answered, seeded, "one output, one session");
  assert.ok(seeded.consumers.has("viewer-two"), "and the second viewer is on it");
});

test("a request whose parameters differ is not that session", async (t) => {
  // The other half, and it is what makes the first mean anything: the name is
  // the output's, so a request producing something else must not find it. Here
  // the sound is to be re-encoded, which is a different output and a different
  // set of bytes.
  const manager = new HlsSessionManager({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090,
    // A session made for real here waits for a playlist that nothing is going
    // to write. Zero, so this check spends no time on a deadline it is not
    // about — the deadline has its own subject elsewhere.
    startupWaitMs: 0
  });
  t.after(() => manager.disposeAll());
  manager.planEncodersNow = () => {};
  manager.planEncodersSoon = () => {};
  const seeded = seedOneSession(manager);

  let answered = null;
  try {
    answered = await manager.createOrGetSession(request({ consumerId: "viewer-two", transcodeAudio: true }));
  } catch {
    // Making a session for real needs a probe and a disk, which this file does
    // not give it. Failing there is the proof: it did not take the seeded one.
    answered = null;
  }

  assert.notEqual(answered, seeded);
  assert.ok(!seeded.consumers.has("viewer-two"), "and nobody was added to somebody else's output");
});
