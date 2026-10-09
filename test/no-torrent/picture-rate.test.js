/**
 * @file What a copied picture is said to weigh, and where the figure comes
 * from (torrent-tv/meta#169).
 *
 * Field 2026-10-09: `Moana.2026.720p.rus.LostFilm.TV.mp4` was refused on a
 * measured 70.79 Mbit/s link with `videoMbps=null videoClass="unknown"`. The
 * picture's rate was the file's minus every soundtrack's, and neither the MP4
 * nor the Matroska reader stated a soundtrack's average, so every such file
 * with sound had no picture figure at all.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { MatroskaContainer } from "../../services/media/container/MatroskaContainer.js";
import { Mp4Container } from "../../services/media/container/Mp4Container.js";
import { trackRatesFromTags } from "../../services/media/container/matroska-work-tags.js";
import { BytesUnavailable, isUnavailable } from "../../services/media/container/unavailable.js";
import { playbackDeclarations } from "../../services/media/playback-declarations.js";
import { PICTURE_RATE_SOURCE, SourceFile, sourcePictureRate } from "../../services/media/SourceFile.js";
import { LINK_VERDICT, PEAK_CLASS, linkCouldCarry, loadOf, soundtrackLoadOf, videoLoadOfSpec } from "../../services/encode/quality/link-budget.js";
import { DELIVERY_KIND, DeliveryShares, deliveryKindOf } from "../../services/transport/delivery-shares.js";

// ---- MP4, built byte by byte -------------------------------------------------

function u32(...values) {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, at) => bytes.writeUInt32BE(value >>> 0, at * 4));
  return bytes;
}
const box = (type, bytes) => Buffer.concat([u32(bytes.length + 8), Buffer.from(type), bytes]);
const full = (type, bytes) => box(type, Buffer.concat([u32(0), bytes]));

/**
 * One track: its handler, sample entry, and a sample-size table.
 *
 * @param {{ id: number, handler: string, entry: Buffer, timescale: number, duration: number, sizes: number[] }} track
 */
function trak({ id, handler, entry, timescale, duration, sizes }) {
  const tkhd = full("tkhd", Buffer.concat([u32(0, 0, id, 0, duration), Buffer.alloc(60)]));
  const mdhd = full("mdhd", Buffer.concat([u32(0, 0, timescale, duration), Buffer.alloc(4)]));
  const hdlr = full("hdlr", Buffer.concat([u32(0), Buffer.from(handler), Buffer.alloc(12)]));
  const stsd = full("stsd", Buffer.concat([u32(1), entry]));
  const stts = full("stts", u32(1, sizes.length, duration / sizes.length));
  const stsz = full("stsz", u32(0, sizes.length, ...sizes));
  const stsc = full("stsc", u32(1, 1, sizes.length, 1));
  return box("trak", Buffer.concat([tkhd, box("mdia", Buffer.concat([
    mdhd, hdlr, box("minf", box("stbl", Buffer.concat([stsd, stts, stsz, stsc, full("stco", u32(1, 0))])))
  ]))]));
}

/** An `mp4a` sample entry: stereo, 48 kHz, no decoder configuration. */
function mp4a() {
  const body = Buffer.alloc(28);
  body.writeUInt16BE(1, 6);
  body.writeUInt16BE(2, 16);
  body.writeUInt16BE(16, 18);
  body.writeUInt32BE(48000 * 65536, 24);
  return box("mp4a", body);
}

function mp4File(tracks) {
  const ftyp = box("ftyp", Buffer.concat([Buffer.from("isom"), u32(0), Buffer.from("isom")]));
  return Buffer.concat([ftyp, box("moov", Buffer.concat(tracks.map(trak))), box("mdat", Buffer.alloc(16))]);
}

