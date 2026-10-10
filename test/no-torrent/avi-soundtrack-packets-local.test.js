import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import ffmpegBin from "ffmpeg-static";
import { AviContainer } from "../../services/media/container/AviContainer.js";
import { SegmentInputs } from "../../services/media/SegmentInputs.js";
import { admitInput, writeAdmittedInput } from "../../services/encode/AdmittedInput.js";
import { buildAdmittedCommand } from "../../services/encode/admitted-command.js";
import { mpegtsFormat } from "../../services/encode/segment-formats/mpegts.js";
import { fmp4Format } from "../../services/encode/segment-formats/fmp4.js";
import { judgePiece } from "../../services/encode/piece-completeness.js";
import { softwareDescriptor } from "../../services/encode/hwaccel.js";

// Generated local files only; no torrent, no HTTP.
//
// The soundtrack of an indexed AVI is read from its own packets, which the
// index states with FFmpeg's time for each, instead of from the original file,
// whose interleaved picture bytes a soundtrack run had to copy as well: field
// 2026-10-10, 2.3 GB copied for a soundtrack of 0.19 GB (torrent-tv/meta#166).
// What must hold is that the sound lands where FFmpeg's own reading of the
// file puts it: the piece's samples, decoded, are the file's samples at the
// time the piece states, so the sound stays with the picture.

const RATE = 48000;
// A tone whose pitch changes every moment, so a piece placed a frame early or
// late decodes to other samples than the file has at the time it states.
const CHIRP = "aevalsrc=0.5*sin(2*PI*(200*t+20*t*t)):s=48000";

function run(binary, args, input) {
  const result = spawnSync(binary, args, { windowsHide: true, maxBuffer: 512 * 1024 * 1024, input });
  assert.equal(result.status, 0, `${result.error ?? ""} ${result.signal ?? ""} ${result.stderr}`);
  return result.stdout;
}

function samples(file) {
  const raw = run(ffmpegBin, ["-v", "error", "-i", file, "-map", "0:a:0", "-ac", "1", "-ar", String(RATE), "-f", "s16le", "-"]);
  return new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2));
}

// FFmpeg's MPEG-TS muxer delays every timestamp by twice its default mux
// delay of 0.7 s; the page's player takes the first piece's time as its start.
const TS_DELAY = 1.4;

/** The time a piece states for its first sound, on the film's clock. */
function startOf(file) {
  return packetsOf(file, TS_DELAY)[0].pts;
}

/** Where in the reference the produced samples fit best, searched within half a second of a guess. */
function bestFit(produced, reference, from, guess) {
  const window = Math.round(0.2 * RATE);
  const error = offset => {
    let sum = 0;
    for (let index = from; index < from + window; index++) sum += Math.abs(produced[index] - reference[offset + index]);
    return sum;
  };
  let best = guess, least = Infinity;
  for (let offset = guess - RATE / 2; offset <= guess + RATE / 2; offset += 48) {
    const value = error(offset);
    if (value < least) { least = value; best = offset; }
  }
  for (let offset = best - 48; offset <= best + 48; offset++) {
    const value = error(offset);
    if (value < least) { least = value; best = offset; }
  }
  return best;
}

async function inDirectory(body) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ttv166-avi-sound-"));
  try {
    await body(directory);
  } finally {
    const absolute = path.resolve(directory);
    assert.ok(absolute.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) && path.basename(absolute).startsWith("ttv166-avi-sound-"));
    await fs.rm(absolute, { recursive: true, force: true });
  }
}

/**
 * The audio packets FFmpeg reads from `file`, in its own `framemd5` listing:
 * time on the film's clock, duration and content.
 */
function packetsOf(file, shift = 0) {
  const lines = String(run(ffmpegBin, ["-v", "error", "-copyts", "-i", file, "-map", "0:a:0", "-c", "copy", "-f", "framemd5", "-"]))
    .split(/\r?\n/);
  const base = lines.find(line => line.startsWith("#tb 0:"))?.match(/(\d+)\/(\d+)/);
  assert.ok(base, "the listing states its time base");
  const unit = Number(base[1]) / Number(base[2]);
  return lines.filter(line => line && !line.startsWith("#")).map(line => line.split(",").map(field => field.trim()))
    .map(([, , pts, duration, , hash]) => ({ pts: Number(pts) * unit - shift, duration: Number(duration) * unit, hash }));
}

