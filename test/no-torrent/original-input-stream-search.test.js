import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import ffmpegBin from "ffmpeg-static";
import ffprobe from "@ffprobe-installer/ffprobe";
import { MatroskaContainer } from "../../services/media/container/MatroskaContainer.js";
import { ContainerTrack } from "../../services/media/tracks/ContainerTrack.js";
import { admitOriginalInput } from "../../services/encode/OriginalInput.js";
import { buildOriginalCommand } from "../../services/encode/source-command.js";
import { handleEncodeInputGet } from "../../routes/encode-input/get.js";
import { fmp4Format } from "../../services/encode/segment-formats/fmp4.js";

// Generated ordinary media and a loopback HTTP server only; no torrent imports.
//
// FFmpeg reads on from the first media at open until every stream has given it
// a packet or its stated search time has passed. A soundtrack that starts late
// keeps it reading past the declarations; the route refuses every byte the
// container did not name, and from FFmpeg 7.1 on that refusal ends the run with
// nothing made (field 2026-10-08, ffmpeg 8.1.2; torrent-tv/meta#165).

const FPS = 25;

test("a run over named bytes is not refused when a soundtrack starts late", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ttv165-search-"));
  let server, input;
  try {
    const file = path.join(directory, "source.mkv");
    const made = spawnSync(ffmpegBin, ["-v", "error", "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=${FPS}`,
      "-f", "lavfi", "-i", "sine=sample_rate=48000", "-itsoffset", "12", "-f", "lavfi", "-t", "18", "-i", "sine=frequency=880:sample_rate=48000",
      "-t", "30", "-map", "0:v", "-map", "1:a", "-map", "2:a", "-c:v", "libx264", "-preset", "ultrafast", "-bf", "2", "-g", String(2 * FPS),
      "-b:v", "4M", "-c:a", "ac3", file], { encoding: "utf8", windowsHide: true });
    assert.equal(made.status, 0, made.stderr);
    const bytes = await fs.readFile(file);
    const container = new MatroskaContainer({ fileSize: bytes.length, readRange: async (start, end) => bytes.subarray(start, end + 1) });
    const picture = ContainerTrack.firstUsable(await container.readTracks(), "video");
    const keyframes = (await container.parseKeyframeIndex()).times;
    const grid = keyframes;
    const startIndex = grid.findIndex(time => time >= 22);
    const from = grid[startIndex], to = grid[startIndex + 1];
    const ranges = await container.readSourceRanges({ from, to, trackIds: [picture.trackNumber] });
    assert.equal(ranges.kind, "result");
    assert.ok(ranges.ranges.length > 1, "the search and the interval are named apart, so a read between them is refused");
    input = await admitOriginalInput({ sources: [{ sourceKey: "generated", fileIndex: 0, timeShiftSeconds: 0,
      input: { ...ranges, original: true, selections: [{ track: picture, index: 0 }] } }],
      reserve: async () => () => {}, readRanges: async (_source, list) => list.map(([start, end]) => bytes.subarray(start, end + 1)) });
    input.runTag = "search";
    const refused = [];
    server = http.createServer((req, res) => {
      req.params = { token: "1", fileIndex: "0" }; req.raw = req;
      const reply = { raw: res, hijack() { return this; }, code(status) { if (status >= 400) refused.push(req.headers.range); res.statusCode = status; return this; },
        header(name, value) { res.setHeader(name, value); return this; },
        send(body) { res.end(Buffer.isBuffer(body) ? body : body ? JSON.stringify(body) : undefined); return this; } };
      handleEncodeInputGet(req, reply, { inputOf: () => input });
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const { args } = buildOriginalCommand({ admittedInput: input, inputToken: 1,
      baseUrl: `http://127.0.0.1:${server.address().port}`, startIndex,
      timeline: { published: grid, cutGrid: "keyframe" }, keyframes: { times: keyframes },
      audioOnly: false, audioSeparate: true, transcodeAudio: false, transcodeVideo: false, output: {}, videoEncoder: {},
      segmentFormat: fmp4Format, segmentDurationSec: 2 });
    const child = spawn(ffmpegBin, args, { cwd: directory, stdio: ["ignore", "ignore", "pipe", "ignore"], windowsHide: true });
    let diagnostics = "";
    child.stderr.on("data", chunk => { diagnostics += chunk; });
    const timeout = setTimeout(() => child.kill(), 60000);
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    clearTimeout(timeout);
    assert.deepEqual(refused, [], "FFmpeg read only bytes the container named");
    assert.equal(code, 0, diagnostics);
    assert.ok(args.includes("-analyzeduration"), "FFmpeg is told the search time its bytes were named for");
    const piece = path.join(directory, `making-search-${String(startIndex).padStart(5, "0")}.mp4`);
    const counted = spawnSync(ffprobe.path, ["-v", "error", "-count_packets", "-select_streams", "v:0",
      "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", piece], { encoding: "utf8", windowsHide: true });
    assert.equal(counted.status, 0, counted.stderr);
    assert.ok(Number(counted.stdout.trim()) >= Math.round((to - from) * FPS), `the piece holds its interval's pictures: ${counted.stdout.trim()}`);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    input?.release();
    const absolute = path.resolve(directory), temporary = path.resolve(os.tmpdir());
    assert.ok(absolute.startsWith(`${temporary}${path.sep}`) && path.basename(absolute).startsWith("ttv165-search-"));
    await fs.rm(absolute, { recursive: true, force: true });
  }
});
