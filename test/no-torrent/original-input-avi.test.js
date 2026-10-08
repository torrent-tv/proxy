import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import ffmpegBin from "ffmpeg-static";
import { AviContainer } from "../../services/media/container/AviContainer.js";
import { admitOriginalInput } from "../../services/encode/OriginalInput.js";
import { buildOriginalCommand } from "../../services/encode/source-command.js";
import { handleEncodeInputGet } from "../../routes/encode-input/get.js";
import { fmp4Format } from "../../services/encode/segment-formats/fmp4.js";

// Generated ordinary media and a loopback HTTP server only; no torrent imports.
//
// An AVI plays from the original file the way Cue-backed Matroska does: the
// container names, from the index alone, the bytes a run needs, and the input
// route answers those bytes and refuses every other one. The picture is
// compared frame by frame with the source over the same presentation times;
// the sound by where its one loud second falls (torrent-tv/meta#151).

const FPS = 25;
const LOUD = "if(between(t\\,31\\,32)\\,0.5*sin(2*PI*1000*t)\\,0)";

function ffmpeg(args) {
  const result = spawnSync(ffmpegBin, ["-v", "error", ...args], { windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  assert.equal(result.status, 0, String(result.stderr));
  return result.stdout;
}

const lines = text => String(text).split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("#"));

/** Decoded pictures as [pts in seconds, hash], in presentation order. */
function pictures(file, timeBase) {
  return lines(ffmpeg(["-i", file, "-map", "0:v:0", "-pix_fmt", "yuv420p", "-f", "framemd5", "-"]))
    .map(line => line.split(",").map(part => part.trim())).map(fields => [Number(fields[2]) * timeBase, fields.at(-1)]);
}

/** Keyframe times FFmpeg's own reading of the file gives, from a stream copy.
 * An empty chunk (a repeated frame) carries no picture and is no cut point. */
function ffmpegKeyframes(file) {
  return lines(ffmpeg(["-i", file, "-map", "0:v:0", "-c", "copy", "-f", "framecrc", "-"]))
    .map(line => line.split(",").map(part => part.trim()))
    .filter(fields => Number(fields[4]) > 0 && !fields.includes("F=0x0")).map(fields => Number(fields[1]) / FPS);
}

function loudness(file, from, to) {
  const raw = ffmpeg(["-i", file, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "s16le", "-"]);
  const samples = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2));
  let sum = 0, count = 0;
  for (let index = Math.floor(from * 48000); index < Math.min(samples.length, Math.floor(to * 48000)); index += 1) {
    sum += samples[index] ** 2; count += 1;
  }
  return count ? Math.sqrt(sum / count) / 32768 : 0;
}

async function inDirectory(body) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ttv151-avi-"));
  try {
    await body(directory);
  } finally {
    const absolute = path.resolve(directory), temporary = path.resolve(os.tmpdir());
    assert.ok(absolute.startsWith(`${temporary}${path.sep}`) && path.basename(absolute).startsWith("ttv151-avi-"));
    await fs.rm(absolute, { recursive: true, force: true });
  }
}

function containerOf(bytes) {
  return new AviContainer({ fileSize: bytes.length, readRange: async (start, end) => {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end >= bytes.length || end < start) {
      throw new RangeError(`read ${start}-${end} is outside the file`);
    }
    return bytes.subarray(start, end + 1);
  } });
}

