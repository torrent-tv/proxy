import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import ffmpegBin from "ffmpeg-static";
import { admitOriginalInput } from "../../services/encode/OriginalInput.js";
import { buildOriginalCommand } from "../../services/encode/source-command.js";
import { handleEncodeInputGet } from "../../routes/encode-input/get.js";
import { fmp4Format } from "../../services/encode/segment-formats/fmp4.js";

// Generated ordinary media and a loopback HTTP server only; no torrent imports.
//
// Every file here starts after zero on its own clock, and the run asks for the
// published interval 2-4 s. The picture is checked by its decoded frames, the
// sound by where its one loud second falls: a seek on the wrong clock lands
// the run elsewhere in the film while its timestamps can still look right.

const FPS = 25;
const LOUD = "if(between(t\\,2\\,3)\\,0.5*sin(2*PI*1000*t)\\,0)";

function ffmpeg(args) {
  const result = spawnSync(ffmpegBin, ["-v", "error", ...args], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(result.status, 0, String(result.stderr));
  return result.stdout;
}

function frameHashes(file) {
  return String(ffmpeg(["-i", file, "-map", "0:v:0", "-pix_fmt", "yuv420p", "-f", "framemd5", "-"]))
    .split("\n").filter(line => line && !line.startsWith("#")).map(line => line.split(",").at(-1).trim());
}

/** Root mean square of the decoded sound in [from, to) seconds of the file. */
function loudness(file, from, to) {
  const raw = ffmpeg(["-i", file, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "s16le", "-"]);
  const samples = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2));
  let sum = 0, count = 0;
  for (let index = Math.floor(from * 48000); index < Math.min(samples.length, Math.floor(to * 48000)); index += 1) {
    sum += samples[index] ** 2; count += 1;
  }
  return count ? Math.sqrt(sum / count) / 32768 : 0;
}

const losslessEncoder = {
  buildVideoArgs: () => ["-c:v", "libx264", "-qp", "0", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-bf", "0"]
};

async function runOriginal(directory, { files, command }) {
  const contents = await Promise.all(files.map(item => fs.readFile(item.file)));
  const input = await admitOriginalInput({
    sources: files.map((item, fileIndex) => ({ sourceKey: "generated", fileIndex, timeShiftSeconds: item.start,
      input: { original: true, from: item.start + 2, fileLength: contents[fileIndex].length,
        ranges: [[0, contents[fileIndex].length - 1]], selections: item.selections } })),
    reserve: async () => () => {}, readRanges: async source => [contents[source.fileIndex]] });
  input.runTag = "start";
  const server = http.createServer((req, res) => {
    const [, token, fileIndex] = req.url.split("/").filter(Boolean);
    req.params = { token, fileIndex }; req.raw = req;
    const reply = { raw: res, hijack() { return this; }, code(status) { res.statusCode = status; return this; },
      header(name, value) { res.setHeader(name, value); return this; },
      send(body) { res.end(Buffer.isBuffer(body) ? body : body ? JSON.stringify(body) : undefined); return this; } };
    handleEncodeInputGet(req, reply, { inputOf: () => input });
  });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const { args } = buildOriginalCommand({ admittedInput: input, inputToken: 1,
      baseUrl: `http://127.0.0.1:${server.address().port}`, startIndex: 1,
      transcodeAudio: false, transcodeVideo: false, audioOnly: false, audioSeparate: false,
      output: {}, videoEncoder: losslessEncoder, segmentFormat: fmp4Format, segmentDurationSec: 2, ...command,
      timeline: { published: [0, 2, 4, 6], ...command.timeline } });
    const child = spawn(ffmpegBin, args, { cwd: directory, stdio: ["ignore", "ignore", "pipe", "ignore"], windowsHide: true });
    let diagnostics = "";
    child.stderr.on("data", chunk => diagnostics += chunk);
    const timeout = setTimeout(() => child.kill(), 60000);
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    clearTimeout(timeout);
    assert.equal(code, 0, `${diagnostics}\n${args.join(" ")}`);
    const piece = path.join(directory, "making-start-00001.mp4");
    const coverage = fmp4Format.readMediaRanges(await fs.readFile(piece));
    return { piece, coverage, args };
  } finally {
    await new Promise(resolve => server.close(resolve));
    input.release();
  }
}

async function inDirectory(body) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ttv95-source-start-"));
  try {
    await body(directory);
  } finally {
    const absolute = path.resolve(directory), temporary = path.resolve(os.tmpdir());
    assert.ok(absolute.startsWith(`${temporary}${path.sep}`) && path.basename(absolute).startsWith("ttv95-source-start-"));
    await fs.rm(absolute, { recursive: true, force: true });
  }
}

