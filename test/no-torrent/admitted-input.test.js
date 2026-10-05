import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { createHash } from "node:crypto";
import { admitInput, writeAdmittedInput } from "../../services/encode/AdmittedInput.js";

const packet = { pts: 2, dts: 1.9, duration: 0.1, keyframe: true, ranges: [[4, 5]] };
const source = { sourceKey: "source", fileIndex: 0, timeShiftSeconds: 1,
  input: { ranges: [[0, 1], [4, 5]], tracks: [{ track: { type: "video", trackNumber: 1, codecId: "vp8", width: 64, height: 64 }, packets: [packet] }] } };

test("admitted source ends use the same movie clock as admitted packets", async () => {
  const candidate = structuredClone(source);
  candidate.input.tracks[0].sourceEndSeconds = 2.1;
  const admitted = await admitInput({ sources: [candidate], reserve: () => () => {},
    readRanges: async () => [Buffer.from("ab"), Buffer.from("cd")] });
  assert.equal(admitted.tracks[0].sourceEndSeconds, 1.1);
  assert.equal(admitted.tracks[0].packets[0].pts, 1);
  admitted.release();
});

test("appended final input declares its proven source end to the existing run", async () => {
  const final = structuredClone(source);
  final.input.tracks[0].packets[0].pts = 3;
  final.input.tracks[0].sourceEndSeconds = 3.1;
  let released = 0;
  const prepare = candidate => admitInput({ sources: [candidate], reserve: () => () => released++,
    readRanges: async () => [Buffer.from("ab"), Buffer.from("cd")] });
  const first = await prepare(source);
  let next = await prepare(final);
  assert.equal(first.tracks[0].sourceEndSeconds, undefined);
  await writeAdmittedInput(first, new Writable({ write(_chunk, _encoding, done) { done(); } }), {
    next: () => { const result = next; next = null; return result; }
  });
  assert.equal(first.tracks[0].sourceEndSeconds, 2.1);
  assert.equal(released, 2);
});

test("PCM conversion reserves its owned bytes before reading and preserves the source", async () => {
  const original = Buffer.from([0x80, 0, 0x7f]);
  const candidate = { sourceKey: "source", fileIndex: 0, input: { ranges: [[0, 2]], tracks: [{
    track: { type: "audio", trackNumber: 1, codecId: "pcm_s8", samplingFrequency: 48000, channels: 1, bitDepth: 8 },
    packets: [{ pts: 0, duration: 3 / 48000, keyframe: true, ranges: [[0, 2]] }]
  }] } };
  let reserved = 0, read = false, released = false;
  const admitted = await admitInput({ sources: [candidate], reserve: bytes => {
    assert.equal(read, false);
    reserved = bytes;
    return () => { released = true; };
  }, readRanges: async () => { read = true; return [original]; } });
  assert.equal(reserved, 6);
  assert.equal(admitted.bytes, 6);
  const chunks = await Array.fromAsync(admitted.stream());
  assert.ok(chunks.some(chunk => chunk.equals(Buffer.from([0, 0x80, 0xff]))));
  assert.deepEqual(original, Buffer.from([0x80, 0, 0x7f]));
  admitted.release();
  assert.equal(released, true);
});

test("packet addresses are checked against demuxed payload before encoder admission", async () => {
  const candidate = structuredClone(source);
  candidate.input.tracks[0].packets[0].expectedHash = createHash("sha256").update("cd").digest("hex");
  let releases = 0;
  const acquire = buffers => admitInput({ sources: [candidate], reserve: () => () => releases++, readRanges: async () => buffers });
  const valid = await acquire([Buffer.from("ab"), Buffer.from("cd")]);
  assert.equal(valid.kind, "result");
  valid.release();
  const mismatch = await acquire([Buffer.from("ab"), Buffer.from("dc")]);
  assert.equal(mismatch.kind, "terminal");
  assert.equal(mismatch.reason, "packet-address-does-not-match-payload");
  assert.equal(releases, 2);
});

