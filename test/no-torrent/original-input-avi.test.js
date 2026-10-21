import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Writable } from "node:stream";
import ffmpegBin from "ffmpeg-static";
import ffprobe from "@ffprobe-installer/ffprobe";
import { AviContainer } from "../../services/media/container/AviContainer.js";
import { ContainerOrchestrator } from "../../services/media/ContainerOrchestrator.js";
import { readPlaybackDeclarations } from "../../services/media/read-playback-declarations.js";
import { playbackDeclarations } from "../../services/media/playback-declarations.js";
import { computeCutGrid } from "../../services/encode/output/cut-grid.js";
import { mediaPlaylistText } from "../../services/encode/output/playlists.js";
import { admitOriginalInput } from "../../services/encode/OriginalInput.js";
import { buildOriginalCommand } from "../../services/encode/source-command.js";
import { handleEncodeInputGet } from "../../routes/encode-input/get.js";
import { fmp4Format } from "../../services/encode/segment-formats/fmp4.js";
import { mpegtsFormat } from "../../services/encode/segment-formats/mpegts.js";
import { directSegmentInput } from "../../services/media/direct-segment-input.js";
import { admitInput, writeAdmittedInput } from "../../services/encode/AdmittedInput.js";
import { buildAdmittedCommand } from "../../services/encode/admitted-command.js";
import { softwareDescriptor } from "../../services/encode/hwaccel.js";

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

function audioSamples(file) {
  const raw = ffmpeg(["-i", file, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "s16le", "-"]);
  return new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2));
}

async function packetPiece(directory, bytes, container, interval, track, transcodeAudio) {
  const input = await directSegmentInput(container, { interval, tracks: [track],
    mode: () => transcodeAudio ? "transcode" : "copy" }, () => {});
  assert.equal(input.kind, "result", JSON.stringify(input));
  const admitted = await admitInput({ sources: [{ sourceKey: "local", fileIndex: 0, input }], reserve: () => () => {},
    readRanges: async (_source, ranges) => ranges.map(([start, end]) => Buffer.from(bytes.subarray(start, end + 1))) });
  const chunks = [];
  await writeAdmittedInput(admitted, new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } }));
  const command = buildAdmittedCommand({ admittedInput: admitted,
    timeline: { published: Array.from({ length: 16 }, (_, index) => index * 4), cutGrid: "even" },
    output: {}, segmentFormat: fmp4Format, transcodeVideo: false, transcodeAudio, audioOnly: true, audioSeparate: false,
    startIndex: 3, endIndex: 3, videoEncoder: softwareDescriptor(), segmentDurationSec: 4 });
  const made = spawnSync(ffmpegBin, command.args, { cwd: directory, windowsHide: true, input: Buffer.concat(chunks),
    encoding: "utf8", stdio: ["pipe", "pipe", "pipe", "pipe"] });
  assert.equal(made.status, 0, made.stderr);
  admitted.release();
  const name = (await fs.readdir(directory)).find(one => one.startsWith("making-"));
  assert.ok(name, "the run published its piece");
  return { file: path.join(directory, name), input };
}

