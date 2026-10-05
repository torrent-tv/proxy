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
import { wireOutputs } from "../../services/server/wire-outputs.js";
import { AudioOutput, CutGrid, OutputSpec, VideoOutput } from "../../services/encode/output/OutputSpec.js";
import { Timeline } from "../../services/encode/output/Timeline.js";
import { SourceFile } from "../../services/media/SourceFile.js";

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
function specOfThatOutput({ trackIndex = 0, transcode = false } = {}) {
  return new OutputSpec({
    sourceKey: TORRENT,
    segmentFormatId: "fmp4",
    grid: new CutGrid({ kind: "keyframe", fileIndex: 0 }),
    video: new VideoOutput({ fileIndex: 0, encode: null }),
    audio: new AudioOutput({ fileIndex: 0, trackIndex, transcode })
  });
}

/** @returns {string} */
function nameOfThatOutput(sound) {
  return specOfThatOutput(sound).toName();
}

/**
 * @param {object} manager
 * @param {{ trackIndex?: number, transcode?: boolean }} [sound] - The soundtrack
 *   the seeded output carries; the file's own, copied, when left out.
 * @returns {object} The session it is seeded with.
 */
function seedOneSession(manager, sound = {}) {
  const session = {
    id: nameOfThatOutput(sound),
    spec: specOfThatOutput(sound),
    // Its own address, so two seeded outputs are two places for viewers.
    outputKey: specOfThatOutput(sound).toKey(),
    state: "ready",
    file: new SourceFile({ sourceKey: TORRENT, fileIndex: 0, name: "film.mkv" }),
    timeline: new Timeline({ boundaries: [0, 4, 8], cutGrid: "keyframe" }),
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
  // This check exercises output identity. Machine admission has its own tests.
  manager.admission.admitsWatching = () => ({ admitted: true, reason: "", speedX: 8 });
  manager.admission.previewCandidate = () => ({ admitted: true, reason: "", speedX: 8 });
  manager.getCachedMediaInfo = () => ({ durationSeconds: 8, width: 1920, height: 1080, fps: 24 });
  // The soundtracks the plan listed: the file's own, at the rate it states, and
  // a dub beside it that states nothing — which no link can be asked about as a
  // copy, so it is sent re-encoded.
  manager.getCachedAudioTracks = () => [
    { index: 0, fileIndex: 0, sourceTrackIndex: 0, bitrateKbps: 128 },
    { index: 1, fileIndex: 0, sourceTrackIndex: 1, bitrateKbps: null, peakKbps: null }
  ];
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
  assert.ok(manager.viewers.forOutput(seeded).has("viewer-two"), "and the second viewer is on it");
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
  assert.ok(!manager.viewers.forOutput(seeded).has("viewer-two"), "and nobody was added to somebody else's output");
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
  assert.ok(!manager.viewers.forOutput(seeded).has("small-window"));
});

test("a remembered dub with no stated rate opens on the output that sends it as AAC, not on its copy", async (t) => {
  // The field case of 2026-10-01: the next episode opened on a dub the page
  // remembered, which its browser plays as it stands and nothing states a rate
  // for. Opened as a copy, no link could be asked about it and the episode was
  // refused; it is the AAC output that answers.
  const manager = wireOutputs({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090,
    // A measured copy speed, so this machine can price the output and the
    // admission answers on room rather than on knowing nothing.
    copySpeedX: 20
  });
  t.after(() => manager.lifecycle.disposeAll());
  manager.encodeRuns.planEncodersNow = () => {};
  manager.encodeRuns.planEncodersSoon = () => {};
  knownFile(manager);
  const copied = seedOneSession(manager, { trackIndex: 1, transcode: false });
  const encoded = seedOneSession(manager, { trackIndex: 1, transcode: true });

  const answered = await manager.viewerRequests.createOrGetSession(
    request({ consumerId: "viewer-two", audioTrackIndex: 1, transcodeAudio: false })
  );

  assert.equal(answered, encoded, "the dub is re-encoded");
  assert.notEqual(answered, copied);
  assert.deepEqual(
    manager.renditions.soundtrackOf(answered, "viewer-two"),
    { trackIndex: 1, transcode: true },
    "and the viewer is recorded as receiving AAC"
  );
});

test("a track whose rate is stated is still copied for a browser that plays it", async (t) => {
  const manager = wireOutputs({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090,
    // A measured copy speed, so this machine can price the output and the
    // admission answers on room rather than on knowing nothing.
    copySpeedX: 20
  });
  t.after(() => manager.lifecycle.disposeAll());
  manager.encodeRuns.planEncodersNow = () => {};
  manager.encodeRuns.planEncodersSoon = () => {};
  knownFile(manager);
  const copied = seedOneSession(manager);
  seedOneSession(manager, { trackIndex: 0, transcode: true });

  const answered = await manager.viewerRequests.createOrGetSession(request({ consumerId: "viewer-two" }));

  assert.equal(answered, copied);
});