test("an MP4 track's rate is counted from the sizes of its own samples", async () => {
  // Ten seconds of picture: 1 000 000 bytes is 800 kbit/s. Ten seconds of
  // sound: 240 000 bytes is 192 kbit/s.
  const bytes = mp4File([
    { id: 1, handler: "vide", entry: box("avc1", Buffer.alloc(78)), timescale: 1000, duration: 10_000, sizes: [400_000, 300_000, 200_000, 100_000] },
    { id: 2, handler: "soun", entry: mp4a(), timescale: 48_000, duration: 480_000, sizes: [60_000, 60_000, 60_000, 60_000] }
  ]);
  const container = new Mp4Container({ readRange: async (a, b) => bytes.subarray(a, b + 1), fileSize: bytes.length });
  const tracks = await container.readTracks();
  const video = tracks.find((track) => track.type === "video");
  const audio = tracks.find((track) => track.type === "audio");
  assert.equal(video.bitrateKbps, 800);
  assert.equal(audio.bitrateKbps, 192);
});

test("a fragmented MP4, whose sample table lists nothing, states no track rate", async () => {
  const bytes = mp4File([
    { id: 1, handler: "vide", entry: box("avc1", Buffer.alloc(78)), timescale: 1000, duration: 10_000, sizes: [] }
  ]);
  const container = new Mp4Container({ readRange: async (a, b) => bytes.subarray(a, b + 1), fileSize: bytes.length });
  const [video] = await container.readTracks();
  assert.equal(video.bitrateKbps, null);
});

// ---- Matroska, built byte by byte --------------------------------------------

function ebml(id, payload) {
  const idBytes = Buffer.from(id.toString(16).padStart(id > 0xffffff ? 8 : id > 0xffff ? 6 : id > 0xff ? 4 : 2, "0"), "hex");
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length);
  size[0] |= 0x10;
  return Buffer.concat([idBytes, size, payload]);
}
const utf8 = (value) => Buffer.from(value, "utf8");
const uint = (value, bytes = 1) => {
  const out = Buffer.alloc(bytes);
  out.writeUIntBE(value, 0, bytes);
  return out;
};
const simpleTag = (name, value) => ebml(0x67c8, Buffer.concat([ebml(0x45a3, utf8(name)), ebml(0x4487, utf8(value))]));
/** mkvmerge's statistics tag for one track. */
const statistics = (uid, bps) => ebml(0x7373, Buffer.concat([
  ebml(0x63c0, Buffer.concat([ebml(0x68ca, uint(50)), ebml(0x63c5, uid)])),
  simpleTag("BPS", String(bps)), simpleTag("NUMBER_OF_BYTES", "123")
]));

// UIDs as mkvmerge writes them: eight random bytes, beyond what a number holds.
const VIDEO_UID = Buffer.from("9f3a51c2d4e6b708", "hex");
const AUDIO_UID = Buffer.from("e1d2c3b4a5968778", "hex");

function trackEntry({ number, uid, type, codec, extra }) {
  return ebml(0xae, Buffer.concat([ebml(0xd7, uint(number)), ebml(0x73c5, uid), ebml(0x83, uint(type)), ebml(0x86, utf8(codec)), extra]));
}

function matroska(elements) {
  const seekHeadFor = (positions) => ebml(0x114d9b74, Buffer.concat(elements.map(({ id }, index) =>
    ebml(0x4dbb, Buffer.concat([ebml(0x53ab, Buffer.from(id.toString(16), "hex")), ebml(0x53ac, uint(positions[index], 4))])))));
  const length = seekHeadFor(elements.map(() => 0)).length;
  const positions = [];
  let at = length;
  for (const { element } of elements) {
    positions.push(at);
    at += element.length;
  }
  const segment = Buffer.concat([seekHeadFor(positions), ...elements.map(({ element }) => element)]);
  return Buffer.concat([ebml(0x1a45dfa3, Buffer.alloc(4)), ebml(0x18538067, segment)]);
}