/** Split indexed AVI audio blocks and rebuild idx1 so the demuxer sees the same bytes. */
function splitAviAudioBlocks(bytes, partBytes) {
  bytes = Buffer.from(bytes);
  const children = (start, end) => {
    const found = [];
    for (let at = start; at + 8 <= end;) {
      const id = bytes.toString("ascii", at, at + 4), length = bytes.readUInt32LE(at + 4);
      const next = at + 8 + length + (length & 1);
      assert.ok(next <= end, `AVI chunk ${id} stays in its parent`);
      if (id === "LIST" && bytes.toString("ascii", at + 8, at + 12) === "rec ") found.push(...children(at + 12, at + 8 + length));
      else found.push({ id, start: at, length, data: bytes.subarray(at + 8, at + 8 + length) });
      at = next;
    }
    return found;
  };
  const rootChunks = children(12, bytes.length);
  const hdrl = rootChunks.find(chunk => chunk.id === "LIST" && bytes.toString("ascii", chunk.start + 8, chunk.start + 12) === "hdrl");
  assert.ok(hdrl, "AVI has a header list");
  const streams = children(hdrl.start + 12, hdrl.start + 8 + hdrl.length)
    .filter(chunk => chunk.id === "LIST" && bytes.toString("ascii", chunk.start + 8, chunk.start + 12) === "strl");
  const audioHeader = streams.map(chunk => children(chunk.start + 12, chunk.start + 8 + chunk.length))
    .find(chunks => chunks.some(chunk => chunk.id === "strh" && bytes.toString("ascii", chunk.start + 8, chunk.start + 12) === "auds"));
  const streamHeader = audioHeader?.find(chunk => chunk.id === "strh");
  const waveFormat = audioHeader?.find(chunk => chunk.id === "strf");
  assert.ok(streamHeader && waveFormat?.length >= 16, "AVI declares an audio stream");
  // State one AC-3 sample as 768 bytes / 1536 samples. Two 384-byte AVI
  // blocks therefore have the same presentation time and form one AC-3 frame.
  bytes.writeUInt32LE(1536, streamHeader.start + 8 + 20);
  bytes.writeUInt32LE(48000, streamHeader.start + 8 + 24);
  bytes.writeUInt32LE(768, streamHeader.start + 8 + 44);
  bytes.writeUInt16LE(768, waveFormat.start + 8 + 12);
  let moviAt = 12;
  while (moviAt + 12 <= bytes.length && !(bytes.toString("ascii", moviAt, moviAt + 4) === "LIST" &&
    bytes.toString("ascii", moviAt + 8, moviAt + 12) === "movi")) {
    const length = bytes.readUInt32LE(moviAt + 4);
    moviAt += 8 + length + (length & 1);
  }
  assert.ok(moviAt + 12 <= bytes.length, "AVI has a movi list");
  const moviTypeAt = moviAt + 8;
  const moviEnd = moviAt + 8 + bytes.readUInt32LE(moviAt + 4);
  const oldChunks = children(moviAt + 12, moviEnd);
  let indexAt = moviEnd + ((moviEnd - moviAt) & 1);
  while (indexAt + 8 <= bytes.length && bytes.toString("ascii", indexAt, indexAt + 4) !== "idx1") {
    const length = bytes.readUInt32LE(indexAt + 4);
    indexAt += 8 + length + (length & 1);
  }
  assert.equal(bytes.toString("ascii", indexAt, indexAt + 4), "idx1", "AVI has a legacy index");
  const indexLength = bytes.readUInt32LE(indexAt + 4);
  const oldIndex = bytes.subarray(indexAt + 8, indexAt + 8 + indexLength);
  assert.equal(indexLength % 16, 0, "idx1 entries are complete");
  const oldFlags = new Map();
  for (let at = 0; at < oldIndex.length; at += 16) {
    const offset = oldIndex.readUInt32LE(at + 8);
    for (const base of [moviTypeAt, 0, moviTypeAt + 4]) {
      const header = base + offset;
      const chunk = oldChunks.find(one => one.start === header);
      if (chunk) { oldFlags.set(header, oldIndex.readUInt32LE(at + 4)); break; }
    }
  }
  const rewritten = [];
  const indexEntries = [];
  let splitBlocks = 0;
  let cursor = moviTypeAt + 4;
  for (const chunk of oldChunks) {
    if (chunk.id.endsWith("wb") && chunk.length > partBytes) splitBlocks++;
    const parts = chunk.id.endsWith("wb") && chunk.length > partBytes
      ? Array.from({ length: Math.ceil(chunk.length / partBytes) }, (_, at) => chunk.data.subarray(at * partBytes, (at + 1) * partBytes))
      : [chunk.data];
    for (const data of parts) {
      const head = Buffer.alloc(8);
      head.write(chunk.id, 0, 4, "ascii");
      head.writeUInt32LE(data.length, 4);
      const pad = data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0);
      rewritten.push(head, data, pad);
      const entry = Buffer.alloc(16);
      entry.write(chunk.id, 0, 4, "ascii");
      entry.writeUInt32LE(oldFlags.get(chunk.start) ?? 0, 4);
      entry.writeUInt32LE(cursor - moviTypeAt, 8);
      entry.writeUInt32LE(data.length, 12);
      indexEntries.push(entry);
      cursor += 8 + data.length + pad.length;
    }
  }
  const moviData = Buffer.concat(rewritten);
  const movi = Buffer.alloc(12);
  movi.write("LIST", 0, 4, "ascii");
  movi.writeUInt32LE(4 + moviData.length, 4);
  movi.write("movi", 8, 4, "ascii");
  const newIndexData = Buffer.concat(indexEntries);
  const newIndex = Buffer.alloc(8);
  newIndex.write("idx1", 0, 4, "ascii");
  newIndex.writeUInt32LE(newIndexData.length, 4);
  const result = Buffer.concat([bytes.subarray(0, moviAt), movi, moviData, newIndex, newIndexData,
    bytes.subarray(indexAt + 8 + indexLength)]);
  result.writeUInt32LE(result.length - 8, 4);
  return { bytes: result, splitBlocks };
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
    reserve: async () => () => {}, readRanges: async (_source, list) => list.map(([start, end]) => bytes.subarray(start, end + 1)) });
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
  // Only a picture is read from the original file; a soundtrack alone is read
  // from its own packets (avi-soundtrack-packets-local.test.js).
  const idsOf = type => tracks.filter(track => track.type === type).map(track => track.trackNumber);
  assert.equal(await container.supportsOriginalSourceRanges({ from, to, trackIds: idsOf("video") }), true);
  assert.equal(await container.supportsOriginalSourceRanges({ from, to, trackIds: [...idsOf("video"), ...idsOf("audio")] }), true);
  if (idsOf("audio").length) assert.equal(await container.supportsOriginalSourceRanges({ from, to, trackIds: idsOf("audio") }), false);
  // Each run names its own tracks, as the proxy does; the picture run's ranges
  // must still hold what FFmpeg reads of the sound.
  const rangesOf = async type => container.readSourceRanges({ from, to,
    trackIds: tracks.filter(track => track.type === type).map(track => track.trackNumber) });
  const source = await rangesOf("video");
  assert.equal(source.kind, "result");
  const early = await container.readSourceRanges({ from: 0, to: 2, trackIds: idsOf("video") });
  assert.deepEqual(source.commonRanges, early.commonRanges, "AVI names common parts before merging with interval bytes");
  assert.notDeepEqual(source.intervalRanges, early.intervalRanges);
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

