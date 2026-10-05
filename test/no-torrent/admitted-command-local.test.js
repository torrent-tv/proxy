import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ffmpegBin from "ffmpeg-static";
import { ContainerFactory } from "../../services/media/container/ContainerFactory.js";
import { SegmentInputs } from "../../services/media/SegmentInputs.js";
import { admitInput, writeAdmittedInput } from "../../services/encode/AdmittedInput.js";
import { Writable } from "node:stream";
import { buildAdmittedCommand } from "../../services/encode/admitted-command.js";
import { fmp4Format } from "../../services/encode/segment-formats/fmp4.js";
import { softwareDescriptor } from "../../services/encode/hwaccel.js";
import { judgePiece } from "../../services/encode/piece-completeness.js";
import { presentationSegment } from "../../services/encode/segment-formats/presentation-segment.js";
import { walkBoxes } from "../../services/encode/segment-formats/mp4-boxes.js";

// Only synthetic lavfi input and stdin are used; no torrent or HTTP boundary.
test("audio-only cuts cover each declared interval within one AAC frame", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ttv-audio-cut-"));
  try {
    const file = path.join(directory, "source.mp4");
    const made = spawnSync(ffmpegBin, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
      "sine=sample_rate=48000", "-t", "3", "-c:a", "aac", file], { windowsHide: true, encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
    const bytes = await fs.readFile(file);
    const container = await ContainerFactory.create({ fileSize: bytes.length, readRange: async (a, b) => bytes.subarray(a, b + 1) });
    const tracks = await container.readTracks();
    const index = await container.readPacketIndex();
    const input = new SegmentInputs({ tracks, index }).forInterval({ from: 0, to: 3, mode: "copy" });
    assert.equal(input.kind, "result");
    const admitted = await admitInput({ sources: [{ sourceKey: "local", fileIndex: 0, input }], reserve: () => () => {},
      readRanges: async (_source, ranges) => ranges.map(([a, b]) => Buffer.from(bytes.subarray(a, b + 1))) });
    const chunks = [];
    await writeAdmittedInput(admitted, new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } }));
    const grid = [0, 1.5, 3];
    const command = buildAdmittedCommand({ admittedInput: admitted, timeline: { published: grid }, output: {},
      segmentFormat: fmp4Format, transcodeVideo: false, transcodeAudio: false, audioOnly: true,
      audioSeparate: false, startIndex: 0, endIndex: 1, videoEncoder: softwareDescriptor(), segmentDurationSec: 1.5 });
    const encoded = spawnSync(ffmpegBin, command.args, { cwd: directory, windowsHide: true, input: Buffer.concat(chunks),
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe", "pipe"] });
    assert.equal(encoded.status, 0, encoded.stderr);
    const names = (await fs.readdir(directory)).filter(name => name.startsWith("making-")).sort();
    assert.equal(names.length, 2);
    for (let i = 0; i < names.length; i++) {
      const ranges = fmp4Format.readMediaRanges(await fs.readFile(path.join(directory, names[i])));
      const judged = judgePiece(fmp4Format, ranges, undefined, { from: grid[i], to: grid[i + 1], requiredKinds: ["soun"] });
      assert.equal(judged.whole, true, JSON.stringify({ judged, ranges }, (_key, value) => typeof value === "bigint" ? String(value) : value));
    }
    admitted.release();
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("ttv-audio-cut-"));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

for (const transcode of [false, true]) {
  for (const preset of transcode ? ["ultrafast", "veryfast"] : ["ultrafast"]) {
  for (const startIndex of [0, 2]) {
    test(`admitted stdin produces the requested interval: transcode=${transcode}, preset=${preset}, segment=${startIndex}`, async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ttv-admitted-command-"));
      try {
        const file = path.join(directory, "source.mp4");
        const made = spawnSync(ffmpegBin, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=10",
          "-f", "lavfi", "-i", "sine=sample_rate=48000", "-t", "3", "-c:v", "libx264", "-g", "5", "-keyint_min", "5", "-sc_threshold", "0",
          "-c:a", "aac", file], { windowsHide: true, encoding: "utf8" });
        assert.equal(made.status, 0, made.stderr);
        const bytes = await fs.readFile(file);
        const container = await ContainerFactory.create({ fileSize: bytes.length, readRange: async (a, b) => bytes.subarray(a, b + 1) });
        const tracks = await container.readTracks();
        const index = await container.readPacketIndex();
        const grid = [0, 0.5, 1, 1.5, 2, 2.5, 3];
        const input = new SegmentInputs({ tracks, index }).forInterval({ from: grid[startIndex], to: grid[startIndex + 1], mode: transcode ? "transcode" : "copy" });
        assert.equal(input.kind, "result", JSON.stringify(input));
        const admitted = await admitInput({ sources: [{ sourceKey: "local", fileIndex: 0, input }], reserve: () => () => {},
          readRanges: async (_source, ranges) => ranges.map(([a, b]) => Buffer.from(bytes.subarray(a, b + 1))) });
        const chunks = [];
        const append = startIndex === 2;
        let next = null;
        if (append) {
          const following = new SegmentInputs({ tracks, index }).forInterval({ from: grid[startIndex + 1], to: grid[startIndex + 2], mode: transcode ? "transcode" : "copy" });
          assert.equal(following.kind, "result");
          next = await admitInput({ sources: [{ sourceKey: "local", fileIndex: 0, input: following }], reserve: () => () => {},
            readRanges: async (_source, ranges) => ranges.map(([a, b]) => Buffer.from(bytes.subarray(a, b + 1))) });
        }
        const stdin = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
        await writeAdmittedInput(admitted, stdin, { next: () => { const current = next; next = null; return current; } });
        const command = buildAdmittedCommand({ admittedInput: admitted, timeline: { published: grid, cutGrid: "keyframe" },
          output: { encodeWidth: 64, encodeHeight: 64, outputFps: 10, softwarePreset: preset }, segmentFormat: fmp4Format,
          transcodeVideo: transcode, transcodeAudio: transcode, audioOnly: false, audioSeparate: false,
          startIndex, endIndex: startIndex + (append ? 1 : 0), videoEncoder: softwareDescriptor(), segmentDurationSec: 0.5 });
        assert.equal(command.args.includes("-ss"), false);
        assert.deepEqual(command.args.filter(argument => argument === "-i"), ["-i"]);
        const encoded = spawnSync(ffmpegBin, command.args, { cwd: directory, windowsHide: true, input: Buffer.concat(chunks),
          encoding: "utf8", stdio: ["pipe", "pipe", "pipe", "pipe"] });
        assert.equal(encoded.status, 0, encoded.stderr);
        assert.equal(encoded.stderr, "", "Encoding admitted packets reported an error.");
        const names = (await fs.readdir(directory)).filter(name => name.startsWith("making-"));
        assert.equal(names.length, append ? 2 : 1, JSON.stringify(names));
        const originals = await Promise.all(names.map(name => fs.readFile(path.join(directory, name))));
        if (!transcode) {
          const damaged = Buffer.from(originals[0]);
          let replaced = false;
          walkBoxes(damaged, (type, start) => {
            if (type === "trun" && !replaced) { damaged.writeInt32BE(0, start + 8); replaced = true; }
          });
          assert.equal(replaced, true);
          assert.throws(() => presentationSegment(damaged, null, { from: grid[startIndex], to: grid[startIndex + 1] }), /sample bytes are incomplete/);
        }
        for (const name of names) {
        const segmentIndex = fmp4Format.segmentIndexFromName(fmp4Format.servedNameOf(name));
        const position = names.indexOf(name);
        const segment = presentationSegment(originals[position], originals[position + 1],
          { from: grid[segmentIndex], to: grid[segmentIndex + 1] });
        await fs.writeFile(path.join(directory, name), segment);
        const ranges = fmp4Format.readMediaRanges(segment);
        assert.ok(ranges, "Produced segment declares its media intervals.");
        const through = fmp4Format.producedThroughSeconds(ranges);
        assert.ok(through >= 0.45, JSON.stringify(ranges, (_key, value) => typeof value === "bigint" ? String(value) : value));
        const judged = judgePiece(fmp4Format, ranges, undefined, { from: grid[segmentIndex], to: grid[segmentIndex + 1], requiredKinds: ["vide", "soun"] });
        assert.equal(judged.whole, true, JSON.stringify({ judged, ranges }, (_key, value) => typeof value === "bigint" ? String(value) : value));
        const decoded = spawnSync(ffmpegBin, ["-hide_banner", "-loglevel", "error", "-i", path.join(directory, name), "-f", "null", "pipe:1"],
          { windowsHide: true, encoding: "utf8" });
        assert.equal(decoded.status, 0, decoded.stderr);
        assert.equal(decoded.stderr, "", "Produced segment decodes independently.");
        }
        admitted.release();
      } finally {
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith("ttv-admitted-command-"));
        await fs.rm(directory, { recursive: true, force: true });
      }
    });
  }
  }
}