function matroskaWithStatistics() {
  const tracks = ebml(0x1654ae6b, Buffer.concat([
    trackEntry({ number: 1, uid: VIDEO_UID, type: 1, codec: "V_MPEG4/ISO/AVC",
      extra: ebml(0xe0, Buffer.concat([ebml(0xb0, uint(1920, 2)), ebml(0xba, uint(1080, 2))])) }),
    trackEntry({ number: 2, uid: AUDIO_UID, type: 2, codec: "A_AC3",
      extra: ebml(0xe1, ebml(0x9f, uint(6))) })
  ]));
  const tags = ebml(0x1254c367, Buffer.concat([statistics(VIDEO_UID, 4_812_345), statistics(AUDIO_UID, 448_000)]));
  const cluster = ebml(0x1f43b675, ebml(0xe7, uint(0)));
  // The statistics are written after the clusters, as mkvmerge does.
  return matroska([{ id: 0x1654ae6b, element: tracks }, { id: 0x1f43b675, element: cluster }, { id: 0x1254c367, element: tags }]);
}

test("mkvmerge's per-track statistics are read by TrackUID, all 64 bits of it", () => {
  const data = Buffer.concat([statistics(VIDEO_UID, 4_812_345), statistics(AUDIO_UID, 448_000)]);
  const rates = trackRatesFromTags(data);
  assert.equal(rates.get("9f3a51c2d4e6b708"), 4812.345);
  assert.equal(rates.get("e1d2c3b4a5968778"), 448);
});

test("a Matroska track carries the rate its statistics state", async () => {
  const bytes = matroskaWithStatistics();
  const container = new MatroskaContainer({ readRange: async (a, b) => bytes.subarray(a, Math.min(b + 1, bytes.length)), fileSize: bytes.length });
  const tracks = await container.readTracks();
  assert.equal(tracks.find((track) => track.type === "video").bitrateKbps, 4812.345);
  assert.equal(tracks.find((track) => track.type === "audio").bitrateKbps, 448);
});

test("statistics whose bytes have not arrived are not read as statistics the file lacks", async () => {
  const bytes = matroskaWithStatistics();
  // The Tags element is the last thing in the file; its id also appears in the
  // SeekHead, which is why the LAST occurrence is the element.
  const tagsAt = bytes.lastIndexOf(Buffer.from("1254c367", "hex"));
  let tailHeld = false;
  const readRange = async (a, b) => {
    if (!tailHeld && b >= tagsAt) throw new BytesUnavailable(a, b, 0);
    return bytes.subarray(a, Math.min(b + 1, bytes.length));
  };
  const container = new MatroskaContainer({ readRange, fileSize: bytes.length });
  await assert.rejects(container.readTracks(), (error) => isUnavailable(error));
  tailHeld = true;
  const tracks = await container.readTracks();
  assert.equal(tracks.find((track) => track.type === "audio").bitrateKbps, 448);
});

// ---- The one place a picture rate is chosen ----------------------------------

test("the picture's own rate comes first", () => {
  assert.deepEqual(
    sourcePictureRate({ videoBitrateKbps: 2051.4, bitrateKbps: 2400, audioTracks: [{ bitrateKbps: null }] }),
    { kbps: 2051, source: PICTURE_RATE_SOURCE.TRACK }
  );
});

test("the file minus its soundtracks, where every soundtrack states its rate", () => {
  assert.deepEqual(
    sourcePictureRate({ bitrateKbps: 2323, audioTracks: [{ bitrateKbps: 187 }] }),
    { kbps: 2136, source: PICTURE_RATE_SOURCE.FILE_MINUS_AUDIO }
  );
});

test("a soundtrack with no stated rate leaves the whole file's rate as the picture's bound", () => {
  assert.deepEqual(
    sourcePictureRate({ bitrateKbps: 2323, audioTracks: [{ bitrateKbps: 187 }, { bitrateKbps: null }] }),
    { kbps: 2323, source: PICTURE_RATE_SOURCE.FILE_BOUND }
  );
  assert.equal(sourcePictureRate({ audioTracks: [] }), null);
});

