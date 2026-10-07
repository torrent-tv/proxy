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
import { judgePiece } from "../../services/encode/piece-completeness.js";

// Generated ordinary media and a loopback HTTP server only; no torrent imports.
for (const [bFrames, startIndex, videoIndex = 0, sourceStart = 0] of [[2, 0], [2, 1], [0, 1], [2, 1, 1], [2, 1, 0, 10]]) test(`original video ${videoIndex} preserves interval ${startIndex} with ${bFrames} B-pictures and source start ${sourceStart}`, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ttv95-original-input-"));
  let input, server;
  try {
    const file = path.join(directory, "input.mkv");
    const generated = spawnSync(ffmpegBin, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=25",
      ...(videoIndex ? ["-f", "lavfi", "-i", "testsrc2=size=32x32:rate=25", "-map", "0:v", "-map", "1:v"] : []),
      "-t", "4.2", "-c:v", "libx264", "-bf", String(bFrames), "-g", "50", "-output_ts_offset", String(sourceStart), file], { encoding: "utf8", windowsHide: true });
    assert.equal(generated.status, 0, generated.stderr);
    const bytes = await fs.readFile(file);
    input = await admitOriginalInput({ sources: [{ sourceKey: "generated", fileIndex: 0, timeShiftSeconds: sourceStart,
      input: { original: true, from: sourceStart + startIndex * 2, fileLength: bytes.length, ranges: [[0, bytes.length - 1]],
        selections: [{ track: { type: "video", reorderDepth: bFrames }, index: videoIndex }] } }],
      reserve: async () => () => {}, readRanges: async () => [bytes] });
    input.runTag = "zero";
    server = http.createServer((req, res) => {
      req.params = { token: "1", fileIndex: "0" }; req.raw = req;
      const reply = { raw: res, hijack() { return this; }, code(status) { res.statusCode = status; return this; },
        header(name, value) { res.setHeader(name, value); return this; },
        send(body) { res.end(Buffer.isBuffer(body) ? body : body ? JSON.stringify(body) : undefined); return this; } };
      handleEncodeInputGet(req, reply, { inputOf: () => input });
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const command = buildOriginalCommand({ admittedInput: input, inputToken: 1,
      baseUrl: `http://127.0.0.1:${server.address().port}`, startIndex,
      timeline: { published: [0, 2, 4], cutGrid: "keyframe", sourceStartOf: () => startIndex * 2 },
      keyframes: { times: [0, 2, 4].map(time => time + sourceStart) }, audioOnly: false, audioSeparate: true,
      transcodeAudio: false, transcodeVideo: false, output: {}, videoEncoder: {},
      segmentFormat: fmp4Format, segmentDurationSec: 2 });
    const child = spawn(ffmpegBin, command.args, { cwd: directory, stdio: ["ignore", "ignore", "pipe", "ignore"], windowsHide: true });
    let diagnostics = "";
    child.stderr.on("data", chunk => diagnostics += chunk);
    const timeout = setTimeout(() => child.kill(), 30000);
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    clearTimeout(timeout);
    assert.equal(code, 0, diagnostics);
    assert.equal(diagnostics.trim(), "");
    const raw = await fs.readFile(path.join(directory, `making-zero-${String(startIndex).padStart(5, "0")}.mp4`));
    const coverage = fmp4Format.readMediaRanges(raw);
    assert.deepEqual(fmp4Format.initVideoSize(fmp4Format.extractInit(raw)), { width: videoIndex ? 32 : 64, height: videoIndex ? 32 : 64 });
    assert.equal(judgePiece(fmp4Format, coverage, 1.95, { from: startIndex * 2, to: (startIndex + 1) * 2, requiredKinds: ["vide"] }).whole, true);
    assert.equal(coverage.tracks[0].ranges[0].start, BigInt(startIndex * 2) * coverage.tracks[0].timescale);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    input?.release();
    const absolute = path.resolve(directory), temporary = path.resolve(os.tmpdir());
    assert.ok(absolute.startsWith(`${temporary}${path.sep}`) && path.basename(absolute).startsWith("ttv95-original-input-"));
    await fs.rm(absolute, { recursive: true, force: true });
  }
});
