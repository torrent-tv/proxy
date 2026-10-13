import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import ffmpegBin from "ffmpeg-static";
import ffprobe from "@ffprobe-installer/ffprobe";
import { ContainerOrchestrator } from "../../services/media/ContainerOrchestrator.js";
import { readPlaybackDeclarations } from "../../services/media/read-playback-declarations.js";

// Generated ordinary media only; no torrent imports.
//
// The length a file is planned with, read the way the plan reads it and held
// against FFmpeg's reading of the same file. The plan's timeline begins at the
// file's start, and every cut is published as its time less that start, so the
// length must be counted from there too (torrent-tv/meta#178).

const FPS = 25;
const PICTURE = ["-f", "lavfi", "-i", `testsrc2=size=160x120:rate=${FPS}`];
const SOUND = ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"];

async function inDirectory(body) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ttv178-length-"));
  try {
    await body(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function make(file, args) {
  const made = spawnSync(ffmpegBin, ["-v", "error", ...args, file], { windowsHide: true });
  assert.equal(made.status, 0, String(made.stderr));
}

function probe(file, entries) {
  return JSON.parse(spawnSync(ffprobe.path, ["-v", "error", ...entries, "-of", "json", file],
    { encoding: "utf8", windowsHide: true }).stdout);
}

/** FFmpeg's decoded pictures, on the file's clock: [time, keyframe]. */
function pictures(file) {
  return probe(file, ["-select_streams", "v:0", "-show_entries", "frame=best_effort_timestamp_time,key_frame"]).frames
    .map(frame => [Number(frame.best_effort_timestamp_time), frame.key_frame === 1])
    .filter(([time]) => Number.isFinite(time));
}

/** Where FFmpeg's picture starts and where its last picture ends. */
function pictureSpan(file) {
  const times = pictures(file).map(([time]) => time);
  return { start: Math.min(...times), end: Math.max(...times) + 1 / FPS };
}

async function planned(file) {
  const bytes = await fs.readFile(file);
  const result = await readPlaybackDeclarations(new ContainerOrchestrator(), { sourceKey: "generated", fileIndex: 0,
    fileSize: bytes.length, label: path.basename(file), packetInterval: { from: 0, to: 1 },
    readRange: async (start, end) => bytes.subarray(start, end + 1) });
  assert.equal(result.kind, "result", JSON.stringify(result));
  return result.value.media;
}

test("a Matroska file that states no Duration is planned for as long as its frames last", () => inDirectory(async directory => {
  const file = path.join(directory, "film.mkv");
  make(file, [...PICTURE, ...SOUND, "-t", "10", "-c:v", "libx264", "-preset", "ultrafast", "-g", "50", "-c:a", "aac"]);
  const stated = Number(probe(file, ["-show_entries", "format=duration"]).format.duration);
  // Overwrite Info's Duration (id 0x4489, an eight-byte float) with a Void
  // element of the same eleven bytes, as a file written while streaming has it.
  const bytes = await fs.readFile(file);
  const info = bytes.indexOf(Buffer.from([0x15, 0x49, 0xa9, 0x66]));
  const duration = bytes.indexOf(Buffer.from([0x44, 0x89, 0x88]), info);
  assert.ok(info >= 0 && duration > info, "the muxer wrote a Duration into Info");
  Buffer.from([0xec, 0x89, 0, 0, 0, 0, 0, 0, 0, 0, 0]).copy(bytes, duration);
  const unstated = path.join(directory, "unstated.mkv");
  await fs.writeFile(unstated, bytes);
  assert.equal(probe(unstated, ["-show_entries", "format=duration"]).format.duration, undefined, "the file states no length");
  const media = await planned(unstated);
  assert.ok(Math.abs(media.durationSeconds - stated) < 1 / FPS, `planned for ${media.durationSeconds}s where the stated file lasts ${stated}s`);
}));

for (const [name, extension] of [["An MP4", "mp4"], ["A Matroska file", "mkv"]]) {
  test(`${name} that starts at five seconds lists nothing past its last picture`, () => inDirectory(async directory => {
    // FFmpeg's muxers keep a source's timestamps: an empty edit in MP4, a later
    // first Cluster in Matroska. Counted from zero, the plan listed five seconds
    // that no picture lies in.
    const file = path.join(directory, `film.${extension}`);
    make(file, [...PICTURE, ...SOUND, "-t", "10", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-output_ts_offset", "5"]);
    const picture = pictureSpan(file);
    const media = await planned(file);
    assert.ok(Math.abs(media.startTimeSeconds - picture.start) < 1 / FPS, `starts at ${media.startTimeSeconds}s, FFmpeg's picture at ${picture.start}s`);
    const end = media.startTimeSeconds + media.durationSeconds;
    assert.ok(Math.abs(end - picture.end) < 1 / FPS, `the plan ends at ${end}s, the last picture at ${picture.end}s`);
  }));
}

test("an MPEG program stream of several groups of pictures is indexed where FFmpeg places them", () => inDirectory(async directory => {
  // FFmpeg's program stream muxer does not stamp every picture, and a group
  // whose first picture came unstamped was placed on the previous group's base:
  // no MPEG-PS file of more than one group opened.
  const file = path.join(directory, "film.vob");
  make(file, [...PICTURE, ...SOUND, "-t", "10", "-c:v", "mpeg2video", "-g", "12", "-c:a", "mp2", "-f", "vob"]);
  const media = await planned(file);
  const picture = pictureSpan(file);
  assert.ok(Math.abs(media.startTimeSeconds + media.durationSeconds - picture.end) < 1 / FPS,
    `the plan ends at ${media.startTimeSeconds + media.durationSeconds}s, the last picture at ${picture.end}s`);
  const bytes = await fs.readFile(file);
  const orchestrator = new ContainerOrchestrator();
  const params = { sourceKey: "generated", fileIndex: 0, fileSize: bytes.length, label: "film.vob",
    readRange: async (start, end) => bytes.subarray(start, end + 1) };
  const video = (await orchestrator.inspect(params, "tracks")).value.find(track => track.type === "video");
  const keyframes = (await orchestrator.inspect(params, "packets")).value.keyframesOf(video.trackNumber);
  const theirs = pictures(file).filter(([, keyframe]) => keyframe).map(([time]) => time).sort((left, right) => left - right);
  assert.ok(theirs.length > 2, "the file has several groups of pictures");
  assert.equal(keyframes.length, theirs.length);
  keyframes.forEach((time, at) => assert.ok(Math.abs(time - theirs[at]) < 1e-6, `keyframe ${at}: ${time}s against FFmpeg's ${theirs[at]}s`));
}));