test("an indexed AVI with split AC-3 frames plays segment 3 from complete packets", () => inDirectory(async directory => {
  const file = path.join(directory, "source.avi");
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=25", "-f", "lavfi", "-i",
    "aevalsrc=0.5*sin(2*PI*(300*t+20*t*t)):s=48000", "-t", "60", "-c:v", "mpeg4", "-vtag", "XVID",
    "-g", "50", "-q:v", "5", "-c:a", "ac3", "-b:a", "192k", "-f", "avi", file]);
  const { bytes, splitBlocks } = splitAviAudioBlocks(await fs.readFile(file), 384);
  assert.ok(splitBlocks > 100, `${splitBlocks} AVI audio blocks were split inside AC-3 frames`);
  let packetBytesRead = 0;
  const container = new AviContainer({ fileSize: bytes.length, readRange: async (start, end) => {
    packetBytesRead += end - start + 1;
    return bytes.subarray(start, end + 1);
  } });
  const tracks = await container.readTracks();
  const audio = tracks.filter(track => track.type === "audio");
  assert.equal(audio.length, 1);
  assert.equal(audio[0].codecId, "ac3");
  const interval = { from: 12, to: 16, trackIds: [audio[0].trackNumber] };
  const payloadReadsStart = packetBytesRead;
  const transcoded = await packetPiece(directory, bytes, container, interval, audio[0], true);
  assert.ok(packetBytesRead - payloadReadsStart < 512 * 1024,
    `the interval reads ${(packetBytesRead - payloadReadsStart)} bytes, below the 512 KiB limit`);
  const transcodedSamples = audioSamples(transcoded.file);
  assert.ok(transcodedSamples.length >= 3.98 * 48000,
    `AAC output contains ${(transcodedSamples.length / 48000).toFixed(3)} seconds for the four-second interval`);
  const packetLengths = transcoded.input.tracks[0].packets.map(packet =>
    packet.ranges.reduce((sum, [start, end]) => sum + end - start + 1, 0));
  assert.ok(packetLengths.length > 100 && packetLengths.every(length => length === 768),
    "the interval contains complete 768-byte AC-3 frames assembled from both AVI blocks");
  const copied = await packetPiece(directory, bytes, container, interval, audio[0], false);
  const copiedSamples = audioSamples(copied.file);
  assert.ok(copiedSamples.length >= 3.98 * 48000,
    `copied AC-3 output contains ${(copiedSamples.length / 48000).toFixed(3)} seconds for the four-second interval`);
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
  // FFmpeg reads the first RIFF's `idx1` only when no OpenDML index loads, and
  // so does the container: the chunk after the first `movi` lies where the
  // first RIFF ends, a piece of its own off a cold swarm (torrent-tv/meta#178).
  const movi = bytes.indexOf(Buffer.from("movi")) - 8;
  const moviSize = bytes.readUInt32LE(movi + 4);
  const afterMovi = movi + 8 + moviSize + (moviSize & 1);
  assert.equal(bytes.toString("ascii", afterMovi, afterMovi + 4), "idx1", "the legacy index follows the first movi");
  const reads = [];
  const recording = new AviContainer({ fileSize: bytes.length, readRange: async (start, end) => {
    reads.push([start, end]);
    return bytes.subarray(start, end + 1);
  } });
  assert.ok((await recording.parseKeyframeIndex()).times.length > 0);
  assert.equal((await recording.readSourceRanges({ from: 30, to: 32 })).kind, "result");
  assert.ok(!reads.some(([start, end]) => start <= afterMovi + 7 && afterMovi <= end), "the chunk after the first movi is not read");
  await checkAvi(directory, file, { duration: 100, audio: true, timeBase: 1 / FPS, copyable: true });

  // The plan lasts as long as the film, not as its first RIFF: OpenDML has the
  // main header count the first RIFF's frames only, and a two-hour film lost
  // its last fourteen minutes to it (torrent-tv/meta#178). Read the way the
  // plan reads it, cut and listed the way the player is given it.
  const declarations = await readPlaybackDeclarations(new ContainerOrchestrator(), { sourceKey: "generated", fileIndex: 0,
    fileSize: bytes.length, label: "opendml.avi", packetInterval: { from: 0, to: 1 },
    readRange: async (start, end) => bytes.subarray(start, end + 1) });
  assert.equal(declarations.kind, "result");
  const length = playbackDeclarations({ ...declarations.value, fileBytes: bytes.length }).durationSeconds;
  const stated = Number(spawnSync(ffprobe.path, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
    { encoding: "utf8", windowsHide: true }).stdout);
  const firstRiff = bytes.readUInt32LE(32) * bytes.readUInt32LE(48) / 1e6;
  assert.ok(firstRiff < stated - 1, `the main header counts the first RIFF only: ${firstRiff}s of ${stated}s`);
  assert.ok(Math.abs(length - stated) < 1 / FPS, `the plan lasts ${length}s, FFmpeg reads ${stated}s`);
  const keyframes = (await containerOf(bytes).parseKeyframeIndex()).times;
  const { boundaries } = computeCutGrid({ useKeyframeGrid: true, durationSeconds: length, segDur: 4, keyframeTimes: keyframes, startTime: 0 });
  const listed = mediaPlaylistText({ boundaries, segmentFormat: fmp4Format }).split("\n")
    .filter(line => line.startsWith("#EXTINF:")).reduce((sum, line) => sum + Number(line.slice(8, -1)), 0);
  assert.ok(Math.abs(listed - length) < 1e-3, `the playlist lists ${listed}s of ${length}s`);

  // And the last segment is made from the second RIFF's named bytes.
  const last = boundaries.length - 2;
  const from = boundaries[last], to = boundaries[last + 1];
  assert.ok(from > firstRiff, "the last segment lies in the second RIFF");
  const container = containerOf(bytes);
  const video = (await container.readTracks()).filter(track => track.type === "video").map(track => track.trackNumber);
  const source = await container.readSourceRanges({ from, to, trackIds: video });
  assert.equal(source.kind, "result");
  const end = await runOver(directory, { bytes, ranges: source.ranges, from, command: {
    startIndex: last, timeline: { published: boundaries, cutGrid: "keyframe" }, keyframes: { times: keyframes },
    transcodeVideo: true, selections: [{ track: { type: "video", reorderDepth: 0 }, index: 0 }] } });
  const expected = pictures(file, 1 / FPS).filter(([pts]) => pts >= from - 1e-6 && pts < to - 1e-6).map(([, hash]) => hash);
  assert.ok(expected.length > 0);
  assert.deepEqual(pictures(end.piece, 1 / 12800).map(([, hash]) => hash), expected, "the last segment holds the film's last pictures");
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

/**
 * The audio elementary stream of an MPEG-TS piece, from its PES payloads
 * (ISO/IEC 13818-1 2.4.3.2, 2.4.3.6), so the sound can be decoded without
 * FFmpeg's MPEG-TS demuxer, which the CI build cannot run (see `tsTimes`).
 */
async function tsAudioStream(piece) {
  const bytes = await fs.readFile(piece);
  const parts = [];
  let audioPid = null;
  for (let at = 0; at + 188 <= bytes.length; at += 188) {
    const pid = ((bytes[at + 1] & 0x1f) << 8) | bytes[at + 2];
    if (!(bytes[at + 3] & 0x10)) continue;
    let payload = at + 4;
    if (bytes[at + 3] & 0x20) payload += 1 + bytes[at + 4];
    const starts = (bytes[at + 1] & 0x40) && bytes[payload] === 0 && bytes[payload + 1] === 0 && bytes[payload + 2] === 1;
    if (starts && bytes[payload + 3] >= 0xc0 && bytes[payload + 3] <= 0xdf) audioPid ??= pid;
    if (pid !== audioPid) continue;
    parts.push(bytes.subarray(starts ? payload + 9 + bytes[payload + 8] : payload, at + 188));
  }
  return Buffer.concat(parts);
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
  const stream = path.join(directory, "piece.mp3");
  await fs.writeFile(stream, await tsAudioStream(piece));
  assert.ok(loudness(stream, 3.1, 3.9) > 0.2, "the loud second 31-32 s is the piece's last second");
  assert.ok(loudness(stream, 0.05, 2.9) < 0.02, "and nothing loud before it");
}));
