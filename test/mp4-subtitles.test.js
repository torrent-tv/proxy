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
import { Mp4Container } from "../services/container/Mp4Container.js";

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
 * @param {number} [displayFlags] - The `tx3g` sample entry's display flags.
 * @param {boolean} [withFtyp] - Open the file with an `ftyp` box, which is what
 *   the container layer sniffs for before it will read anything.
 * @returns {{ file: Buffer, samples: Buffer[] }}
 */
function buildFile(displayFlags = 0, withFtyp = false) {
  const samples = [textSample("First line"), Buffer.alloc(2), textSample("Second line")];
  const timescale = 1000;

  const mdhd = fullBox("mdhd", Buffer.concat([
    u32(0, 0, timescale, 60_000),
    // Language "eng", five bits a letter offset from 0x60, then a spare word.
    Buffer.from([0x15, 0xc7, 0, 0])
  ]));
  const hdlr = fullBox("hdlr", Buffer.concat([u32(0), Buffer.from("sbtl", "latin1"), u32(0, 0, 0)]));
  const tkhd = fullBox("tkhd", u32(0, 0, 7, 0, 60_000));

  // A sample entry opens with 6 reserved bytes and a 2-byte data reference
  // index, and `displayFlags` is the 32 bits after them.
  const tx3g = Buffer.alloc(24);
  tx3g.writeUInt32BE(displayFlags >>> 0, 8);
  const stsd = fullBox("stsd", Buffer.concat([u32(1), box("tx3g", tx3g)]));
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
  const ftyp = withFtyp
    ? box("ftyp", Buffer.concat([Buffer.from("isom", "latin1"), u32(512), Buffer.from("isom", "latin1")]))
    : Buffer.alloc(0);
  const mdatStart = ftyp.length + moovDraft.length + 8;
  const stcoReal = fullBox("stco", Buffer.concat([u32(1), u32(mdatStart)]));
  const stblReal = box("stbl", Buffer.concat([stsd, stts, stsz, stsc, stcoReal]));
  const moov = box("moov", box("trak", Buffer.concat([
    tkhd,
    box("mdia", Buffer.concat([mdhd, hdlr, box("minf", stblReal)]))
  ])));
  const mdat = box("mdat", Buffer.concat(samples));
  return { file: Buffer.concat([ftyp, moov, mdat]), samples };
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

test("the sample entry's display flags say whether the track is forced", async () => {
  // Apple's QuickTime File Format, "Display flags" under Subtitle sample
  // description: `0x40000000` "Some samples are forced", `0x80000000` "All
  // samples are forced", and setting the second requires the first — together
  // `0xC0000000`. `0x20000000` is vertical placement and says nothing about
  // forcing.
  const readFlags = async (displayFlags) => {
    const { file } = buildFile(displayFlags);
    const plan = await readMp4SubtitlePlan(readerOver(file), file.length);
    const track = plan.tracks[0];
    return [track.someSamplesForced, track.allSamplesForced];
  };

  assert.deepEqual(await readFlags(0), [false, false]);
  assert.deepEqual(await readFlags(0x40000000), [true, false]);
  assert.deepEqual(await readFlags(0xc0000000), [true, true]);
  // A writer that set only the second bit still means the track is forced.
  assert.deepEqual(await readFlags(0x80000000), [false, true]);
  // Vertical placement is a different field's business.
  assert.deepEqual(await readFlags(0x20000000), [false, false]);
});

test("a forced sample entry reaches the track the viewer is offered", async () => {
  const forced = buildFile(0xc0000000, true).file;
  const plain = buildFile(0, true).file;

  const trackOf = async (file) => {
    const container = new Mp4Container({ readRange: readerOver(file), fileSize: file.length });
    const tracks = await container.readTracks();
    return tracks.find((track) => track.type === "subtitle");
  };

  assert.equal((await trackOf(forced))?.isForced, true);
  assert.equal((await trackOf(plain))?.isForced, false);
});