test("input identity includes packet timing and decoder declarations with identical bytes", async () => {
  const acquire = async candidate => admitInput({ sources: [candidate], reserve: () => () => {},
    readRanges: async () => [Buffer.from("ab"), Buffer.from("cd")] });
  const first = await acquire(source);
  const same = await acquire(structuredClone(source));
  const differentTime = structuredClone(source);
  differentTime.input.tracks[0].packets[0].pts += 0.01;
  const timed = await acquire(differentTime);
  const differentConfiguration = structuredClone(source);
  differentConfiguration.input.tracks[0].track.width = 128;
  const configured = await acquire(differentConfiguration);
  assert.equal(first.fingerprint, same.fingerprint);
  assert.notEqual(first.fingerprint, timed.fingerprint);
  assert.notEqual(first.fingerprint, configured.fingerprint);
  for (const input of [first, same, timed, configured]) input.release();
});

test("different payload bit addresses cannot reuse the same admitted input identity", async () => {
  const candidate = structuredClone(source);
  const shifted = structuredClone(source);
  Object.assign(candidate.input.tracks[0].packets[0], { bitOffset: 0, bitLength: 8 });
  Object.assign(shifted.input.tracks[0].packets[0], { bitOffset: 8, bitLength: 8 });
  const acquire = input => admitInput({ sources: [input], reserve: () => () => {},
    readRanges: async () => [Buffer.from("ab"), Buffer.from("cd")] });
  const first = await acquire(candidate), second = await acquire(shifted);
  assert.notEqual(first.fingerprint, second.fingerprint);
  first.release(); second.release();
});

test("complete input reserves memory before reading and keeps immutable owned bytes until released", async () => {
  const order = [];
  const input = await admitInput({ sources: [source], reserve: bytes => {
    order.push(["reserve", bytes]); return () => order.push(["release"]);
  }, readRanges: async () => { order.push(["read"]); return [Buffer.from("ab"), Buffer.from("cd")]; } });
  assert.equal(input.kind, "result");
  assert.deepEqual(order, [["reserve", 4], ["read"]]);
  assert.equal(input.tracks[0].packets[0].pts, 1);
  assert.ok(Math.abs(input.tracks[0].packets[0].dts - 0.9) < 1e-12);
  assert.equal(packet.pts, 2);
  assert.equal(input.readPacket(input.tracks[0], input.tracks[0].packets[0]).toString(), "cd");
  const chunks = [];
  for await (const chunk of input.stream()) chunks.push(chunk);
  assert.ok(Buffer.concat(chunks).includes(Buffer.from("cd")));
  input.release(); input.release();
  assert.deepEqual(order.at(-1), ["release"]);
  assert.equal(order.filter(item => item[0] === "release").length, 1);
  assert.throws(() => input.readPacket(input.tracks[0], input.tracks[0].packets[0]), /released/);
});

test("missing memory or bytes cannot produce encoder input and reservations are returned", async () => {
  let reads = 0, releases = 0;
  const readRanges = async () => { reads++; return null; };
  assert.equal((await admitInput({ sources: [source], reserve: () => null, readRanges })).kind, "needs-memory");
  assert.equal(reads, 0);
  assert.equal((await admitInput({ sources: [source], reserve: () => () => releases++, readRanges })).kind, "needs-bytes");
  assert.equal(releases, 1);
  await assert.rejects(admitInput({ sources: [source], reserve: () => () => releases++, readRanges: async () => [] }), /incomplete ranges/);
  assert.equal(releases, 2);
});

test("a failed encoder write returns the complete input reservation", async () => {
  let releases = 0;
  const input = await admitInput({ sources: [source], reserve: () => () => releases++, readRanges: async () => [Buffer.from("ab"), Buffer.from("cd")] });
  const stdin = new Writable({ write(_chunk, _encoding, callback) { callback(new Error("Encoder closed stdin")); } });
  stdin.on("error", () => {});
  await assert.rejects(writeAdmittedInput(input, stdin), /Encoder closed stdin/);
  assert.equal(releases, 1);
});

test("fragmented packet streaming borrows each admitted buffer without joining payloads", async () => {
  const candidate = structuredClone(source);
  candidate.input.tracks[0].packets[0].ranges = [[0, 1], [4, 5]];
  const buffers = [Buffer.from("ab"), Buffer.from("cd")];
  const input = await admitInput({ sources: [candidate], reserve: () => () => {}, readRanges: async () => buffers });
  const chunks = [];
  for await (const chunk of input.stream()) chunks.push(chunk);
  for (const buffer of buffers) assert.ok(chunks.some(chunk => chunk.buffer === buffer.buffer &&
    chunk.byteOffset === buffer.byteOffset && chunk.length === buffer.length));
  input.release();
});