test("the field case: Moana's declarations now give its copied picture a figure, and the link admits it", () => {
  // As read on 2026-10-09: one MP4, an H.264 picture and an AAC soundtrack whose
  // only figure was its codec bound (0.576 Mbit/s). The picture's own rate is
  // what the sample table now states.
  const declarations = playbackDeclarations({
    media: { format: "mp4", durationSeconds: 6120, startTimeSeconds: 0, bitrateKbps: null },
    fileBytes: 1_900_000_000,
    tracks: [
      { type: "video", declaredIndex: 0, codecId: "avc1", isEnabled: true, width: 1280, height: 720, fps: 24, bitrateKbps: 2290 },
      { type: "audio", declaredIndex: 0, codecId: "mp4a", isEnabled: true, peakKbps: 576, bitrateKbps: 192, codecPrivateB64: "" }
    ]
  });
  const file = new SourceFile({ sourceKey: "torrent:b9c9b65b", fileIndex: 0 }).learn(declarations);
  assert.equal(file.pictureRate.source, PICTURE_RATE_SOURCE.TRACK);
  const spec = { video: { encode: null } };
  const load = loadOf(videoLoadOfSpec(spec, file.pictureKbps / 1000), soundtrackLoadOf({ peakKbps: 576 }, false));
  const answer = linkCouldCarry(70.79, load);
  assert.equal(answer.verdict, LINK_VERDICT.ESTIMATED_TO_FIT);
  assert.equal(load.video.peakClass, PEAK_CLASS.ESTIMATED);
});

// ---- What the connection carries besides the film ----------------------------

test("request paths are sorted into film, measurement and everything else", () => {
  assert.equal(deliveryKindOf("/transcode/abc/segment-00012.mp4"), DELIVERY_KIND.MEDIA);
  assert.equal(deliveryKindOf("/transcode/abc/a/0/init.mp4"), DELIVERY_KIND.MEDIA);
  assert.equal(deliveryKindOf("/transcode/abc/v/720/segment-00003.ts"), DELIVERY_KIND.MEDIA);
  assert.equal(deliveryKindOf("/api/link-probe?bytes=2097152"), DELIVERY_KIND.MEASUREMENT);
  assert.equal(deliveryKindOf("/transcode/abc/index.m3u8"), DELIVERY_KIND.SERVICE);
  assert.equal(deliveryKindOf("/api/transcode-sessions/abc/progress"), DELIVERY_KIND.SERVICE);
});

test("the share is everything accepted beyond the film and the measurements, per byte of film", () => {
  const shares = new DeliveryShares();
  assert.equal(shares.serviceShare(), null, "nothing delivered is not a share of zero");
  shares.recordBody("/api/link-probe", 2_000_000);
  shares.recordBody("/transcode/abc/segment-00001.mp4", 10_000_000);
  shares.recordBody("/transcode/abc/index.m3u8", 4_000);
  shares.recordSent(12_031_000);
  assert.equal(shares.serviceShare(), 0.0031);
});

test("the load carries the measured share on top of the film, and its class stays the film's", () => {
  const video = { mbps: 2, peakClass: PEAK_CLASS.KNOWN };
  const audio = { mbps: 0.5, peakClass: PEAK_CLASS.KNOWN };
  const plain = loadOf(video, audio);
  assert.equal(plain.totalMbps, 2.5);
  assert.equal(plain.serviceShare, null);
  const withService = loadOf(video, audio, 0.02);
  assert.equal(withService.serviceMbps, 0.05);
  assert.equal(withService.totalMbps, 2.55);
  assert.equal(withService.peakClass, PEAK_CLASS.KNOWN);
  assert.equal(linkCouldCarry(2.52, plain).verdict, LINK_VERDICT.FITS);
  assert.equal(linkCouldCarry(2.52, withService).verdict, LINK_VERDICT.DOES_NOT_FIT);
});
