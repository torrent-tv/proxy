/**
 * @file The number a subtitle track is asked for by, and one walk per file.
 *
 * Two rules, both found by reading on 2026-08-26 after the report that embedded
 * subtitles appear late (`research/subtitle-delay-2026-08-26.md`):
 *
 * 1. The browser names a track by ffmpeg's `0:s:N`, which counts EVERY subtitle
 *    stream. The container plan drops the picture-based ones — PGS, VobSub —
 *    because they cannot become WebVTT, so counting the kept ones is a
 *    different numbering as soon as a file carries one of each. What that cost:
 *    the push landed on a track the browser does not know, and the browser's
 *    own request found no track at all and fell through to the ffmpeg
 *    extraction, which reads the whole film (752 s measured, 2026-08-19).
 * 2. A file is walked once at a time. The walk marks a cluster as read only
 *    after two suspension points, and it is started both on every verified
 *    piece and on a 3 s timer, so two passes could read and parse the same
 *    cluster and push the same line twice.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { MatroskaContainer } from "../services/container/MatroskaContainer.js";
import { cuesHeldFor, forgetSubtitles } from "../services/torrent-worker/subtitle-cues.js";

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_SEEK_HEAD = 0x114d9b74;
const ID_SEEK = 0x4dbb;
const ID_SEEK_ID = 0x53ab;
const ID_SEEK_POSITION = 0x53ac;
const ID_INFO = 0x1549a966;
const ID_TIMESTAMP_SCALE = 0x2ad7b1;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_NUMBER = 0xd7;
const ID_TRACK_TYPE = 0x83;
const ID_CODEC_ID = 0x86;
const ID_LANGUAGE = 0x22b59c;
const ID_LANGUAGE_BCP47 = 0x22b59d;
const ID_FLAG_ENABLED = 0xb9;
const ID_FLAG_FORCED = 0x55aa;
const ID_FLAG_HEARING_IMPAIRED = 0x55ab;
const ID_CUES = 0x1c53bb6b;
const ID_CUE_POINT = 0xbb;
const ID_CUE_TIME = 0xb3;
const ID_CUE_TRACK_POSITIONS = 0xb7;
const ID_CUE_TRACK = 0xf7;
const ID_CUE_CLUSTER_POSITION = 0xf1;
const ID_CLUSTER = 0x1f43b675;
const ID_TIMESTAMP = 0xe7;

/** An element id, as the bytes the specification gives it. */
function idBytes(id) {
  const bytes = [];
  let rest = id;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  }
  return Buffer.from(bytes);
}

/** A size, as a four-byte EBML variable-length integer. */
function sizeBytes(size) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(size, 0);
  buffer[0] |= 0x10;
  return buffer;
}

function element(id, payload) {
  return Buffer.concat([idBytes(id), sizeBytes(payload.length), payload]);
}

function uintElement(id, value) {
  const bytes = [];
  let rest = value;
  do {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  } while (rest > 0);
  return element(id, Buffer.from(bytes));
}

function stringElement(id, value) {
  return element(id, Buffer.from(value, "utf8"));
}

/**
 * An unsigned value at a FIXED four bytes. A cue's cluster position has to be
 * written twice — once to measure the table, once with the position that
 * measurement produced — and a value-sized element would make the second table
 * a different length from the first, moving the very cluster it names.
 */
function uint32Element(id, value) {
  const payload = Buffer.alloc(4);
  payload.writeUInt32BE(value, 0);
  return element(id, payload);
}

function trackEntry({ number, type, codecId, language, flags = {}, languageBcp47 = null }) {
  const parts = [
    uintElement(ID_TRACK_NUMBER, number),
    uintElement(ID_TRACK_TYPE, type),
    stringElement(ID_CODEC_ID, codecId),
    stringElement(ID_LANGUAGE, language)
  ];
  if (languageBcp47 !== null) {
    parts.push(stringElement(ID_LANGUAGE_BCP47, languageBcp47));
  }
  for (const [id, value] of [
    [ID_FLAG_ENABLED, flags.enabled],
    [ID_FLAG_FORCED, flags.forced],
    [ID_FLAG_HEARING_IMPAIRED, flags.hearingImpaired]
  ]) {
    if (value !== undefined) {
      parts.push(uintElement(id, value ? 1 : 0));
    }
  }
  return element(ID_TRACK_ENTRY, Buffer.concat(parts));
}

