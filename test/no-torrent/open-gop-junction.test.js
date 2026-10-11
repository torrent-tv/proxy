/**
 * @file Where two runs of a copied open-GOP picture meet, the viewer's picture
 * has no hole.
 *
 * Field 2026-10-11, torrent-tv/meta#178: at 74.283 s of a 1036p HEVC film the
 * browser's buffer had a hole of 0.292 s, the leading pictures of the keyframe
 * there. A run that starts at a keyframe cannot make that keyframe's leading
 * pictures — they reference the group before it — while the run before it
 * makes them in the file it closes past its last cut. The run that starts at
 * the keyframe takes them from there.
 */

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
import { judgeNeighbors, judgePiece, leadingSecondsOf } from "../../services/encode/piece-completeness.js";
import { leadingPictures, presentationSegment } from "../../services/encode/segment-formats/presentation-segment.js";

const cut = 10.01;
const grid = [0, cut, cut * 2, cut * 3];

/** One original-source run over one piece, as the proxy commands it; its piece and the file past its cut. */
async function runOnePiece(directory, file, bytes, startIndex, tag) {
  const input = await admitOriginalInput({ sources: [{ sourceKey: "generated", fileIndex: 0, timeShiftSeconds: 0,
    input: { original: true, from: grid[startIndex], fileLength: bytes.length, ranges: [[0, bytes.length - 1]],
      selections: [{ track: { type: "video", reorderDepth: 4 }, index: 0 }] } }],
  reserve: async () => () => {}, readRanges: async () => [bytes] });
  input.runTag = tag;
  const server = http.createServer((req, res) => {
    req.params = { token: "1", fileIndex: "0" }; req.raw = req;
    const reply = { raw: res, hijack() { return this; }, code(status) { res.statusCode = status; return this; },
      header(name, value) { res.setHeader(name, value); return this; },
      send(body) { res.end(Buffer.isBuffer(body) ? body : body ? JSON.stringify(body) : undefined); return this; } };
    handleEncodeInputGet(req, reply, { inputOf: () => input });
  });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const command = buildOriginalCommand({ admittedInput: input, inputToken: 1,
      baseUrl: `http://127.0.0.1:${server.address().port}`, startIndex, endIndex: startIndex,
      timeline: { published: grid, cutGrid: "keyframe", sourceStartOf: index => grid[index] },
      keyframes: { times: grid }, audioOnly: false, audioSeparate: true,
      transcodeAudio: false, transcodeVideo: false, output: {}, videoEncoder: {},
      segmentFormat: fmp4Format, segmentDurationSec: cut });
    const child = spawn(ffmpegBin, command.args, { cwd: directory, stdio: ["ignore", "ignore", "pipe", "ignore"], windowsHide: true });
    let diagnostics = "";
    child.stderr.on("data", chunk => diagnostics += chunk);
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    assert.equal(code, 0, diagnostics);
    const named = index => path.join(directory, fmp4Format.makingFileNameTemplate(tag).replace("%05d", String(index).padStart(5, "0")));
    return { piece: await fs.readFile(named(startIndex)), past: await fs.readFile(named(startIndex + 1)) };
  } finally {
    await new Promise(resolve => server.close(resolve));
    input.release();
  }
}

/** The pictures of a file over a stretch, one hash each, in presentation order. */
function hashes(source, from, until) {
  const decoded = spawnSync(ffmpegBin, ["-v", "error", "-copyts", "-i", source, "-an",
    "-vf", `trim=start=${from}:end=${until}`, "-fps_mode", "passthrough", "-enc_time_base", "1:1000000", "-f", "framemd5", "-"],
  { encoding: "utf8", windowsHide: true });
  assert.equal(decoded.status, 0, decoded.stderr);
  return decoded.stdout.split(/\r?\n/).filter(line => line && !line.startsWith("#")).map(line => line.split(",").at(-1).trim());
}

// Generated ordinary media and a loopback HTTP server only; no torrent imports.
test("a run starting at an open-GOP keyframe takes its leading pictures from the run before, and the picture has no hole", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ttv178-open-gop-"));
  try {
    const file = path.join(directory, "input.mkv");
    const generated = spawnSync(ffmpegBin, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=24000/1001",
      "-t", String(cut * 3 + 0.2), "-c:v", "libx265", "-bf", "4", "-g", "240",
      "-x265-params", "pools=1:frame-threads=1:scenecut=0:open-gop=1:log-level=error", file], { encoding: "utf8", windowsHide: true });
    assert.equal(generated.status, 0, generated.stderr);
    const bytes = await fs.readFile(file);
    const before = await runOnePiece(directory, file, bytes, 0, "a");
    const after = await runOnePiece(directory, file, bytes, 1, "b");

    // The run before made the leading pictures of keyframe 1 past its cut.
    const leading = leadingPictures(before.past);
    assert.ok(leading, "the keyframe at the junction has leading pictures");
    const lead = leadingSecondsOf(fmp4Format.readMediaRanges(before.past));
    assert.ok(lead > 0);

    // Piece 0 ends before its cut by exactly that span.
    const first = fmp4Format.readMediaRanges(before.piece);
    first.nextLeadingSeconds = lead;
    assert.equal(judgePiece(fmp4Format, first, undefined, { from: grid[0], to: grid[1], requiredKinds: ["vide"] }).whole, true);

    // Piece 1 starts at its keyframe with those pictures before it.
    const spliced = presentationSegment(after.piece, null, { from: grid[1], to: grid[2] }, { firstOfRun: true, leading });
    const second = fmp4Format.readMediaRanges(spliced);
    second.nextLeadingSeconds = leadingSecondsOf(fmp4Format.readMediaRanges(after.past));
    assert.equal(judgePiece(fmp4Format, second, undefined, { from: grid[1], to: grid[2], requiredKinds: ["vide"] }).whole, true);
    assert.equal(judgeNeighbors(first, second).whole, true, "the pieces meet without a gap");

    // Served as the browser gets them — one init, the two pieces in order —
    // every picture up to the next keyframe's leading pictures decodes as the
    // original does.
    const served = async (name, secondPiece) => {
      const init = fmp4Format.prepareSharedInit(fmp4Format.extractInit(before.piece));
      const target = path.join(directory, name);
      await fs.writeFile(target, Buffer.concat([init,
        fmp4Format.prepareSegmentBytes(fmp4Format.stripInit(before.piece), { initBytes: init, startSeconds: grid[0], rawBytes: before.piece }),
        fmp4Format.prepareSegmentBytes(fmp4Format.stripInit(secondPiece), { initBytes: init, startSeconds: grid[1], rawBytes: secondPiece })]));
      return target;
    };
    const until = grid[2] - second.nextLeadingSeconds - 0.001;
    const expected = hashes(file, 0, until);
    assert.deepEqual(hashes(await served("joined.mp4", spliced), 0, until), expected,
      "every picture across the junction decodes as the original does");

    // Without them the junction lacks exactly the leading pictures.
    const removed = presentationSegment(after.piece, null, { from: grid[1], to: grid[2] }, { firstOfRun: true });
    const holed = hashes(await served("holed.mp4", removed), 0, until);
    const frames = Math.round(lead * 24000 / 1001);
    assert.equal(holed.length, expected.length - frames, `the run alone leaves out ${frames} leading pictures`);
  } finally {
    const absolute = path.resolve(directory), temporary = path.resolve(os.tmpdir());
    assert.ok(absolute.startsWith(`${temporary}${path.sep}`) && path.basename(absolute).startsWith("ttv178-open-gop-"));
    await fs.rm(absolute, { recursive: true, force: true });
  }
});
