import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import ffmpegBin from "ffmpeg-static";
import ffprobe from "@ffprobe-installer/ffprobe";
import { AviContainer } from "../../services/media/container/AviContainer.js";
import { admitOriginalInput } from "../../services/encode/OriginalInput.js";
import { buildOriginalCommand } from "../../services/encode/source-command.js";
import { handleEncodeInputGet } from "../../routes/encode-input/get.js";
import { fmp4Format } from "../../services/encode/segment-formats/fmp4.js";
import { mpegtsFormat } from "../../services/encode/segment-formats/mpegts.js";

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
async function runOver(directory, { bytes, ranges, from, command, format = fmp4Format }) {
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
      baseUrl: `http://127.0.0.1:${server.address().port}`, output: {}, segmentFormat: format, segmentDurationSec: 2,
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
    const piece = path.join(directory, `making-avi-${String(command.startIndex).padStart(5, "0")}.${format === fmp4Format ? "mp4" : "ts"}`);
    return { piece, coverage: format.readMediaRanges?.(await fs.readFile(piece)) ?? null };
  } finally {
    await new Promise(resolve => server.close(resolve));
    input.release();
  }
}

async function checkAvi(directory, file, { duration, audio, timeBase, copyable, loud = true }) {
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
  // Each run names its own tracks, as the proxy does; the picture run's ranges
  // must still hold what FFmpeg reads of the sound.
  const rangesOf = async type => container.readSourceRanges({ from, to,
    trackIds: tracks.filter(track => track.type === type).map(track => track.trackNumber) });
  const source = await rangesOf("video");
  assert.equal(source.kind, "result");
  // The run holds the interval, not the film: no packet ten to twenty seconds on is named.
  const far = lines(spawnSync(ffprobe.path, ["-v", "error", "-show_entries", "packet=dts_time,pos", "-of", "csv=p=0", file],
    { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).stdout).map(line => line.split(",").map(Number))
    .filter(([time]) => time > to + 10 && time < to + 20);
  assert.ok(far.length > 0);
  for (const [time, position] of far) {
    assert.ok(!source.ranges.some(([start, end]) => position >= start && position <= end), `the packet at ${time}s is not named`);
  }

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
  const sound = await runOver(directory, { bytes, ranges: (await rangesOf("audio")).ranges, from, command: {
    startIndex: at, timeline: { published: grid, cutGrid: "keyframe" }, keyframes: { times: keyframes },
    audioOnly: true, transcodeAudio: true, audioSourceTrackIndex: 0,
    selections: [{ track: { type: "audio" }, index: 0 }] } });
  if (!loud) return;
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

test("a picture-only run holds the sound FFmpeg seeks through when the sound is stored ahead of the picture", () => inDirectory(async directory => {
  // FFmpeg seeks to the earliest position any stream gives for the keyframe
  // time (avi_read_seek, pos_min); sound stored five seconds ahead lies before
  // two keyframes of picture (field 2026-10-08, "Seek failed").
  const file = path.join(directory, "source.avi");
  ffmpeg(["-f", "lavfi", "-i", `testsrc2=size=320x240:rate=${FPS}`, "-f", "lavfi", "-i", `aevalsrc=${LOUD}:s=48000`,
    "-t", "60", "-c:v", "mpeg4", "-vtag", "XVID", "-g", "50", "-q:v", "3", "-c:a", "libmp3lame", "-b:a", "128k",
    "-audio_preload", "5000000", "-f", "avi", file]);
  await checkAvi(directory, file, { duration: 60, audio: true, timeBase: 1 / FPS, copyable: false });
}));

test("an AVI whose audio block alignment is shorter than its packets is timed by FFmpeg's clock", () => inDirectory(async directory => {
  // FFmpeg counts an audio packet as ceil(length / nBlockAlign) units (avidec.c,
  // get_duration); one packet per unit put the sound's bytes elsewhere than the
  // seek asks for (field 2026-10-08, a two-hour MP3 AVI at 384 s).
  const file = path.join(directory, "source.avi");
  ffmpeg(["-f", "lavfi", "-i", `testsrc2=size=320x240:rate=${FPS}`, "-f", "lavfi", "-i", `aevalsrc=${LOUD}:s=48000`,
    "-t", "60", "-c:v", "mpeg4", "-vtag", "XVID", "-g", "50", "-q:v", "3", "-c:a", "libmp3lame", "-b:a", "128k", "-f", "avi", file]);
  const bytes = await fs.readFile(file);
  let strf = -1, audioFormat = -1;
  while ((strf = bytes.indexOf("strf", strf + 1)) >= 0) if (bytes.readUInt16LE(strf + 8) === 0x55) audioFormat = strf + 8;
  assert.ok(audioFormat > 0, "the MP3 wave format is found");
  bytes.writeUInt16LE(128, audioFormat + 12);
  await fs.writeFile(file, bytes);
  await checkAvi(directory, file, { duration: 60, audio: true, timeBase: 1 / FPS, copyable: false, loud: false });
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


/**
 * Presentation time of every PES packet of an MPEG-TS piece, by stream kind,
 * read from the packet headers (ISO/IEC 13818-1 2.4.3.2, 2.4.3.7). Neither
 * FFmpeg nor ffprobe can read it in CI: the static 7.0.2 Linux build crashes
 * (SIGSEGV) on any MPEG-TS input, its own output included.
 */
async function tsTimes(piece) {
  const bytes = await fs.readFile(piece);
  const times = { video: [], audio: [] };
  for (let at = 0; at + 188 <= bytes.length; at += 188) {
    assert.equal(bytes[at], 0x47, "every packet starts with the sync byte");
    if (!(bytes[at + 1] & 0x40)) continue;
    let payload = at + 4;
    if (bytes[at + 3] & 0x20) payload += 1 + bytes[at + 4];
    if (bytes[payload] !== 0 || bytes[payload + 1] !== 0 || bytes[payload + 2] !== 1) continue;
    const stream = bytes[payload + 3];
    const kind = stream >= 0xe0 && stream <= 0xef ? "video" : stream >= 0xc0 && stream <= 0xdf ? "audio" : null;
    if (!kind || !(bytes[payload + 7] & 0x80)) continue;
    const field = payload + 9;
    const pts = (bytes[field] & 0x0e) * 2 ** 29 + bytes[field + 1] * 2 ** 22 + (bytes[field + 2] >> 1) * 2 ** 15 +
      bytes[field + 3] * 2 ** 7 + (bytes[field + 4] >> 1);
    times[kind].push(pts / 90000);
  }
  times.video.sort((left, right) => left - right);
  times.audio.sort((left, right) => left - right);
  return times;
}

test("an idx1 AVI with MP3 plays its interval as MPEG-TS, the container a copied MP3 needs", () => inDirectory(async directory => {
  // The page asks for MPEG-TS when MP3 is copied: MediaSource takes MP3 there and not in fMP4.
  const file = path.join(directory, "source.avi");
  ffmpeg(["-f", "lavfi", "-i", `testsrc2=size=320x240:rate=${FPS}`, "-f", "lavfi", "-i", `aevalsrc=${LOUD}:s=48000`,
    "-t", "60", "-c:v", "mpeg4", "-vtag", "XVID", "-bf", "2", "-g", "50", "-q:v", "3", "-c:a", "libmp3lame", "-b:a", "128k", "-f", "avi", file]);
  const bytes = await fs.readFile(file);
  const container = containerOf(bytes);
  const keyframes = (await container.parseKeyframeIndex()).times;
  const grid = [];
  for (const time of keyframes) if (!grid.length || time - grid.at(-1) >= 1.9) grid.push(time);
  grid.push(60);
  const at = grid.findIndex(time => time >= 30);
  const from = grid[at], to = grid[at + 1];
  const tracks = await container.readTracks();
  const rangesOf = async type => (await container.readSourceRanges({ from, to,
    trackIds: tracks.filter(track => track.type === type).map(track => track.trackNumber) })).ranges;
  const run = (command, type) => rangesOf(type).then(ranges => runOver(directory, { bytes, ranges, from, format: mpegtsFormat, command: {
    startIndex: at, timeline: { published: grid, cutGrid: "keyframe" }, keyframes: { times: keyframes }, ...command } }));
  const picture = (await tsTimes((await run({ transcodeVideo: true, selections: [{ track: { type: "video", reorderDepth: 0 }, index: 0 }] }, "video")).piece)).video;
  const expected = pictures(file, 1 / FPS).filter(([pts]) => pts >= from - 1e-6 && pts < to - 1e-6).length;
  assert.equal(picture.length, expected, "the piece holds the interval's pictures and nothing past it");
  picture.forEach((time, at) => assert.ok(Math.abs(time - picture[0] - at / FPS) < 1e-3, `picture ${at} is one frame after the last`));
  const sound = (await tsTimes((await run({ audioOnly: true, transcodeAudio: false, audioSourceTrackIndex: 0,
    selections: [{ track: { type: "audio" }, index: 0 }] }, "audio")).piece)).audio;
  assert.ok(Math.abs(sound[0] - picture[0]) < 0.03, "the copied sound starts where the picture does");
  assert.ok(Math.abs(sound.at(-1) - picture.at(-1)) < 0.1, "and ends where it ends");
}));

test("a copied AVI soundtrack on an even grid starts at its interval, not at the picture's keyframe before it", () => inDirectory(async directory => {
  // FFmpeg's input seek lands every stream on the picture's keyframe at or
  // before the time asked for, and `-accurate_seek` trims only what is decoded.
  // With a keyframe every 11 s, as in a LostFilm AVI, the copied piece 28-32 s
  // carried 22-26 s (field 2026-10-08, torrent-tv/meta#159).
  const file = path.join(directory, "source.avi");
  ffmpeg(["-f", "lavfi", "-i", `testsrc2=size=320x240:rate=${FPS}`, "-f", "lavfi", "-i", `aevalsrc=${LOUD}:s=48000`,
    "-t", "60", "-c:v", "mpeg4", "-vtag", "XVID", "-g", "275", "-q:v", "3", "-c:a", "libmp3lame", "-b:a", "128k", "-f", "avi", file]);
  const bytes = await fs.readFile(file);
  const container = containerOf(bytes);
  const grid = Array.from({ length: 16 }, (_, index) => Math.min(60, index * 4));
  const at = 7, from = grid[at], to = grid[at + 1];
  const keyframes = (await container.parseKeyframeIndex()).times;
  assert.ok(keyframes.findLast(time => time <= from) <= from - (to - from), "the keyframe before the interval lies a piece or more before it");
  const { ranges } = await container.readSourceRanges({ from, to });
  const { piece } = await runOver(directory, { bytes, ranges, from, format: mpegtsFormat, command: {
    startIndex: at, timeline: { published: grid, cutGrid: "even" }, keyframes: null,
    audioOnly: true, transcodeAudio: false, audioSourceTrackIndex: 0, selections: [{ track: { type: "audio" }, index: 0 }] } });
  const sound = (await tsTimes(piece)).audio;
  // A PES packet carries several MP3 frames, so the last one starts up to a few frames before the end.
  const span = sound.at(-1) - sound[0];
  assert.ok(span > to - from - 0.3 && span < to - from, `the piece holds the interval's length of sound, not more: ${span} s`);
  assert.ok(loudness(piece, 3.1, 3.9) > 0.2, "the loud second 31-32 s is the piece's last second");
  assert.ok(loudness(piece, 0.05, 2.9) < 0.02, "and nothing loud before it");
}));