/**
 * A file whose subtitle tracks are, in the container's own order: a picture
 * one, then two text ones. ffmpeg numbers those `0:s:0`, `0:s:1`, `0:s:2`;
 * the plan can only read the last two.
 *
 * The Cues table points both text tracks at one cluster, which is written after
 * the table so its position can be stated.
 *
 * @returns {{ file: Buffer, clusterAt: number }}
 */
function buildFile() {
  const info = element(ID_INFO, uintElement(ID_TIMESTAMP_SCALE, 1_000_000));
  const tracks = element(ID_TRACKS, Buffer.concat([
    trackEntry({ number: 1, type: 1, codecId: "V_MPEG4/ISO/AVC", language: "und" }),
    trackEntry({ number: 2, type: 17, codecId: "S_HDMV/PGS", language: "eng" }),
    trackEntry({ number: 3, type: 17, codecId: "S_TEXT/UTF8", language: "rus" }),
    trackEntry({ number: 4, type: 17, codecId: "S_TEXT/ASS", language: "eng" })
  ]));

  // Built twice: the cue points state where the cluster is, and that position
  // is only known once everything before it has its final length. Every size
  // and position here is written at a fixed width, so the draft and the final
  // table are the same length.
  const cuesWith = (clusterAt) => element(ID_CUES, Buffer.concat([
    element(ID_CUE_POINT, Buffer.concat([
      uintElement(ID_CUE_TIME, 1000),
      element(ID_CUE_TRACK_POSITIONS, Buffer.concat([
        uintElement(ID_CUE_TRACK, 3),
        uint32Element(ID_CUE_CLUSTER_POSITION, clusterAt)
      ])),
      element(ID_CUE_TRACK_POSITIONS, Buffer.concat([
        uintElement(ID_CUE_TRACK, 4),
        uint32Element(ID_CUE_CLUSTER_POSITION, clusterAt)
      ]))
    ]))
  ]));

  const seekEntry = (targetId, position) => element(ID_SEEK, Buffer.concat([
    element(ID_SEEK_ID, idBytes(targetId)),
    element(ID_SEEK_POSITION, (() => {
      const buffer = Buffer.alloc(4);
      buffer.writeUInt32BE(position, 0);
      return buffer;
    })())
  ]));
  const seekHeadWith = (infoAt, tracksAt, cuesAt) => element(ID_SEEK_HEAD, Buffer.concat([
    seekEntry(ID_INFO, infoAt),
    seekEntry(ID_TRACKS, tracksAt),
    seekEntry(ID_CUES, cuesAt)
  ]));

  const headLength = seekHeadWith(0, 0, 0).length;
  const infoAt = headLength;
  const tracksAt = infoAt + info.length;
  const cuesAt = tracksAt + tracks.length;
  // A position in the Cues table is measured from the Segment's payload, and so
  // is the one the reader turns it into.
  const clusterRelative = cuesAt + cuesWith(0).length;

  // Enough of a cluster to be read and recognised: its own header and a
  // timestamp. No blocks, so it yields no cues — what the walk test counts is
  // that its bytes are fetched once, and that does not depend on their content.
  const cluster = element(ID_CLUSTER, uintElement(ID_TIMESTAMP, 1000));

  const segmentPayload = Buffer.concat([
    seekHeadWith(infoAt, tracksAt, cuesAt),
    info,
    tracks,
    cuesWith(clusterRelative),
    cluster
  ]);
  const ebml = element(ID_EBML, Buffer.from([0x42, 0x86, 0x81, 0x01]));
  const segment = element(ID_SEGMENT, segmentPayload);
  const segmentDataOffset = ebml.length + segment.length - segmentPayload.length;
  return {
    file: Buffer.concat([ebml, segment]),
    clusterAt: segmentDataOffset + clusterRelative
  };
}

