import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ContainerFactory } from "../../services/media/container/ContainerFactory.js";
import { ProbeRequests } from "../../services/media/ProbeRequests.js";
import { IndexMemoryUnavailable } from "../../services/media/container/memory-unavailable.js";

test("retained demuxer facts and the final index share admitted memory without duplicate packets", async () => {
  let allowance = 0, held = 0, scans = 0;
  const requests = new ProbeRequests({ publish: () => {} });
  const container = await ContainerFactory.create({ fileSize: 30, readRange: async (a, b) => Buffer.alloc(b - a + 1),
    packetMemory: { reserve: bytes => {
      if (held + bytes > allowance) return false;
      held += bytes;
      return true;
    }, release: bytes => { held -= bytes; } },
    probe: (statement, accept) => requests.read({ sourceKey: "source", fileIndex: 0, statement,
      probe: async () => {
        if (statement === "streams") return declarations;
        scans++;
        accept({ kind: "scan-start" }); packets.forEach(accept); accept({ kind: "scan-end" });
        return [];
      } }) });
  await assert.rejects(container.readPacketIndex(), IndexMemoryUnavailable);
  assert.equal(held, 0);
  allowance = 131072;
  requests.memoryChanged();
  await assert.rejects(container.readPacketIndex(), IndexMemoryUnavailable);
  assert.equal(held, 131072);
  allowance = 262144;
  requests.memoryChanged();
  const index = await container.readPacketIndex();
  assert.equal(index.inputFor({ trackId: 1, from: 0, to: 0.2 }).packets.length, 2);
  assert.equal(held, 131072);
  assert.equal(scans, 2);
  assert.equal(await container.readPacketIndex(), index);
});

const declarations = [{ kind: "stream", index: "0", codec_type: "video", codec_name: "vp8", width: "64", height: "64", r_frame_rate: "10/1", has_b_frames: "0" },
  { kind: "format", format_name: "other", start_time: "0", duration: "0.2" }];
const packets = [0, 1].map(position => ({ kind: "packet", stream_index: "0", pos: String(20 + position * 2), size: "2",
  pts_time: String(position / 10), dts_time: String(position / 10), duration_time: "0.1", flags: position ? "__" : "K_",
  data_hash: `SHA256:${createHash("sha256").update("ab").digest("hex")}` }));

test("PCM storage width takes precedence over the number of valid sample bits", async () => {
  const bytes = Buffer.alloc(30);
  const container = await ContainerFactory.create({ fileSize: bytes.length, readRange: async (a, b) => bytes.subarray(a, b + 1),
    probe: async () => ({ kind: "result", value: [
      { kind: "stream", index: "0", codec_type: "audio", codec_name: "pcm_s32le", sample_rate: "48000", channels: "2",
        bits_per_sample: "32", bits_per_raw_sample: "24" },
      { kind: "format", format_name: "wav", duration: "1" }
    ] }) });
  assert.equal((await container.readTracks())[0].bitDepth, 32);
});

test("additional containers retain every previously offered text subtitle codec", async () => {
  for (const codec of ["subrip", "srt", "ass", "ssa", "webvtt", "vtt", "mov_text", "text"]) {
    const ass = codec === "ass" || codec === "ssa";
    const text = "Subtitle, with punctuation";
    const payload = codec === "mov_text" ? Buffer.concat([Buffer.from([0, Buffer.byteLength(text)]), Buffer.from(text)])
      : Buffer.from(ass ? `0,0,Default,,0,0,0,,${text}` : text);
    const bytes = Buffer.concat([Buffer.alloc(20), payload]);
    const container = await ContainerFactory.create({ fileSize: bytes.length, readRange: async (a, b) => bytes.subarray(a, b + 1),
      probe: async (statement, accept) => {
        if (statement === "streams") return { kind: "result", value: [
          { kind: "stream", index: "0", codec_type: "subtitle", codec_name: codec },
          { kind: "format", format_name: "other", start_time: "0", duration: "5" }
        ] };
        accept({ kind: "scan-start" });
        accept({ kind: "packet", stream_index: "0", pos: "20", size: String(payload.length),
          pts_time: "1", dts_time: "N/A", duration_time: "2", flags: "K_",
          data_hash: `SHA256:${createHash("sha256").update(payload).digest("hex")}` });
        accept({ kind: "scan-end" });
        return { kind: "result", value: [] };
      } });
    const [track] = await container.readTracks();
    assert.equal(track.isTextBased(), true, codec);
    const input = (await container.readPacketIndex()).inputFor({ trackId: track.trackNumber, from: 0, to: 4 });
    assert.equal(input.kind, "result", codec);
    assert.deepEqual(input.ranges, [[20, bytes.length - 1]], codec);
    assert.equal(input.packets[0].pts, 1, codec);
    assert.equal(input.packets[0].duration, 2, codec);
    assert.equal(container.cueTextOf(payload, track.codecId), text, codec);
  }
});