/** Run one output over only the named ranges; the route refuses every other byte. */
async function runOver(directory, { bytes, ranges, from, command }) {
  const input = await admitOriginalInput({
    sources: [{ sourceKey: "generated", fileIndex: 0, timeShiftSeconds: 0,
      input: { original: true, from, fileLength: bytes.length, ranges, selections: command.selections } }],
    reserve: async () => () => {}, readRanges: async () => ranges.map(([start, end]) => bytes.subarray(start, end + 1)) });
  input.runTag = "avi";
  const refused = [];
  const server = http.createServer((req, res) => {
    const [, token, fileIndex] = req.url.split("/").filter(Boolean);
    req.params = { token, fileIndex }; req.raw = req;
    const reply = { raw: res, hijack() { return this; }, code(status) { if (status >= 400) refused.push(req.headers.range); res.statusCode = status; return this; },
      header(name, value) { res.setHeader(name, value); return this; },
      send(body) { res.end(Buffer.isBuffer(body) ? body : body ? JSON.stringify(body) : undefined); return this; } };
    handleEncodeInputGet(req, reply, { inputOf: () => input });
  });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const { args } = buildOriginalCommand({ admittedInput: input, inputToken: 1,
      baseUrl: `http://127.0.0.1:${server.address().port}`, output: {}, segmentFormat: fmp4Format, segmentDurationSec: 2,
      videoEncoder: { buildVideoArgs: () => ["-c:v", "libx264", "-qp", "0", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-bf", "0"] },
      transcodeAudio: false, transcodeVideo: false, audioOnly: false, audioSeparate: true, ...command });
    const child = spawn(ffmpegBin, args, { cwd: directory, stdio: ["ignore", "ignore", "pipe", "ignore"], windowsHide: true });
    let diagnostics = "";
    child.stderr.on("data", chunk => { diagnostics += chunk; });
    const timeout = setTimeout(() => child.kill(), 120000);
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    clearTimeout(timeout);
    assert.deepEqual(refused, [], "FFmpeg read only bytes the container named");
    assert.equal(code, 0, `${diagnostics}\n${args.join(" ")}`);
    const piece = path.join(directory, `making-avi-${String(command.startIndex).padStart(5, "0")}.mp4`);
    return { piece, coverage: fmp4Format.readMediaRanges(await fs.readFile(piece)) };
  } finally {
    await new Promise(resolve => server.close(resolve));
    input.release();
  }
}

async function checkAvi(directory, file, { duration, audio, timeBase, copyable }) {
  const bytes = await fs.readFile(file);
  const container = containerOf(bytes);
  const table = await container.parseKeyframeIndex();
  // AVI states decoding order only, so a picture that may reorder is not copied.
  assert.equal(table.copyable, copyable);
  const keyframes = table.times;
  const expectedKeys = ffmpegKeyframes(file);
  assert.equal(keyframes.length, expectedKeys.length);
  keyframes.forEach((time, at) => assert.ok(Math.abs(time - expectedKeys[at]) < 1e-6, `keyframe ${at}: ${time} against ${expectedKeys[at]}`));
  assert.equal(await container.supportsOriginalSourceRanges(), true);
  // Cut on keyframes at least about two seconds apart, as a keyframe grid is.
  const grid = [];
  for (const time of keyframes) if (!grid.length || time - grid.at(-1) >= 1.9) grid.push(time);
  grid.push(duration);
  const at = grid.findIndex(time => time >= 30);
  const from = grid[at], to = grid[at + 1];
  const tracks = await container.readTracks();
  const trackIds = tracks.filter(track => ["video", "audio"].includes(track.type)).map(track => track.trackNumber);
  const source = await container.readSourceRanges({ from, to, trackIds });
  assert.equal(source.kind, "result");
  const named = source.ranges.reduce((sum, [start, end]) => sum + end - start + 1, 0);
  assert.ok(named < bytes.length / 2, `the run needs ${named} of ${bytes.length} bytes, not the whole film`);

  const picture = await runOver(directory, { bytes, ranges: source.ranges, from, command: {
    startIndex: at, timeline: { published: grid, cutGrid: "keyframe" }, keyframes: { times: keyframes },
    transcodeVideo: true, selections: [{ track: { type: "video", reorderDepth: 0 }, index: 0 }] } });
  const expected = pictures(file, timeBase).filter(([pts]) => pts >= from - 1e-6 && pts < to - 1e-6).map(([, hash]) => hash);
  const produced = pictures(picture.piece, 1 / 12800).map(([, hash]) => hash);
  assert.equal(produced.length, expected.length, "the piece holds the interval's pictures and nothing past it");
  assert.deepEqual(produced, expected);
  const video = picture.coverage.tracks.find(track => track.kind === "vide");
  assert.ok(Math.abs(Number(video.ranges[0].start) / Number(video.timescale) - from) < 1e-3);
  await fs.rm(picture.piece);

  if (!audio) return;
  const sound = await runOver(directory, { bytes, ranges: source.ranges, from, command: {
    startIndex: at, timeline: { published: grid, cutGrid: "keyframe" }, keyframes: { times: keyframes },
    audioOnly: true, transcodeAudio: true, audioSourceTrackIndex: 0,
    selections: [{ track: { type: "audio" }, index: 0 }] } });
  const loudFrom = Math.max(0, 31 - from), loudTo = Math.min(to, 32) - from;
  if (loudTo - loudFrom > 0.4) assert.ok(loudness(sound.piece, loudFrom + 0.1, loudTo - 0.1) > 0.2, "the loud second is where the interval puts it");
  if (loudFrom > 0.4) assert.ok(loudness(sound.piece, 0.05, loudFrom - 0.1) < 0.02, "and nothing loud before it");
}

// The layouts the reassembled-packet checks covered, now read from the file.
for (const [name, video, audio, copyable = false] of [
  ["MPEG-4 with B-pictures and MP3", ["-c:v", "mpeg4", "-vtag", "XVID", "-bf", "2", "-g", "50", "-q:v", "3"], ["-c:a", "libmp3lame", "-b:a", "128k"]],
  ["MPEG-4 and variable-bitrate MP3", ["-c:v", "mpeg4", "-vtag", "XVID", "-bf", "2", "-g", "50", "-q:v", "3"], ["-c:a", "libmp3lame", "-q:a", "4"]],
  ["H.264 with B-pictures", ["-c:v", "libx264", "-bf", "2", "-g", "50", "-preset", "ultrafast", "-x264-params", "bframes=2:b-adapt=0"], ["-c:a", "libmp3lame", "-b:a", "128k"]],
  ["H.265", ["-c:v", "libx265", "-g", "50", "-preset", "ultrafast", "-x265-params", "pools=1:frame-threads=1:b-adapt=0:log-level=error", "-vtag", "HEVC"], ["-c:a", "pcm_s16le"]],
  ["MJPEG and PCM", ["-c:v", "mjpeg", "-q:v", "5"], ["-c:a", "pcm_s16le"], true]
]) test(`an idx1 AVI, ${name}, plays its interval from the named bytes only`, () => inDirectory(async directory => {
  const file = path.join(directory, "source.avi");
  ffmpeg(["-f", "lavfi", "-i", `testsrc2=size=320x240:rate=${FPS}`, "-f", "lavfi", "-i", `aevalsrc=${LOUD}:s=48000`,
    "-t", "60", ...video, ...audio, "-f", "avi", file]);
  await checkAvi(directory, file, { duration: 60, audio: true, timeBase: 1 / FPS, copyable });
}));

test("an OpenDML AVI past one gibibyte plays its interval from the named bytes only", () => inDirectory(async directory => {
  // FFmpeg's muxer enables the OpenDML index only once a second RIFF begins.
  const file = path.join(directory, "opendml.avi");
  ffmpeg(["-f", "lavfi", "-i", `testsrc2=size=640x480:rate=${FPS}`, "-f", "lavfi", "-i", `aevalsrc=${LOUD}:s=48000`,
    "-t", "100", "-c:v", "rawvideo", "-pix_fmt", "yuv420p", "-c:a", "libmp3lame", "-b:a", "128k", "-f", "avi", file]);
  const bytes = await fs.readFile(file);
  assert.ok(bytes.includes(Buffer.from("AVIX")), "the file has a second RIFF");
  await checkAvi(directory, file, { duration: 100, audio: true, timeBase: 1 / FPS, copyable: true });
}));