/** Six seconds of picture and sound, starting at `start` on the file's clock. */
function generate(file, start, { video = true, audio = true, codec = ["-c:v", "libx264", "-qp", "0", "-bf", "2", "-g", String(FPS)] } = {}) {
  ffmpeg([
    ...(video ? ["-f", "lavfi", "-i", `testsrc2=size=64x64:rate=${FPS}`] : []),
    ...(audio ? ["-f", "lavfi", "-i", `aevalsrc=${LOUD}:s=48000`] : []),
    "-t", "6", ...(video ? [...codec, "-pix_fmt", "yuv420p"] : []), ...(audio ? ["-c:a", "aac", "-b:a", "128k"] : []),
    "-output_ts_offset", String(start), file]);
  return { keyframes: { times: Array.from({ length: 6 }, (_, second) => start + second) } };
}

function assertPicture(piece, coverage, source) {
  const expected = frameHashes(source).slice(2 * FPS, 4 * FPS);
  const produced = frameHashes(piece);
  assert.equal(produced.length, expected.length, "the piece holds the whole interval and nothing past it");
  assert.equal(produced[0], expected[0], "the first frame is the one at the published start");
  assert.deepEqual(produced, expected);
  const video = coverage.tracks.find(track => track.kind === "vide") ?? coverage.tracks[0];
  assert.equal(Number(video.ranges[0].start) / Number(video.timescale), 2);
}

function assertSound(piece, coverage) {
  assert.ok(loudness(piece, 0.1, 0.9) > 0.2, "the loud second begins with the interval");
  assert.ok(loudness(piece, 1.1, 1.9) < 0.02, "and ends one second into it");
  const audio = coverage.tracks.find(track => track.kind === "soun");
  if (audio) assert.ok(Math.abs(Number(audio.ranges[0].start) / Number(audio.timescale) - 2) < 0.03);
}

for (const start of [0, 1.5]) {
  test(`a copied picture on its keyframe grid starts at the published time when the file starts at ${start} s`, () => inDirectory(async directory => {
    const file = path.join(directory, "input.mkv");
    const { keyframes } = generate(file, start, { audio: false });
    const { piece, coverage } = await runOriginal(directory, { files: [{ file, start,
      selections: [{ track: { type: "video", reorderDepth: 2 }, index: 0 }] }],
    command: { keyframes, timeline: { cutGrid: "keyframe" }, audioSeparate: true } });
    assertPicture(piece, coverage, file);
  }));

  for (const grid of [undefined, "keyframe"]) {
    test(`a transcoded picture cut on ${grid ?? "an even"} grid starts at the published time when the file starts at ${start} s`, () => inDirectory(async directory => {
      const file = path.join(directory, "input.mkv");
      const { keyframes } = generate(file, start, { audio: false });
      const { piece, coverage, args } = await runOriginal(directory, { files: [{ file, start,
        selections: [{ track: { type: "video", reorderDepth: 2 }, index: 0 }] }],
      // On the even grid only every other keyframe is listed, so the run seeks
      // a second early and decodes up to the interval on the same clock.
      command: { keyframes: grid ? keyframes : { times: keyframes.times.filter((_, second) => second % 2 === 1) },
        timeline: { cutGrid: grid }, transcodeVideo: true, audioSeparate: true } });
      assert.equal(args.filter(arg => arg === "-ss").length, grid ? 1 : 2, "the even grid seeks to an earlier keyframe, then skips");
      assert.ok(!args.includes("-to"), "a transcoded run states its end as a length");
      assertPicture(piece, coverage, file);
    }));
  }

  for (const [grid, transcodeAudio] of [["keyframe", false], ["keyframe", true], [undefined, false], [undefined, true]]) {
    test(`a soundtrack output on ${grid ?? "an even"} grid ${transcodeAudio ? "transcoded" : "copied"} hears the published interval when the file starts at ${start} s`, () => inDirectory(async directory => {
      const file = path.join(directory, "input.mkv");
      const { keyframes } = generate(file, start);
      const { piece, coverage } = await runOriginal(directory, { files: [{ file, start,
        selections: [{ track: { type: "audio" }, index: 0 }] }],
      command: { keyframes, timeline: { cutGrid: grid }, audioOnly: true, transcodeAudio, audioSourceTrackIndex: 0 } });
      assertSound(piece, coverage);
    }));
  }

  for (const transcodeVideo of [false, true]) {
    test(`a soundtrack in its own file stays with a ${transcodeVideo ? "transcoded" : "copied"} picture when the picture starts at ${start} s`, () => inDirectory(async directory => {
      const picture = path.join(directory, "picture.mkv"), sound = path.join(directory, "sound.mka");
      const { keyframes } = generate(picture, start, { audio: false });
      generate(sound, start + 0.5, { video: false });
      const { piece, coverage } = await runOriginal(directory, { files: [
        { file: picture, start, selections: [{ track: { type: "video", reorderDepth: 2 }, index: 0 }] },
        { file: sound, start: start + 0.5, selections: [{ track: { type: "audio" }, index: 0 }] }],
      command: { keyframes, timeline: transcodeVideo ? {} : { cutGrid: "keyframe" }, transcodeVideo, transcodeAudio: true,
        audioSourceTrackIndex: 0 } });
      assertPicture(piece, coverage, picture);
      assertSound(piece, coverage);
    }));
  }
}
