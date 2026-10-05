/**
 * @file The most a soundtrack's codec allows it to carry, how it is read from
 * the containers, how a later reading is merged, and how the mode a track is
 * produced in is chosen from it.
 *
 * Plain values and buffers built here: no process, no torrent, no file on disk.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  codecParametersOf,
  parseAudioSpecificConfig,
  peakKbpsOf
} from "../../services/media/tracks/audio-bound.js";
import { AudioTrack } from "../../services/media/tracks/AudioTrack.js";
import { Mp4Container } from "../../services/media/container/Mp4Container.js";
import { Container } from "../../services/media/container/Container.js";
import { buildAudioInventory, mergeInventoryEntry } from "../../services/media/audio-inventory.js";
import {
  chooseSoundtrackMode,
  LINK_VERDICT,
  linkCouldCarry,
  linkRefusalReason,
  loadOf,
  PEAK_CLASS,
  SOUNDTRACK_MODE_CAUSE,
  soundtrackLoadOf
} from "../../services/encode/quality/link-budget.js";
import { AUDIO_TRANSCODE_KBPS } from "../../services/encode/args.js";

// AudioSpecificConfig, ISO/IEC 14496-3 §1.6.2.1: objectType(5) frequencyIndex(4)
// channelConfiguration(4) then, for AAC-LC, frameLengthFlag(1) dependsOnCoreCoder(1)
// extensionFlag(1).
const LC_48K_STEREO = Buffer.from([0x11, 0x90]);
const LC_44K_STEREO = Buffer.from([0x12, 0x10]);
const LC_48K_SIX = Buffer.from([0x11, 0xb0]);
const LC_48K_STEREO_960 = Buffer.from([0x11, 0x94]);
// objectType 5 (SBR) signalled explicitly: HE-AAC, which has no confirmed bound here.
const HE_AAC = Buffer.from([0x2b, 0x92, 0x08, 0x00]);

const aacParams = (bytes) => codecParametersOf({ codec: "aac", codecPrivateB64: bytes.toString("base64") });

test("an AudioSpecificConfig gives its object type, frequency, channels and frame length", () => {
  assert.deepEqual(parseAudioSpecificConfig(LC_48K_STEREO), { objectType: 2, sampleRate: 48000, channels: 2, frameLength: 1024 });
  assert.deepEqual(parseAudioSpecificConfig(LC_44K_STEREO), { objectType: 2, sampleRate: 44100, channels: 2, frameLength: 1024 });
  assert.equal(parseAudioSpecificConfig(LC_48K_STEREO_960).frameLength, 960);
  assert.equal(parseAudioSpecificConfig(LC_48K_SIX).channels, 6);
  assert.equal(parseAudioSpecificConfig(HE_AAC).objectType, 5);
  assert.equal(parseAudioSpecificConfig(Buffer.from([0x11])), null, "too short to be a config");
});

test("AAC-LC with 1024-sample frames is bounded at 6144 bits per channel per frame", () => {
  assert.equal(peakKbpsOf(aacParams(LC_48K_STEREO)), 576);
  assert.equal(peakKbpsOf(aacParams(LC_44K_STEREO)), 529.2);
  assert.equal(peakKbpsOf(aacParams(LC_48K_SIX)), 1728, "every channel the config states");
});

test("an AAC configuration no source confirms a bound for has none", () => {
  assert.equal(peakKbpsOf(aacParams(LC_48K_STEREO_960)), null, "960-sample frames");
  assert.equal(peakKbpsOf(aacParams(HE_AAC)), null, "explicit HE-AAC");
  assert.equal(peakKbpsOf(codecParametersOf({ codec: "aac" })), null, "no config at all");
});

test("AC-3 is bounded by the largest syncframe of A/52 Table 5.18", () => {
  assert.equal(peakKbpsOf(codecParametersOf({ codec: "ac3", samplingFrequency: 48000 })), 640);
  assert.equal(peakKbpsOf(codecParametersOf({ codec: "ac3", samplingFrequency: 44100 })), 640.36875);
  assert.equal(peakKbpsOf(codecParametersOf({ codec: "ac3" })), 640.36875, "with no frequency, the largest of the three");
});

test("codecs with no confirmed bound give none", () => {
  for (const codec of ["opus", "mp3", "eac3", "dts", "flac", "vorbis"]) {
    assert.equal(peakKbpsOf(codecParametersOf({ codec, channels: 2, samplingFrequency: 48000 })), null, codec);
  }
});

test("a Matroska audio track takes its bound from its own CodecPrivate, not the container's channel count", () => {
  const track = new AudioTrack({
    trackNumber: 2,
    declaredIndex: 0,
    codecId: "A_AAC",
    codecPrivateB64: LC_48K_STEREO.toString("base64"),
    // What a Matroska Audio element may state for an HE-AAC stream's output,
    // or simply get wrong; the config is what a frame is.
    channels: 6,
    samplingFrequency: 96000
  });
  assert.equal(track.peakKbps, 576);
  assert.equal(track.codecParameters.channels, 2);
});

// ---- MP4: the AudioSpecificConfig inside `esds` ----

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

function descriptor(tag, payload) {
  return Buffer.concat([Buffer.from([tag, payload.length]), payload]);
}

function mp4WithAac(config) {
  const decoderSpecificInfo = descriptor(0x05, config);
  const decoderConfig = descriptor(0x04, Buffer.concat([
    Buffer.from([0x40, 0x15, 0, 0, 0]), u32(0, 0), decoderSpecificInfo
  ]));
  const esDescriptor = descriptor(0x03, Buffer.concat([Buffer.from([0, 1, 0]), decoderConfig]));
  const esds = fullBox("esds", esDescriptor);
  const entry = Buffer.alloc(28);
  entry.writeUInt16BE(1, 6); // data_reference_index
  entry.writeUInt16BE(2, 16); // channelcount
  entry.writeUInt16BE(16, 18); // samplesize
  entry.writeUInt32BE(48000 * 65536, 24); // samplerate, 16.16
  const mp4a = box("mp4a", Buffer.concat([entry, esds]));
  const stsd = fullBox("stsd", Buffer.concat([u32(1), mp4a]));
  const trak = box("trak", Buffer.concat([
    fullBox("tkhd", Buffer.concat([u32(0, 0, 1, 0, 0), Buffer.alloc(60)])),
    box("mdia", Buffer.concat([
      fullBox("mdhd", Buffer.concat([u32(0, 0, 48000, 48000), Buffer.from([0x15, 0xc7, 0, 0])])),
      fullBox("hdlr", Buffer.concat([u32(0), Buffer.from("soun", "latin1"), u32(0, 0, 0)])),
      box("minf", box("stbl", stsd))
    ]))
  ]));
  // tkhd flag "enabled" so the track is offered.
  const tkhd = trak.indexOf("tkhd", 0, "latin1");
  trak[tkhd + 7] = 1;
  const ftyp = box("ftyp", Buffer.from("isom\0\0\0\0isom", "latin1"));
  return Buffer.concat([ftyp, box("moov", trak), box("mdat", Buffer.alloc(4))]);
}

test("an MP4 soundtrack's AudioSpecificConfig is read out of its esds", async () => {
  const file = mp4WithAac(LC_48K_STEREO);
  const container = new Mp4Container({
    readRange: async (start, end) => file.subarray(start, Math.min(end, file.length - 1) + 1),
    fileSize: file.length
  });

  const tracks = await container.readTracks();
  const audio = tracks.find((track) => track.type === "audio");

  assert.ok(audio, "the sound track is read");
  assert.equal(audio.codecId, "mp4a");
  assert.equal(audio.codecPrivateB64, LC_48K_STEREO.toString("base64"));
  assert.equal(audio.channels, 2);
  assert.equal(audio.samplingFrequency, 48000);
  assert.equal(audio.peakKbps, 576);
});

// ---- The inventory, and what a later reading adds ----

test("the bound travels from the container through the merge into the inventory", () => {
  const declared = new AudioTrack({
    trackNumber: 2, declaredIndex: 0, codecId: "A_AAC", codecPrivateB64: LC_48K_STEREO.toString("base64"), language: "jpn"
  });
  const merged = Container.mergeAudioFlags([{ index: 0, language: "jpn", codec: "aac", bitrateKbps: 128 }], [declared]);
  const [entry] = buildAudioInventory({ embedded: merged.tracks, videoFileIndex: 0, sidecars: [] });

  assert.equal(entry.peakKbps, 576);
  assert.equal(entry.bitrateKbps, 128, "the stated average stays beside it");
});

const entryWith = (codecParameters, extra = {}) => ({
  index: 1,
  fileIndex: 7,
  sourceTrackIndex: 0,
  kind: "sidecar",
  language: "rus",
  codecParameters,
  peakKbps: peakKbpsOf(codecParameters),
  ...extra
});

test("a later reading that says less keeps the bound already established", () => {
  const known = entryWith(aacParams(LC_48K_STEREO));
  const partial = entryWith({ codec: "aac", objectType: null, frameLength: null, channels: null, sampleRate: null }, { language: "" });

  const merged = mergeInventoryEntry(known, partial);

  assert.equal(merged.peakKbps, 576);
  assert.equal(merged.language, "rus", "an empty field of the new reading does not erase the old value");
});

test("a later reading that contradicts the known configuration withdraws the bound", () => {
  const known = entryWith(aacParams(LC_48K_STEREO));
  const contradicting = entryWith({ codec: "aac", objectType: null, frameLength: null, channels: null, sampleRate: 44100 });

  const merged = mergeInventoryEntry(known, contradicting);

  assert.equal(merged.codecParameters, null);
  assert.equal(merged.peakKbps, null);
});

test("a complete reading that contradicts the known one establishes neither, and the next complete one stands", () => {
  const known = entryWith(aacParams(LC_48K_STEREO));
  const other = entryWith(aacParams(LC_44K_STEREO));

  const contradicted = mergeInventoryEntry(known, other);
  assert.equal(contradicted.peakKbps, null, "two readings that disagree establish neither");

  const settled = mergeInventoryEntry(contradicted, other);
  assert.equal(settled.peakKbps, 529.2);
});

test("a complete reading that agrees replaces the configuration whole, and never moves the track", () => {
  const known = entryWith({ codec: "aac", objectType: 2, frameLength: null, channels: 2, sampleRate: 48000 });
  const complete = { ...entryWith(aacParams(LC_48K_STEREO)), index: 99, fileIndex: 99, sourceTrackIndex: 99, kind: "embedded" };

  const merged = mergeInventoryEntry(known, complete);

  assert.equal(merged.peakKbps, 576);
  assert.deepEqual(
    [merged.index, merged.fileIndex, merged.sourceTrackIndex, merged.kind],
    [1, 7, 0, "sidecar"],
    "the address a player uses stays"
  );
});

// ---- What the link is asked, and how a track is produced ----

test("a copied soundtrack weighs its codec's bound, else its stated rate, else nothing", () => {
  assert.deepEqual(soundtrackLoadOf({ peakKbps: 576, bitrateKbps: 128 }, false), { mbps: 0.576, peakClass: PEAK_CLASS.KNOWN });
  assert.deepEqual(soundtrackLoadOf({ peakKbps: null, bitrateKbps: 128 }, false), { mbps: 0.128, peakClass: PEAK_CLASS.ESTIMATED });
  assert.deepEqual(soundtrackLoadOf({ peakKbps: null, bitrateKbps: null }, false), { mbps: null, peakClass: PEAK_CLASS.UNKNOWN });
  assert.deepEqual(soundtrackLoadOf(null, false), { mbps: null, peakClass: PEAK_CLASS.UNKNOWN });
});

test("a re-encoded soundtrack weighs the rate it is asked for, as an estimate — ffmpeg's -b:a is a target", () => {
  assert.deepEqual(
    soundtrackLoadOf({ peakKbps: 576, bitrateKbps: 640 }, true),
    { mbps: AUDIO_TRANSCODE_KBPS / 1000, peakClass: PEAK_CLASS.ESTIMATED }
  );
  assert.equal(soundtrackLoadOf({ peakKbps: 576 }, null), null, "no sound, no part");
});

test("the field case: a dub with no stated rate on an 80 Mbit/s link is now re-encoded and fits", () => {
  // 2026-10-01, Drifters 06: picture 3.186 Mbit/s copied, the `Rus Sound` .mka
  // stating nothing. Copied, nothing can be compared; re-encoded, it can.
  const dub = { peakKbps: null, bitrateKbps: null };
  const picture = { mbps: 3.186, peakClass: PEAK_CLASS.ESTIMATED };

  const copied = linkCouldCarry(80.57, loadOf(picture, soundtrackLoadOf(dub, false)));
  assert.equal(copied.verdict, LINK_VERDICT.NO_SAFE_BOUND);

  const mode = chooseSoundtrackMode({ entry: dub, browserPlays: true, transcodeAllowed: true });
  assert.equal(mode.transcode, true);
  assert.equal(mode.cause, SOUNDTRACK_MODE_CAUSE.NO_FIGURE);
  const sent = linkCouldCarry(80.57, loadOf(picture, soundtrackLoadOf(dub, mode.transcode)));
  assert.equal(sent.admitted, true);
  assert.equal(sent.verdict, LINK_VERDICT.ESTIMATED_TO_FIT);
});

test("a track's mode follows from what the browser plays, whether it has a figure, and whether re-encoding is allowed", () => {
  const stated = { bitrateKbps: 128 };
  const bounded = { peakKbps: 576 };
  const silent = {};
  const mode = (entry, browserPlays, transcodeAllowed = true) =>
    chooseSoundtrackMode({ entry, browserPlays, transcodeAllowed });

  assert.deepEqual(mode(stated, true), { transcode: false, cause: SOUNDTRACK_MODE_CAUSE.COPY });
  assert.deepEqual(mode(bounded, true), { transcode: false, cause: SOUNDTRACK_MODE_CAUSE.COPY });
  assert.deepEqual(mode(silent, true), { transcode: true, cause: SOUNDTRACK_MODE_CAUSE.NO_FIGURE });
  assert.deepEqual(mode(stated, false), { transcode: true, cause: SOUNDTRACK_MODE_CAUSE.UNPLAYABLE });
  assert.deepEqual(mode(silent, true, false), { transcode: false, cause: SOUNDTRACK_MODE_CAUSE.COPY_WITHOUT_FIGURE });
  assert.deepEqual(mode(stated, false, false), { transcode: null, cause: SOUNDTRACK_MODE_CAUSE.CANNOT_SERVE });
});

test("a refusal with no figure names the part that has none", () => {
  const picture = { mbps: null, peakClass: PEAK_CLASS.UNKNOWN };
  const sound = { mbps: null, peakClass: PEAK_CLASS.UNKNOWN };
  const known = { mbps: 1, peakClass: PEAK_CLASS.KNOWN };

  assert.match(linkRefusalReason(linkCouldCarry(50, loadOf(known, sound)), "too big"), /how much the soundtrack would send/);
  assert.match(linkRefusalReason(linkCouldCarry(50, loadOf(picture, known)), "too big"), /how much the picture would send/);
  assert.match(linkRefusalReason(linkCouldCarry(50, loadOf(picture, sound)), "too big"), /the picture or the soundtrack/);
  assert.equal(linkRefusalReason(linkCouldCarry(0.5, loadOf(known, known)), "too big"), "too big");
});
