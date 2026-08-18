/**
 * @file The container's table names a track, and only the picture's entries are
 * cut points.
 *
 * Measured 2026-08-18 on the two files the field sessions were recorded from:
 * `Minions.and.Monsters.1080p.mkv` carries 2778 cue entries for its video track
 * — one every 2.002 s — and 4669 more across four subtitle tracks;
 * `Moana.2 … MegaPeer.mkv` carries 1055 for video and 5007 across five subtitle
 * tracks. Read without the track, both sets went into the cut list together,
 * and ffmpeg — which can only cut a copied picture at a real keyframe at or
 * after the time it is asked for — moved every such cut forward to the next
 * keyframe. That is the whole of the disagreement the field reported: 2.002 s
 * on the first file, a median of 6.3 s and a worst case of 21 s on the second,
 * and never once negative.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readMatroskaKeyframeTimes } from "../services/container-index/matroska.js";

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
const ID_CUES = 0x1c53bb6b;
const ID_CUE_POINT = 0xbb;
const ID_CUE_TIME = 0xb3;
const ID_CUE_TRACK_POSITIONS = 0xb7;
const ID_CUE_TRACK = 0xf7;
const ID_CUE_CLUSTER_POSITION = 0xf1;

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

/** An unsigned value, in as few bytes as it needs. */
function uintElement(id, value) {
  const bytes = [];
  let rest = value;
  do {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  } while (rest > 0);
  return element(id, Buffer.from(bytes));
}

function cuePoint(timeMs, tracks) {
  return element(ID_CUE_POINT, Buffer.concat([
    uintElement(ID_CUE_TIME, timeMs),
    ...tracks.map((track) => element(ID_CUE_TRACK_POSITIONS, Buffer.concat([
      uintElement(ID_CUE_TRACK, track),
      uintElement(ID_CUE_CLUSTER_POSITION, 4096)
    ])))
  ]));
}

/**
 * A file with the shape the field files have: one picture, one set of subtitles,
 * and a table that indexes both.
 *
 * @param {{ withTracks?: boolean }} [options]
 * @returns {Buffer}
 */
function buildFile({ withTracks = true, cueTrack = null } = {}) {
  const info = element(ID_INFO, uintElement(ID_TIMESTAMP_SCALE, 1_000_000));
  const tracks = element(ID_TRACKS, Buffer.concat([
    element(ID_TRACK_ENTRY, Buffer.concat([
      uintElement(ID_TRACK_NUMBER, 1),
      uintElement(ID_TRACK_TYPE, 1) // video
    ])),
    element(ID_TRACK_ENTRY, Buffer.concat([
      uintElement(ID_TRACK_NUMBER, 2),
      uintElement(ID_TRACK_TYPE, 17) // subtitles
    ]))
  ]));
  const forPicture = cueTrack ?? 1;
  const forSubtitles = cueTrack ?? 2;
  const cues = element(ID_CUES, Buffer.concat([
    cuePoint(0, [forPicture]),
    cuePoint(1070, [forSubtitles]),
    cuePoint(2002, [forPicture]),
    cuePoint(3141, [forSubtitles]),
    cuePoint(4004, [forPicture])
  ]));

  const seekEntry = (targetId, position) => element(ID_SEEK, Buffer.concat([
    element(ID_SEEK_ID, idBytes(targetId)),
    element(ID_SEEK_POSITION, (() => {
      const buffer = Buffer.alloc(4);
      buffer.writeUInt32BE(position, 0);
      return buffer;
    })())
  ]));
  // Positions are relative to the Segment's payload, so the SeekHead has to be
  // measured before they can be stated. Its own length does not change when the
  // placeholders become real values: every size and position here is written at
  // a fixed width.
  const draft = element(ID_SEEK_HEAD, Buffer.concat([
    seekEntry(ID_INFO, 0),
    ...(withTracks ? [seekEntry(ID_TRACKS, 0)] : []),
    seekEntry(ID_CUES, 0)
  ]));
  const infoAt = draft.length;
  const tracksAt = infoAt + info.length;
  const cuesAt = withTracks ? tracksAt + tracks.length : infoAt + info.length;
  const seekHead = element(ID_SEEK_HEAD, Buffer.concat([
    seekEntry(ID_INFO, infoAt),
    ...(withTracks ? [seekEntry(ID_TRACKS, tracksAt)] : []),
    seekEntry(ID_CUES, cuesAt)
  ]));

  const segmentPayload = Buffer.concat(
    withTracks ? [seekHead, info, tracks, cues] : [seekHead, info, cues]
  );
  return Buffer.concat([
    element(ID_EBML, Buffer.from([0x42, 0x86, 0x81, 0x01])),
    element(ID_SEGMENT, segmentPayload)
  ]);
}

function readerOver(file) {
  return async (start, end) => {
    const last = Math.min(end, file.length - 1);
    return start > last ? null : file.subarray(start, last + 1);
  };
}

test("only the picture's entries become cut times", async () => {
  const file = buildFile();

  const times = await readMatroskaKeyframeTimes(readerOver(file), file.length);

  assert.deepEqual(
    times.map((time) => Number(time.toFixed(3))),
    [0, 2.002, 4.004],
    "the subtitle entries at 1.070 and 3.141 are not keyframes, and a cut asked for there lands late"
  );
});

test("a table whose entries name no known track is still used", async () => {
  // The cue points reference track 9, which Tracks never declares. Filtering
  // leaves nothing — and returning nothing would put an even grid on a copied
  // picture, the failure this reader exists to prevent.
  const file = buildFile({ cueTrack: 9 });

  const times = await readMatroskaKeyframeTimes(readerOver(file), file.length);

  assert.deepEqual(
    times.map((time) => Number(time.toFixed(3))),
    [0, 1.07, 2.002, 3.141, 4.004],
    "an unrecognised table beats no table at all"
  );
});

test("a file whose tracks cannot be read keeps every entry", async () => {
  const file = buildFile({ withTracks: false });

  const times = await readMatroskaKeyframeTimes(readerOver(file), file.length);

  assert.deepEqual(
    times.map((time) => Number(time.toFixed(3))),
    [0, 1.07, 2.002, 3.141, 4.004],
    "with nothing to tell the tracks apart, the old behaviour is the only one available"
  );
});
