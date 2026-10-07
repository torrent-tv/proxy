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
import { presentationSegment } from "../../services/encode/segment-formats/presentation-segment.js";

// Generated ordinary media and a loopback HTTP server only; no torrent imports.
for (const [bFrames, startIndex, videoIndex = 0, sourceStart = 0, codec = "libx264", rate = "25", cut = 2, final = false] of [[2, 0], [2, 1], [0, 1], [2, 1, 1], [2, 1, 0, 10], [4, 0, 0, 0, "libx265", "24000/1001", 10.01], [4, 1, 0, 0, "libx265", "24000/1001", 10.01], [4, 1, 0, 0, "libx265", "24000/1001", 10.01, true]]) test(`original ${codec} video ${videoIndex} preserves interval ${startIndex} with ${bFrames} B-pictures and source start ${sourceStart}, final=${final}`, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ttv95-original-input-"));
  let input, server;
  try {
    const file = path.join(directory, "input.mkv");
    const generated = spawnSync(ffmpegBin, ["-v", "error", "-f", "lavfi", "-i", `testsrc2=size=64x64:rate=${rate}`,
      ...(videoIndex ? ["-f", "lavfi", "-i", "testsrc2=size=32x32:rate=25", "-map", "0:v", "-map", "1:v"] : []),
      "-t", String(cut * 2 + (final ? 0 : 0.2)), "-c:v", codec, "-bf", String(bFrames), "-g", String(Math.round(Number(rate.split("/")[0]) / Number(rate.split("/")[1] ?? 1) * cut)),
      ...(codec === "libx265" ? ["-x265-params", "pools=1:frame-threads=1:scenecut=0:open-gop=1:log-level=error"] : []),
      "-output_ts_offset", String(sourceStart), file], { encoding: "utf8", windowsHide: true });
    assert.equal(generated.status, 0, generated.stderr);
    const bytes = await fs.readFile(file);
    input = await admitOriginalInput({ sources: [{ sourceKey: "generated", fileIndex: 0, timeShiftSeconds: sourceStart,
      input: { original: true, from: sourceStart + startIndex * cut, fileLength: bytes.length, ranges: [[0, bytes.length - 1]],
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
      timeline: { published: [0, cut, cut * 2], cutGrid: "keyframe", sourceStartOf: () => startIndex * cut },
      keyframes: { times: [0, cut, cut * 2].map(time => time + sourceStart) }, audioOnly: false, audioSeparate: true,
      transcodeAudio: false, transcodeVideo: false, output: {}, videoEncoder: {},
      segmentFormat: fmp4Format, segmentDurationSec: cut });
    const child = spawn(ffmpegBin, command.args, { cwd: directory, stdio: ["ignore", "ignore", "pipe", "ignore"], windowsHide: true });
    let diagnostics = "";
    child.stderr.on("data", chunk => diagnostics += chunk);
    const timeout = setTimeout(() => child.kill(), 30000);
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    clearTimeout(timeout);
    assert.equal(code, 0, diagnostics);
    assert.equal(diagnostics.trim(), "");
    const raw = await fs.readFile(path.join(directory, `making-zero-${String(startIndex).padStart(5, "0")}.mp4`));
    const followingName = path.join(directory, `making-zero-${String(startIndex + 1).padStart(5, "0")}.mp4`);
    const following = await fs.readFile(followingName).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    const partitioned = presentationSegment(raw, following, { from: startIndex * cut, to: (startIndex + 1) * cut });
    const coverage = fmp4Format.readMediaRanges(partitioned);
    assert.deepEqual(fmp4Format.initVideoSize(fmp4Format.extractInit(raw)), { width: videoIndex ? 32 : 64, height: videoIndex ? 32 : 64 });
    const judged = judgePiece(fmp4Format, coverage, undefined, { from: startIndex * cut, to: (startIndex + 1) * cut, requiredKinds: ["vide"] });
    assert.equal(judged.whole, true, JSON.stringify({ judged, coverage }, (_key, value) => typeof value === "bigint" ? String(value) : value));
    assert.equal(coverage.tracks[0].ranges[0].start, BigInt(Math.round(startIndex * cut * Number(coverage.tracks[0].timescale))));
    if (codec === "libx265") {
      const interval = { from: startIndex * cut, to: (startIndex + 1) * cut, requiredKinds: ["vide"] };
      if (!final) {
        assert.equal(judgePiece(fmp4Format, fmp4Format.readMediaRanges(raw), undefined, interval).whole, false,
          "the muxer's unpartitioned open GOP lacks leading pictures");
        assert.equal(judgePiece(fmp4Format, fmp4Format.readMediaRanges(presentationSegment(raw, null, interval)), undefined, interval).whole, false,
          "absent following media remains incomplete");
      } else {
        assert.equal(following, null, "the final interval needs no following file");
      }
      const restored = path.join(directory, "restored.mp4");
      await fs.writeFile(restored, partitioned);
      const hashes = (source, end = interval.to) => {
        const decoded = spawnSync(ffmpegBin, ["-v", "error", "-xerror", "-copyts", "-i", source, "-an",
          "-vf", `trim=start=${interval.from}:end=${end}`, "-fps_mode", "passthrough", "-enc_time_base", "1:1000000", "-f", "framemd5", "-"],
          { encoding: "utf8", windowsHide: true });
        assert.equal(decoded.status, 0, decoded.stderr);
        assert.equal(decoded.stderr.trim(), "");
        return decoded.stdout.split(/\r?\n/).filter(line => line && !line.startsWith("#")).map(line => {
          const columns = line.split(",");
          return { pts: Number(columns[2]), hash: columns.at(-1).trim() };
        });
      };
      const expected = hashes(file);
      assert.equal(expected.length, 240);
      const decoded = hashes(restored, interval.to + 0.02);
      assert.deepEqual(decoded.slice(0, expected.length).map(frame => frame.hash), expected.map(frame => frame.hash), "every recovered picture decodes identically to the original interval");
      assert.equal(decoded.length, expected.length + Number(!final), "only a required following CRA is retained as a decode reference");
      const withReference = hashes(file, interval.to + 0.02);
      assert.deepEqual(decoded.map(frame => frame.hash), withReference.map(frame => frame.hash), "the additional decode reference is the next source picture");
      for (let index = 0; index < decoded.length; index++) {
        assert.ok(Math.abs(decoded[index].pts - withReference[index].pts) <= Math.ceil(1_000_000 / Number(coverage.tracks[0].timescale)) + 1,
          `picture ${index} retains its presentation time: ${decoded[index].pts} vs ${withReference[index].pts}`);
      }
    }
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    input?.release();
    const absolute = path.resolve(directory), temporary = path.resolve(os.tmpdir());
    assert.ok(absolute.startsWith(`${temporary}${path.sep}`) && path.basename(absolute).startsWith("ttv95-original-input-"));
    await fs.rm(absolute, { recursive: true, force: true });
  }
});
