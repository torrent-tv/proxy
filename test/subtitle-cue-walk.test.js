/**
 * @file What comes out of a real cluster walk, end to end.
 *
 * This is the check the walk never had. Everything around it was covered — the
 * numbering a track is asked for by, the framing one cue's bytes carry, the
 * thread a pull is answered on — and the walk itself, six hundred lines of it,
 * had none: a file is built here with real clusters carrying real blocks, and
 * the cues that come back out are stated exactly. Two field defects landed on
 * this path in one week; a move of this code without a check that would catch a
 * regression is a change nobody can verify.
 *
 * The four things asserted are the four the walk exists for: the text of each
 * cue with its times, the found-order cursor a browser follows, the rule that
 * only already-downloaded clusters are read, and the rule that one walk fills
 * every track of the file.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { cuesHeldFor, warmSubtitleCues, forgetSubtitles } from "../services/torrent-worker/subtitle-cues.js";

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
const ID_CUES = 0x1c53bb6b;
const ID_CUE_POINT = 0xbb;
const ID_CUE_TIME = 0xb3;
const ID_CUE_TRACK_POSITIONS = 0xb7;
const ID_CUE_TRACK = 0xf7;
const ID_CUE_CLUSTER_POSITION = 0xf1;
const ID_CLUSTER = 0x1f43b675;
const ID_TIMESTAMP = 0xe7;
const ID_BLOCK_GROUP = 0xa0;
const ID_BLOCK = 0xa1;
const ID_BLOCK_DURATION = 0x9b;

function idBytes(id) {
  const bytes = [];
  let rest = id;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  }
  return Buffer.from(bytes);
}

/** A four-byte size: a valid variable-length integer whatever the payload. */
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

/** A fixed four bytes, so a table measured twice comes out the same length. */
function uint32Element(id, value) {
  const payload = Buffer.alloc(4);
  payload.writeUInt32BE(value, 0);
  return element(id, payload);
}

function trackEntry({ number, type, codecId, language }) {
  return element(ID_TRACK_ENTRY, Buffer.concat([
    uintElement(ID_TRACK_NUMBER, number),
    uintElement(ID_TRACK_TYPE, type),
    stringElement(ID_CODEC_ID, codecId),
    stringElement(ID_LANGUAGE, language)
  ]));
}

/**
 * One cue, as a BlockGroup so it can carry its own duration.
 *
 * @param {{ track: number, relativeTicks: number, durationTicks: number, text: string }} params
 * @returns {Buffer}
 */
function cueBlock({ track, relativeTicks, durationTicks, text }) {
  const header = Buffer.alloc(4);
  header[0] = 0x80 | track; // track numbers under 128 are one byte, marker set
  header.writeInt16BE(relativeTicks, 1);
  header[3] = 0;
  const block = element(ID_BLOCK, Buffer.concat([header, Buffer.from(text, "utf8")]));
  return element(ID_BLOCK_GROUP, Buffer.concat([block, uintElement(ID_BLOCK_DURATION, durationTicks)]));
}

/**
 * A file with two text tracks and two clusters, each carrying a line for each
 * track.
 *
 * Track 2 is `S_TEXT/UTF8`, whose block payload IS the text. Track 3 is
 * `S_TEXT/ASS`, whose payload is the dialogue row without its `Dialogue:`
 * header — eight comma-separated fields and then the words, which is what
 * Matroska states and what the framing rule has to strip.
 *
 * @returns {{ file: Buffer, clusterAt: number[] }}
 */
