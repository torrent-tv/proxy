import assert from "node:assert/strict";
import test from "node:test";
import { createPlaybackPlanner } from "../../services/media/playback-planner.js";
import { playbackDeclarations } from "../../services/media/playback-declarations.js";
import { VideoTrack } from "../../services/media/tracks/VideoTrack.js";
import { AudioTrack } from "../../services/media/tracks/AudioTrack.js";

const video = new VideoTrack({ trackNumber: 1, declaredIndex: 0, codecId: "V_MPEG4/ISO/AVC",
  width: 1920, height: 1080, fps: 24, bitDepth: 10 });
const media = { format: "matroska", durationSeconds: 120, startTimeSeconds: -0.04 };

test("closing a source releases its plan and a late declaration cannot restore it", async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  let reads = 0;
  const planner = createPlaybackPlanner({ transcodeAudioEnabled: true, localBaseUrl: "http://127.0.0.1:9090",
    sourceRegistry: { get: () => ({ sourceType: "fake", source: "fake" }) },
    torrentPool: { getTorrent: async () => ({ files: [{ name: "film.mkv", length: 100 }] }) },
    declaredTracksOf: async () => [video], readDeclarations: async () => {
      if (++reads === 1) { entered(); return delayed; }
      return { kind: "result", value: { tracks: [video], media } };
    } });
  const old = planner.getPlan({ sourceKey: "source", fileIndex: 0 });
  await started;
  planner.forget("source");
  const current = await planner.getPlan({ sourceKey: "source", fileIndex: 0 });
  release({ kind: "result", value: { tracks: [video], media: { ...media, durationSeconds: 999 } } });
  await assert.rejects(old, error => error.code === "SOURCE_FORGOTTEN");
  assert.equal(current.durationSeconds, 120);
  assert.equal(planner.getCachedMediaInfo({ sourceKey: "source", fileIndex: 0 }).durationSeconds, 120);
  planner.forget("source");
  assert.equal(planner.getCachedMediaInfo({ sourceKey: "source", fileIndex: 0 }), null);
});

test("playback reads container facts without launching a separate URL probe", async () => {
  let reads = 0;
  const planner = createPlaybackPlanner({ ffmpegBin: "must-not-be-started",
    transcodeAudioEnabled: true, localBaseUrl: "http://127.0.0.1:9090",
    sourceRegistry: { get: () => ({ sourceType: "fake", source: "fake" }) },
    torrentPool: { getTorrent: async () => ({ files: [{ name: "film.mkv", length: 100 }] }) },
    declaredTracksOf: async () => [video],
    readDeclarations: async () => {
      reads++;
      return reads === 1 ? { kind: "needs-memory", bytes: 65536 }
        : { kind: "result", value: { tracks: [video], media } };
    }
  });
  const pending = await planner.getPlan({ sourceKey: "source", fileIndex: 0 });
  assert.equal(pending.pending, true);
  assert.equal(planner.getCachedMediaInfo({ sourceKey: "source", fileIndex: 0 }), null);
  const plan = await planner.getPlan({ sourceKey: "source", fileIndex: 0 });
  assert.equal(plan.pending, undefined);
  assert.equal(plan.videoCodec, "h264");
  assert.equal(plan.videoWidth, 1920);
  assert.equal(plan.durationSeconds, 120);
  const cached = planner.getCachedMediaInfo({ sourceKey: "source", fileIndex: 0 });
  assert.equal(cached.startTime, -0.04);
  assert.equal(cached.bitDepth, 10);
  assert.deepEqual(cached.streamCounts, { video: 1, audio: 0, subtitle: 0 });
  await planner.getPlan({ sourceKey: "source", fileIndex: 0 });
  assert.equal(reads, 2);
});

test("container codec names and declared audio order form the playback inventory", () => {
  const tracks = [video,
    new AudioTrack({ trackNumber: 3, declaredIndex: 1, codecId: "A_AC3", name: "Commentary" }),
    new AudioTrack({ trackNumber: 2, declaredIndex: 0, codecId: "A_AAC", name: "Original" })];
  const facts = playbackDeclarations({ tracks, media });
  assert.equal(facts.audioCodec, "aac");
  assert.deepEqual(facts.audioTracks.map(track => [track.index, track.codec, track.title]),
    [[0, "aac", "Original"], [1, "ac3", "Commentary"]]);
  assert.deepEqual(facts.streamCounts, { video: 1, audio: 2, subtitle: 0 });
});

test("whole-file decode pricing uses measured size and duration without inventing packet addresses", () => {
  const facts = playbackDeclarations({ tracks: [video], media, fileBytes: 150000000 });
  assert.equal(facts.bitrateKbps, 10000);
  assert.equal(playbackDeclarations({ tracks: [video], media: { ...media, durationSeconds: null }, fileBytes: 150000000 }).bitrateKbps, null);
  const header = Buffer.alloc(40);
  header.write("XVID", 16, "ascii");
  assert.equal(playbackDeclarations({ tracks: [{ ...video, codecId: "V_MS/VFW/FOURCC", codecPrivateB64: header.toString("base64") }], media }).videoCodec, "mpeg4");
});