/** The soundtrack piece of `[from, to)` made from the sound's own packets, as the proxy's packet path makes it. */
async function soundPiece(directory, bytes, grid, at, transcodeAudio, segmentFormat = mpegtsFormat) {
  const container = new AviContainer({ fileSize: bytes.length, readRange: async (start, end) => bytes.subarray(start, end + 1) });
  const tracks = (await container.readTracks()).filter(track => track.type === "audio");
  const index = await container.readPacketIndex();
  const input = new SegmentInputs({ tracks, index }).forInterval({ from: grid[at], to: grid[at + 1],
    mode: transcodeAudio ? "transcode" : "copy" });
  assert.equal(input.kind, "result", JSON.stringify(input));
  const picture = (await container.readSourceRanges({ from: grid[at], to: grid[at + 1], trackIds: [0, 1] })).ranges;
  const own = input.ranges.reduce((sum, [start, end]) => sum + end - start + 1, 0);
  const original = picture.reduce((sum, [start, end]) => sum + end - start + 1, 0);
  const admitted = await admitInput({ sources: [{ sourceKey: "local", fileIndex: 0, input }], reserve: () => () => {},
    readRanges: async (_source, ranges) => ranges.map(([start, end]) => Buffer.from(bytes.subarray(start, end + 1))) });
  const chunks = [];
  await writeAdmittedInput(admitted, new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } }));
  const command = buildAdmittedCommand({ admittedInput: admitted, timeline: { published: grid, cutGrid: "keyframe" }, output: {},
    segmentFormat, transcodeVideo: false, transcodeAudio, audioOnly: true, audioSeparate: false,
    startIndex: at, endIndex: at, videoEncoder: softwareDescriptor(), segmentDurationSec: 4 });
  const made = spawnSync(ffmpegBin, command.args, { cwd: directory, windowsHide: true, input: Buffer.concat(chunks),
    encoding: "utf8", stdio: ["pipe", "pipe", "pipe", "pipe"] });
  assert.equal(made.status, 0, made.stderr);
  admitted.release();
  const name = (await fs.readdir(directory)).find(one => one.startsWith("making-"));
  assert.ok(name, "the run published its piece");
  return { piece: path.join(directory, name), own, original };
}

// What a browser cannot play is transcoded; PCM has no MPEG-TS stream type and
// is never copied, AC-3 is copied for a browser that plays it and transcoded
// for one that does not.
for (const [name, audio, transcodeAudio, extra = []] of [
  ["constant-bitrate MP3", ["-c:a", "libmp3lame", "-b:a", "128k"], false],
  ["variable-bitrate MP3", ["-c:a", "libmp3lame", "-q:a", "4"], false],
  ["constant-bitrate MP3 stored five seconds ahead of the picture", ["-c:a", "libmp3lame", "-b:a", "128k"], false, ["-audio_preload", "5000000"]],
  ["AC-3", ["-c:a", "ac3", "-b:a", "192k"], false],
  ["AC-3", ["-c:a", "ac3", "-b:a", "192k"], true],
  ["PCM", ["-c:a", "pcm_s16le"], true],
  ["variable-bitrate MP3", ["-c:a", "libmp3lame", "-q:a", "4"], true]
]) test(`an indexed AVI's ${name} soundtrack, ${transcodeAudio ? "transcoded" : "copied"}, is read from its own packets and lands where FFmpeg puts it`, () => inDirectory(async directory => {
  const file = path.join(directory, "source.avi");
  run(ffmpegBin, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25", "-f", "lavfi", "-i", CHIRP, "-t", "60",
    "-c:v", "mpeg4", "-vtag", "XVID", "-g", "50", "-q:v", "3", ...audio, ...extra, "-f", "avi", file]);
  const bytes = await fs.readFile(file);
  const grid = [0, 4, 8, 12, 16, 20, 24, 28, 30, 34, 38, 60];
  const at = grid.indexOf(30);
  const [from, to] = [grid[at], grid[at + 1]];
  const { piece, own, original } = await soundPiece(directory, bytes, grid, at, transcodeAudio);
  assert.ok(own * 3 < original, `the sound's own bytes (${own}) are a small part of what the original path copies (${original})`);
  // The format the proxy serves by default: the same stdin, muxed to fMP4,
  // covers the interval it is published for.
  const fmp4Directory = path.join(directory, "fmp4");
  await fs.mkdir(fmp4Directory);
  const fmp4 = await soundPiece(fmp4Directory, bytes, grid, at, transcodeAudio, fmp4Format);
  const judged = judgePiece(fmp4Format, fmp4Format.readMediaRanges(await fs.readFile(fmp4.piece)), undefined,
    { from, to, requiredKinds: ["soun"] });
  assert.equal(judged.whole, true, JSON.stringify(judged));
  if (!transcodeAudio) {
    // A copy carries the file's own frames: the same content at the same time
    // FFmpeg's reading of the original file gives each of them.
    const produced = packetsOf(piece, TS_DELAY);
    const expected = packetsOf(file).filter(packet => packet.pts < to && packet.pts + packet.duration > from);
    assert.equal(produced.length, expected.length, `the piece holds ${produced.length} frames, the interval ${expected.length}`);
    produced.forEach((packet, index) => {
      assert.equal(packet.hash, expected[index].hash, `frame ${index} is the file's frame`);
      assert.ok(Math.abs(packet.pts - expected[index].pts) < 0.0005, `frame ${index} sits at ${packet.pts}s, the file puts it at ${expected[index].pts}s`);
    });
    return;
  }
  // A transcode is lossy, so its samples are not the file's; what must hold is
  // where they sit: the decoded sound fits the file's own decoding at the time
  // the piece states, within a millisecond.
  const stated = startOf(piece);
  assert.ok(stated <= from + 0.05 && stated > from - 0.1, `the piece starts at ${stated}s for an interval from ${from}s`);
  const produced = samples(piece);
  const reference = samples(file);
  const skip = Math.round(0.1 * RATE);
  const offset = Math.round(stated * RATE);
  const found = bestFit(produced, reference, skip, offset);
  assert.ok(Math.abs(found - offset) <= RATE / 1000, `the samples sit at ${found / RATE}s and the piece states ${stated}s`);
  assert.ok(produced.length > (to - from - 0.1) * RATE, `the piece holds the interval (${produced.length / RATE}s)`);
}));