test("unknown formats expose declared facts and verified packet geometry", async () => {
  const container = await ContainerFactory.create({ fileSize: 30, readRange: async (a, b) => Buffer.alloc(b - a + 1),
    probe: async (statement, accept) => {
      if (statement === "streams") return { kind: "result", value: declarations };
      accept({ kind: "scan-start" });
      packets.forEach(accept);
      accept({ kind: "scan-end" });
      return { kind: "result", value: [] };
    } });
  assert.equal(container.formatName, "ffprobe");
  assert.equal((await container.readTracks())[0].width, 64);
  assert.equal((await container.readMediaInfo()).durationSeconds, 0.2);
  const index = await container.readPacketIndex();
  const input = index.inputFor({ trackId: 1, from: 0, to: 0.2 });
  assert.equal(input.kind, "result");
  assert.deepEqual(input.ranges, [[20, 23]]);
  assert.equal(input.packets[0].expectedHash, packets[0].data_hash.slice(7));
});

test("automatic byte retries preserve a partial packet scan without treating missing bytes as EOF", async () => {
  let available = false;
  const requests = new ProbeRequests({ publish: () => {} });
  const container = await ContainerFactory.create({ fileSize: 30, readRange: async (a, b) => Buffer.alloc(b - a + 1),
    probe: (statement, accept) => requests.read({ sourceKey: "source", fileIndex: 0, statement,
      probe: async ({ requestId }) => {
        if (statement === "streams") return declarations;
        accept({ kind: "scan-start" }); accept(packets[0]);
        if (!available) { requests.needs(requestId, 22, 23); throw new Error("Missing bytes"); }
        accept(packets[1]); accept({ kind: "scan-end" });
        return [];
      } }) });
  await assert.rejects(container.readPacketIndex(), error => error.name === "BytesUnavailable");
  available = true;
  const completed = new Promise(resolve => {
    const unsubscribe = requests.subscribe("source", 0, result => {
      if (result.kind === "result") { unsubscribe(); resolve(); }
    });
  });
  requests.bytesChanged("source", 0);
  await completed;
  const input = (await container.readPacketIndex()).inputFor({ trackId: 1, from: 0, to: 0.2 });
  assert.equal(input.packets.length, 2);
});

test("incomplete demuxer packet timing is refused", async () => {
  const container = await ContainerFactory.create({ fileSize: 30, readRange: async (a, b) => Buffer.alloc(b - a + 1),
    probe: async (statement, accept) => {
      if (statement === "streams") return { kind: "result", value: declarations };
      accept({ kind: "scan-start" }); accept({ ...packets[0], dts_time: "N/A" }); accept({ kind: "scan-end" });
      return { kind: "result", value: [] };
    } });
  await assert.rejects(container.readPacketIndex(), /complete packet timing/);
});

test("a complete early interval is usable while later packet bytes are missing", async () => {
  const container = await ContainerFactory.create({ fileSize: 30, readRange: async (a, b) => Buffer.alloc(b - a + 1),
    probe: async (statement, accept) => {
      if (statement === "streams") return { kind: "result", value: declarations };
      accept({ kind: "scan-start" }); packets.forEach(accept);
      return { kind: "needs-ranges", ranges: [[24, 29]] };
    } });
  const early = await container.readPacketIndex({ from: 0, to: 0.1 });
  assert.equal(early.isComplete(), false);
  assert.equal(early.inputFor({ trackId: 1, from: 0, to: 0.1 }).kind, "result");
  await assert.rejects(container.readPacketIndex({ from: 0, to: 0.2 }), error => error.name === "BytesUnavailable");
});