function readerOver(file) {
  return async (start, end) => {
    const last = Math.min(end, file.length - 1);
    return start > last ? null : file.subarray(start, last + 1);
  };
}

test("a text track is numbered as ffmpeg numbers it, past the picture ones", async () => {
  const { file } = buildFile();

  const plan = await MatroskaContainer.readSubtitlePlan(readerOver(file), file.length);

  assert.equal(plan.declared.length, 3, "all three subtitle tracks are declared");
  assert.deepEqual(plan.tracks.map((track) => track.trackNumber), [3, 4], "only the text ones are readable");
  assert.deepEqual(
    plan.tracks.map((track) => track.declaredIndex),
    [1, 2],
    "the PGS track is 0:s:0, so the text tracks are 0:s:1 and 0:s:2 — not 0 and 1"
  );
});

/**
 * A torrent holding one file entirely, counting the byte ranges read from it.
 *
 * @param {Buffer} bytes
 * @returns {{ torrent: object, reads: Array<{ start: number, end: number }> }}
 */
function torrentOver(bytes) {
  const reads = [];
  const file = {
    name: "film.mkv",
    length: bytes.length,
    offset: 0,
    createReadStream({ start = 0, end = bytes.length - 1 } = {}) {
      reads.push({ start, end });
      // Asynchronous on purpose: a read that resolves in the same tick would
      // hide exactly the interleaving this test is about.
      return Readable.from((async function* chunks() {
        await new Promise((resolve) => setImmediate(resolve));
        yield bytes.subarray(start, end + 1);
      })());
    }
  };
  return {
    reads,
    torrent: {
      pieceLength: 1024,
      bitfield: { get: () => true },
      files: [file]
    }
  };
}

test("two walks of one file at the same time read each cluster once", async () => {
  const { file, clusterAt } = buildFile();
  const { torrent, reads } = torrentOver(file);
  const sourceKey = "torrent:numbering-test";
  forgetSubtitles(sourceKey);

  // Both text tracks at once, which is what the warmup does on every verified
  // piece and every three seconds.
  const [first, second] = await Promise.all([
    cuesHeldFor(torrent, 0, sourceKey, 3),
    cuesHeldFor(torrent, 0, sourceKey, 4)
  ]);

  assert.equal(first.coveredClusters, 1, "the cluster the table names was walked");
  assert.equal(second.coveredClusters, 1, "and the second track sees the same walk, not its own");
  const clusterReads = reads.filter((range) => range.start === clusterAt);
  assert.equal(
    clusterReads.length,
    2,
    "one probe of the cluster's header and one read of its body — not two of each"
  );
  forgetSubtitles(sourceKey);
});

/**
 * A file whose subtitle tracks carry the flags RFC 9559 defines for them: one
 * forced, one for viewers who cannot hear, one the file marks unusable, and one
 * writing its language as RFC 5646 alongside the three-letter code.
 *
 * @returns {Buffer}
 */