function buildFile() {
  const info = element(ID_INFO, uintElement(ID_TIMESTAMP_SCALE, 1_000_000));
  const tracks = element(ID_TRACKS, Buffer.concat([
    trackEntry({ number: 1, type: 1, codecId: "V_MPEG4/ISO/AVC", language: "und" }),
    trackEntry({ number: 2, type: 17, codecId: "S_TEXT/UTF8", language: "eng" }),
    trackEntry({ number: 3, type: 17, codecId: "S_TEXT/ASS", language: "rus" })
  ]));

  const clusterOne = element(ID_CLUSTER, Buffer.concat([
    uintElement(ID_TIMESTAMP, 1000),
    cueBlock({ track: 2, relativeTicks: 0, durationTicks: 2000, text: "First English line" }),
    cueBlock({
      track: 3,
      relativeTicks: 500,
      durationTicks: 1500,
      // ReadOrder, Layer, Style, Name, MarginL, MarginR, MarginV, Effect,
      // then the text — the Dialogue row without its header and its timestamps.
      text: "1,0,Default,,0000,0000,0000,,Первая русская строка"
    })
  ]));
  const clusterTwo = element(ID_CLUSTER, Buffer.concat([
    uintElement(ID_TIMESTAMP, 10_000),
    cueBlock({ track: 2, relativeTicks: 0, durationTicks: 1000, text: "Second English line" }),
    cueBlock({
      track: 3,
      relativeTicks: 250,
      durationTicks: 1000,
      text: "2,0,Default,,0000,0000,0000,,Вторая, с запятой"
    })
  ]));

  const cuesWith = (firstAt, secondAt) => element(ID_CUES, Buffer.concat([
    element(ID_CUE_POINT, Buffer.concat([
      uintElement(ID_CUE_TIME, 1000),
      element(ID_CUE_TRACK_POSITIONS, Buffer.concat([
        uintElement(ID_CUE_TRACK, 2),
        uint32Element(ID_CUE_CLUSTER_POSITION, firstAt)
      ])),
      element(ID_CUE_TRACK_POSITIONS, Buffer.concat([
        uintElement(ID_CUE_TRACK, 3),
        uint32Element(ID_CUE_CLUSTER_POSITION, firstAt)
      ]))
    ])),
    element(ID_CUE_POINT, Buffer.concat([
      uintElement(ID_CUE_TIME, 10_000),
      element(ID_CUE_TRACK_POSITIONS, Buffer.concat([
        uintElement(ID_CUE_TRACK, 2),
        uint32Element(ID_CUE_CLUSTER_POSITION, secondAt)
      ])),
      element(ID_CUE_TRACK_POSITIONS, Buffer.concat([
        uintElement(ID_CUE_TRACK, 3),
        uint32Element(ID_CUE_CLUSTER_POSITION, secondAt)
      ]))
    ]))
  ]));

  const seekEntry = (targetId, position) => element(ID_SEEK, Buffer.concat([
    element(ID_SEEK_ID, idBytes(targetId)),
    uint32Element(ID_SEEK_POSITION, position)
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
  const firstClusterAt = cuesAt + cuesWith(0, 0).length;
  const secondClusterAt = firstClusterAt + clusterOne.length;

  const segmentPayload = Buffer.concat([
    seekHeadWith(infoAt, tracksAt, cuesAt),
    info,
    tracks,
    cuesWith(firstClusterAt, secondClusterAt),
    clusterOne,
    clusterTwo
  ]);
  const ebml = element(ID_EBML, Buffer.from([0x42, 0x86, 0x81, 0x01]));
  const segment = element(ID_SEGMENT, segmentPayload);
  const segmentDataOffset = ebml.length + segment.length - segmentPayload.length;
  return {
    file: Buffer.concat([ebml, segment]),
    clusterAt: [segmentDataOffset + firstClusterAt, segmentDataOffset + secondClusterAt]
  };
}

/**
 * A torrent over one file, holding whichever pieces the caller says.
 *
 * @param {Buffer} bytes
 * @param {(index: number) => boolean} [holds] - Whether a piece is downloaded.
 * @returns {{ torrent: object, reads: Array<{ start: number, end: number }>, pieceLength: number }}
 */
function torrentOver(bytes, holds = () => true) {
  const pieceLength = 64;
  const reads = [];
  const file = {
    name: "film.mkv",
    length: bytes.length,
    offset: 0,
    createReadStream({ start = 0, end = bytes.length - 1 } = {}) {
      reads.push({ start, end });
      return Readable.from((async function* chunks() {
        await new Promise((resolve) => setImmediate(resolve));
        yield bytes.subarray(start, end + 1);
      })());
    }
  };
  return {
    reads,
    pieceLength,
    torrent: {
      name: "film",
      pieceLength,
      bitfield: { get: (index) => holds(index) },
      files: [file]
    }
  };
}

test("a walk of a downloaded file gives up every cue, unframed, with its times", async () => {
  const { file } = buildFile();
  const { torrent } = torrentOver(file);
  const sourceKey = "a".repeat(40);
  forgetSubtitles(sourceKey);
  try {
    const plain = await cuesHeldFor(torrent, 0, sourceKey, 2);
    assert.deepEqual(
      plain.cues.map((cue) => [cue.startSeconds, cue.endSeconds, cue.text]),
      [
        [1, 3, "First English line"],
        [10, 11, "Second English line"]
      ]
    );

    const ass = await cuesHeldFor(torrent, 0, sourceKey, 3);
    assert.deepEqual(
      ass.cues.map((cue) => [cue.startSeconds, cue.endSeconds, cue.text]),
      [
        [1.5, 3, "Первая русская строка"],
        [10.25, 11.25, "Вторая, с запятой"]
      ],
      "the eight fields Matroska puts before the text are the container's framing, not the words"
    );
  } finally {
    forgetSubtitles(sourceKey);
  }
});

test("the cursor is the order cues were FOUND, and it never repeats", async () => {
  const { file } = buildFile();
  const { torrent } = torrentOver(file);
  const sourceKey = "b".repeat(40);
  forgetSubtitles(sourceKey);
  try {
    const held = await cuesHeldFor(torrent, 0, sourceKey, 2);
    const cursors = held.cues.map((cue) => cue.seq);
    assert.deepEqual(cursors, [1, 2], "two cues found, in the order they were read");
    assert.equal(new Set(cursors).size, cursors.length, "no cue shares a cursor with another");
  } finally {
    forgetSubtitles(sourceKey);
  }
});

test("a cluster whose bytes are not downloaded is left for next time", async () => {
  const { file, clusterAt } = buildFile();
  // Everything except the pieces the SECOND cluster sits in.
  const { torrent, pieceLength } = torrentOver(file, (index) => index * pieceLength < clusterAt[1]);
  const sourceKey = "c".repeat(40);
  forgetSubtitles(sourceKey);
  try {
    const held = await cuesHeldFor(torrent, 0, sourceKey, 2);
    assert.deepEqual(
      held.cues.map((cue) => cue.text),
      ["First English line"],
      "the downloaded cluster is read and the other is not — nothing is asked of the swarm"
    );
    assert.equal(held.coveredClusters, 1);
    assert.equal(held.indexedClusters, 2, "the file states two, and one is not here yet");
  } finally {
    forgetSubtitles(sourceKey);
  }
});

test("one walk fills every track, and a second call reads no cluster again", async () => {
  const { file, clusterAt } = buildFile();
  const { torrent, reads } = torrentOver(file);
  const sourceKey = "d".repeat(40);
  forgetSubtitles(sourceKey);
  try {
    await cuesHeldFor(torrent, 0, sourceKey, 2);
    const clusterReads = reads.filter((range) => clusterAt.includes(range.start)).length;

    const other = await cuesHeldFor(torrent, 0, sourceKey, 3);
    assert.equal(other.cues.length, 2, "the other track was filled by the same walk");
    assert.equal(
      reads.filter((range) => clusterAt.includes(range.start)).length,
      clusterReads,
      "asking for the second track reads no cluster a second time"
    );
  } finally {
    forgetSubtitles(sourceKey);
  }
});

test("the warm pass reports what is new, by the number the browser knows", async () => {
  const { file } = buildFile();
  const { torrent } = torrentOver(file);
  const sourceKey = "e".repeat(40);
  forgetSubtitles(sourceKey);
  try {
    const first = await warmSubtitleCues(torrent, 0, sourceKey);
    assert.deepEqual(
      first.map((entry) => [entry.trackIndex, entry.cues.length, entry.language]).sort(),
      [[0, 2, "eng"], [1, 2, "rus"]].sort(),
      "both text tracks gained two cues, numbered as ffmpeg numbers them"
    );

    const again = await warmSubtitleCues(torrent, 0, sourceKey);
    assert.deepEqual(again, [], "nothing is new the second time round");
  } finally {
    forgetSubtitles(sourceKey);
  }
});

test("a torrent that cannot say which pieces it holds is refused, not answered emptily", async () => {
  const { file } = buildFile();
  const { torrent } = torrentOver(file);
  const sourceKey = "f".repeat(40);
  forgetSubtitles(sourceKey);
  try {
    const held = await cuesHeldFor({ ...torrent, bitfield: null }, 0, sourceKey, 2);
    assert.deepEqual(held.cues, []);
    assert.equal(held.track, null, "the answer says nothing was read, not that there is nothing");
  } finally {
    forgetSubtitles(sourceKey);
  }
});
