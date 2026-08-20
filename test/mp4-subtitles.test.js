/**
 * @file Reading an MP4's text subtitle track out of its sample table.
 *
 * The file is built here, so every answer is known in advance: two cues at
 * stated times, in stated places, with an empty sample between them — the way
 * the format says "nothing on screen just now".
 */

import test from "node:test";
import assert from "node:assert/strict";
import { decodeSubtitleSample, readMp4SubtitlePlan } from "../services/container-index/mp4-subtitles.js";

function box(type, payload) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, payload]);
}

function fullBox(type, payload) {
  return box(type, Buffer.concat([Buffer.from([0, 0, 0, 0]), payload]));
}

function u32(...values) {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeUInt32BE(value, index * 4));
  return buffer;
}

/** A `tx3g` sample: a two-byte length, then the text. */
function textSample(text) {
  const bytes = Buffer.from(text, "utf8");
  const length = Buffer.alloc(2);
  length.writeUInt16BE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

/**
 * A file with one text track: three samples, the middle one empty.
 *
 * @returns {{ file: Buffer, samples: Buffer[] }}
 */
function buildFile() {
  const samples = [textSample("First line"), Buffer.alloc(2), textSample("Second line")];
  const timescale = 1000;

  const mdhd = fullBox("mdhd", Buffer.concat([
    u32(0, 0, timescale, 60_000),
    // Language "eng", five bits a letter offset from 0x60, then a spare word.
    Buffer.from([0x15, 0xc7, 0, 0])
  ]));
  const hdlr = fullBox("hdlr", Buffer.concat([u32(0), Buffer.from("sbtl", "latin1"), u32(0, 0, 0)]));
  const tkhd = fullBox("tkhd", u32(0, 0, 7, 0, 60_000));

  const stsd = fullBox("stsd", Buffer.concat([u32(1), box("tx3g", Buffer.alloc(24))]));
  // Two seconds a sample, so the cues sit at 0-2, 2-4 and 4-6 seconds.
  const stts = fullBox("stts", Buffer.concat([u32(1), u32(3, 2000)]));
  const stsz = fullBox("stsz", Buffer.concat([u32(0, 3), u32(...samples.map((s) => s.length))]));
  const stsc = fullBox("stsc", Buffer.concat([u32(1), u32(1, 3, 1)]));

  const stbl = box("stbl", Buffer.concat([stsd, stts, stsz, stsc, fullBox("stco", Buffer.concat([u32(1), u32(0)]))]));
  const minf = box("minf", stbl);
  const mdia = box("mdia", Buffer.concat([mdhd, hdlr, minf]));
  const trak = box("trak", Buffer.concat([tkhd, mdia]));
  const moovDraft = box("moov", trak);

  // The samples sit after moov, so the chunk offset is known only now. Its
  // length does not change when the placeholder becomes the real value.
  const mdatStart = moovDraft.length + 8;
  const stcoReal = fullBox("stco", Buffer.concat([u32(1), u32(mdatStart)]));
  const stblReal = box("stbl", Buffer.concat([stsd, stts, stsz, stsc, stcoReal]));
  const moov = box("moov", box("trak", Buffer.concat([
    tkhd,
    box("mdia", Buffer.concat([mdhd, hdlr, box("minf", stblReal)]))
  ])));
  const mdat = box("mdat", Buffer.concat(samples));
  return { file: Buffer.concat([moov, mdat]), samples };
}

function readerOver(file) {
  return async (start, end) => {
    const last = Math.min(end, file.length - 1);
    return start > last ? null : file.subarray(start, last + 1);
  };
}

test("a text track's cues are found with their times and their byte ranges", async () => {
  const { file, samples } = buildFile();

  const plan = await readMp4SubtitlePlan(readerOver(file), file.length);

  assert.equal(plan.tracks.length, 1);
  const track = plan.tracks[0];
  assert.equal(track.format, "tx3g");
  assert.equal(track.language, "eng");
  assert.equal(track.samples.length, 2, "the empty sample is a gap, not a cue");
  assert.deepEqual(
    track.samples.map((sample) => [sample.startSeconds, sample.endSeconds]),
    [[0, 2], [4, 6]],
    "times come from the duration table, and the gap keeps its place in it"
  );
  // The bytes the plan points at are the ones that hold the text.
  const first = file.subarray(track.samples[0].offset, track.samples[0].offset + track.samples[0].size);
  assert.equal(decodeSubtitleSample(first, "tx3g"), "First line");
  const second = file.subarray(track.samples[1].offset, track.samples[1].offset + track.samples[1].size);
  assert.equal(decodeSubtitleSample(second, "tx3g"), "Second line");
  assert.equal(second.length, samples[2].length);
});

test("a file with no text track offers nothing", async () => {
  const moov = box("moov", box("trak", box("mdia", Buffer.concat([
    fullBox("mdhd", Buffer.concat([u32(0, 0, 1000, 100), Buffer.from([0, 0, 0, 0])])),
    fullBox("hdlr", Buffer.concat([u32(0), Buffer.from("vide", "latin1"), u32(0, 0, 0)]))
  ]))));
  const file = Buffer.concat([moov, box("mdat", Buffer.alloc(4))]);

  const plan = await readMp4SubtitlePlan(readerOver(file), file.length);

  assert.deepEqual(plan.tracks, []);
});

test("a WebVTT sample gives up the text inside its payload box", () => {
  const payl = box("payl", Buffer.from("Hello there", "utf8"));
  const sample = box("vttc", payl);

  assert.equal(decodeSubtitleSample(sample, "wvtt"), "Hello there");
});