function fileWithFlags() {
  const info = element(ID_INFO, uintElement(ID_TIMESTAMP_SCALE, 1_000_000));
  const tracks = element(ID_TRACKS, Buffer.concat([
    trackEntry({ number: 1, type: 1, codecId: "V_MPEG4/ISO/AVC", language: "und" }),
    trackEntry({ number: 2, type: 17, codecId: "S_TEXT/UTF8", language: "rus", flags: { forced: true } }),
    trackEntry({ number: 3, type: 17, codecId: "S_TEXT/UTF8", language: "eng", flags: { hearingImpaired: true } }),
    trackEntry({ number: 4, type: 17, codecId: "S_TEXT/UTF8", language: "fre", flags: { enabled: false } }),
    trackEntry({ number: 5, type: 17, codecId: "S_TEXT/ASS", language: "por", languageBcp47: "pt-BR" })
  ]));
  const seekEntry = (targetId, position) => element(ID_SEEK, Buffer.concat([
    element(ID_SEEK_ID, idBytes(targetId)),
    uint32Element(ID_SEEK_POSITION, position)
  ]));
  const seekHeadWith = (infoAt, tracksAt) => element(ID_SEEK_HEAD, Buffer.concat([
    seekEntry(ID_INFO, infoAt),
    seekEntry(ID_TRACKS, tracksAt)
  ]));
  const headLength = seekHeadWith(0, 0).length;
  const segmentPayload = Buffer.concat([
    seekHeadWith(headLength, headLength + info.length),
    info,
    tracks
  ]);
  const ebml = element(ID_EBML, Buffer.from([0x42, 0x86, 0x81, 0x01]));
  return Buffer.concat([ebml, element(ID_SEGMENT, segmentPayload)]);
}

test("the flags the file states about a track are read, not guessed from its name", async () => {
  const plan = await MatroskaContainer.readSubtitlePlan(readerOver(fileWithFlags()), fileWithFlags().length);

  const forced = plan.tracks.find((track) => track.trackNumber === 2);
  assert.equal(forced.isForced, true, "FlagForced 0x55AA");
  assert.equal(forced.isHearingImpaired, false);

  const sdh = plan.tracks.find((track) => track.trackNumber === 3);
  assert.equal(sdh.isHearingImpaired, true, "FlagHearingImpaired 0x55AB");
  assert.equal(sdh.isForced, false);
});

test("a track the file marks unusable is not offered, but is still counted", async () => {
  // FlagEnabled (0xB9): "Set to 1 if the track is usable." Track 4 says 0, so
  // it is not offered — but it KEEPS its place in the numbering, because ffmpeg
  // keeps it: `matroskadec.c` parses MATROSKA_ID_TRACKFLAGENABLED as EBML_NONE,
  // reading the element and storing nothing, so the stream is created and gets
  // its own `0:s:N`. Dropping it here would shift every track after it.
  const plan = await MatroskaContainer.readSubtitlePlan(readerOver(fileWithFlags()), fileWithFlags().length);

  assert.equal(plan.tracks.some((track) => track.trackNumber === 4), false, "not offered for extraction");
  const counted = plan.declared.find((track) => track.trackNumber === 4);
  assert.ok(counted, "still declared, so the numbering does not move");
  assert.equal(counted.isEnabled, false);
});

test("an unusable track keeps its place, so the tracks after it keep theirs", async () => {
  const plan = await MatroskaContainer.readSubtitlePlan(readerOver(fileWithFlags()), fileWithFlags().length);

  // s:0 forced, s:1 SDH, s:2 the unusable one, s:3 the Brazilian track.
  assert.deepEqual(
    plan.tracks.map((track) => [track.trackNumber, track.declaredIndex]),
    [[2, 0], [3, 1], [5, 3]]
  );
});

test("the list ffmpeg is lined up against still speaks ffmpeg's language codes", async () => {
  // `declared` exists to be paired with the `-i` banner, which prints the
  // three-letter code; reporting "pt-BR" there would break the pairing and cost
  // the FlagDefault reading with it.
  const plan = await MatroskaContainer.readSubtitlePlan(readerOver(fileWithFlags()), fileWithFlags().length);

  const declared = plan.declared.find((track) => track.trackNumber === 5);
  assert.equal(declared.language, "por");
  assert.equal(declared.languageBcp47, "pt-BR");
});

test("where the file writes RFC 5646, that is the language", async () => {
  // "If this element is used, then any Language elements used in the same
  // TrackEntry MUST be ignored."
  const plan = await MatroskaContainer.readSubtitlePlan(readerOver(fileWithFlags()), fileWithFlags().length);

  const track = plan.tracks.find((entry) => entry.trackNumber === 5);
  assert.equal(track.language, "pt-BR", "not the three-letter por");
  assert.equal(track.languageBcp47, "pt-BR");
});
