/**
 * @file Keyframe index for Matroska (MKV/WebM), read without downloading the file.
 *
 * Matroska stores a Cues element — a table of "at time T, a keyframe starts at
 * byte P" — and a SeekHead near the start listing where each top-level element
 * lives. So two point reads suffice: the head, to learn where Cues is, then
 * Cues itself. Measured on a 5.5 GB torrent-backed file: 4 KB + 12 KB, both
 * effectively instant, versus a full packet scan that found 77 keyframes in
 * 45 s and never finished.
 *
 * This matters because on the video-COPY path the encoder can only cut on the
 * source's own keyframes. A playlist declaring an even grid is then a lie, and
 * players react badly to it — either walking the whole file to rebuild the
 * timeline, or presenting audio with no picture because a segment begins with
 * no keyframe to decode from (both observed in the field 2026-08-02).
 */

import { findElement, iterateElements, readUint } from "./ebml-reader.js";

// Element ids, from the Matroska specification.
const ID_SEGMENT = 0x18538067;
const ID_SEEK_HEAD = 0x114d9b74;
const ID_SEEK = 0x4dbb;
const ID_SEEK_ID = 0x53ab;
const ID_SEEK_POSITION = 0x53ac;
const ID_INFO = 0x1549a966;
const ID_TIMESTAMP_SCALE = 0x2ad7b1;
const ID_CUES = 0x1c53bb6b;
const ID_CUE_POINT = 0xbb;
const ID_CUE_TIME = 0xb3;
const ID_CUE_TRACK_POSITIONS = 0xb7;
const ID_CUE_TRACK = 0xf7;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_NUMBER = 0xd7;
const ID_TRACK_TYPE = 0x83;
// TrackType 1 is video; 2 is audio, 17 subtitles, and the rest are rarer still.
const TRACK_TYPE_VIDEO = 1;

// How much of the file start to read. Must cover the EBML header, the SeekHead
// and Info; 64 KB is generous for every real muxer (the file measured needed
// under 4 KB) while still trivial to fetch.
const HEAD_BYTES = 64 * 1024;
// Cap on the Cues read. A two-hour film indexes to tens of KB; anything beyond
// this is not a normal index and not worth pulling over a torrent.
const MAX_CUES_BYTES = 8 * 1024 * 1024;
// Cap on a Tracks read, for the rare file whose Tracks element sits outside the
// head window. Track entries are small, so a file with dozens of them still
// fits well inside this.
const MAX_TRACKS_BYTES = 1024 * 1024;
// Matroska's default timestamp scale (nanoseconds per tick) when Info omits it.
const DEFAULT_TIMESTAMP_SCALE = 1_000_000;

/**
 * Whether this looks like a Matroska file (the EBML magic `0x1A45DFA3`).
 *
 * @param {Buffer} head
 * @returns {boolean}
 */
export function isMatroska(head) {
  return head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3;
}

/**
 * Locate the Segment element and the SeekHead entries inside it.
 *
 * Seek positions are relative to the start of Segment's payload, not to the
 * file, so that base has to come back with them.
 *
 * @param {Buffer} head
 * @returns {{ segmentDataOffset: number, entries: Map<number, number> } | null}
 */
function readSeekHead(head) {
  let segmentDataOffset = -1;
  for (const element of iterateElements(head)) {
    if (element.id === ID_SEGMENT) {
      segmentDataOffset = element.dataOffset;
      break;
    }
  }
  if (segmentDataOffset < 0) {
    return null;
  }

  const seekHead = findElement(head, ID_SEEK_HEAD, [], segmentDataOffset);
  if (!seekHead) {
    return null;
  }

  const entries = new Map();
  const seekHeadEnd = Math.min(head.length, seekHead.dataOffset + seekHead.size);
  for (const seek of iterateElements(head, seekHead.dataOffset, seekHeadEnd)) {
    if (seek.id !== ID_SEEK) {
      continue;
    }
    const seekEnd = Math.min(seekHeadEnd, seek.dataOffset + seek.size);
    let targetId = null;
    let position = null;
    for (const field of iterateElements(head, seek.dataOffset, seekEnd)) {
      if (field.id === ID_SEEK_ID) {
        targetId = readUint(head, field.dataOffset, field.size);
      } else if (field.id === ID_SEEK_POSITION) {
        position = readUint(head, field.dataOffset, field.size);
      }
    }
    if (targetId !== null && position !== null) {
      entries.set(targetId, position);
    }
  }
  return { segmentDataOffset, entries };
}

/**
 * Timestamp scale (nanoseconds per tick) declared in Info, or the default.
 *
 * @param {Buffer} head
 * @param {number} segmentDataOffset
 * @returns {number}
 */
function readTimestampScale(head, segmentDataOffset) {
  const info = findElement(head, ID_INFO, [], segmentDataOffset);
  if (!info) {
    return DEFAULT_TIMESTAMP_SCALE;
  }
  const infoEnd = Math.min(head.length, info.dataOffset + info.size);
  for (const field of iterateElements(head, info.dataOffset, infoEnd)) {
    if (field.id === ID_TIMESTAMP_SCALE) {
      const scale = readUint(head, field.dataOffset, field.size);
      return scale > 0 ? scale : DEFAULT_TIMESTAMP_SCALE;
    }
  }
  return DEFAULT_TIMESTAMP_SCALE;
}

/**
 * The number of the first video track, from a Tracks payload.
 *
 * The FIRST one, because that is the track ffmpeg is told to copy (`0:v:0`).
 *
 * @param {Buffer} buffer
 * @param {{ dataOffset: number, size: number }} tracks
 * @returns {number | null}
 */
function readVideoTrackNumber(buffer, tracks) {
  const tracksEnd = Math.min(buffer.length, tracks.dataOffset + tracks.size);
  for (const entry of iterateElements(buffer, tracks.dataOffset, tracksEnd)) {
    if (entry.id !== ID_TRACK_ENTRY) {
      continue;
    }
    const entryEnd = Math.min(tracksEnd, entry.dataOffset + entry.size);
    let number = null;
    let type = null;
    for (const field of iterateElements(buffer, entry.dataOffset, entryEnd)) {
      if (field.id === ID_TRACK_NUMBER) {
        number = readUint(buffer, field.dataOffset, field.size);
      } else if (field.id === ID_TRACK_TYPE) {
        type = readUint(buffer, field.dataOffset, field.size);
      }
    }
    if (number !== null && type === TRACK_TYPE_VIDEO) {
      return number;
    }
  }
  return null;
}

/**
 * Cue times (seconds, ascending) of ONE track, from a Cues payload.
 *
 * The track is the whole point, and leaving it out is what this reader got
 * wrong until 2026-08-18. A CuePoint belongs to the track named inside its
 * CueTrackPositions, and a muxer indexes whatever tracks it likes: RFC 9559
 * says each keyframe of a video track SHOULD be referenced, and that the Cues
 * Element "can be used to index every single timestamp of every Block or they
 * can be indexed selectively". Both field files index their SUBTITLE tracks as
 * well — `Minions.and.Monsters.1080p.mkv` has 2778 video entries every 2.002 s
 * plus 4669 across four subtitle tracks; `Moana.2 … MegaPeer.mkv` has 1055
 * video entries plus 5007 across five.
 *
 * Read without the track, those extra times enter the cut list as though they
 * were keyframes. ffmpeg can only cut a COPIED picture at a real keyframe at or
 * after the time it is given, so every cut asked for at one of them lands late
 * — which is exactly what the field measured: on the first file every deviation
 * was 2.002 s, that file's own keyframe spacing, and on the second the median
 * was 6.3 s with a worst case of 21 s. Never once negative.
 *
 * @param {Buffer} cues
 * @param {number} timestampScale - Nanoseconds per tick.
 * @param {number | null} trackNumber - Null keeps every entry, which is right
 *   only for a file that indexes one track.
 * @returns {number[]}
 */
function readCueTimes(cues, timestampScale, trackNumber) {
  const times = [];
  const secondsPerTick = timestampScale / 1e9;
  for (const point of iterateElements(cues)) {
    if (point.id !== ID_CUE_POINT) {
      continue;
    }
    const pointEnd = Math.min(cues.length, point.dataOffset + point.size);
    let time = null;
    let belongsToTrack = trackNumber === null;
    for (const field of iterateElements(cues, point.dataOffset, pointEnd)) {
      if (field.id === ID_CUE_TIME) {
        time = readUint(cues, field.dataOffset, field.size) * secondsPerTick;
        continue;
      }
      if (field.id !== ID_CUE_TRACK_POSITIONS || belongsToTrack) {
        continue;
      }
      const positionsEnd = Math.min(pointEnd, field.dataOffset + field.size);
      for (const inner of iterateElements(cues, field.dataOffset, positionsEnd)) {
        if (inner.id === ID_CUE_TRACK && readUint(cues, inner.dataOffset, inner.size) === trackNumber) {
          belongsToTrack = true;
          break;
        }
      }
    }
    if (time !== null && belongsToTrack) {
      times.push(time);
    }
  }
  times.sort((left, right) => left - right);
  return times;
}

/**
 * Read the keyframe times of a Matroska file using only two point reads.
 *
 * @param {(start: number, end: number) => Promise<Buffer | null>} readRange
 *   Inclusive byte range reader; returns null when the range is unavailable.
 * @param {number} fileSize
 * @returns {Promise<number[] | null>} Ascending seconds, or null when the file
 *   carries no usable index (see the module doc for when that happens).
 */
export async function readMatroskaKeyframeTimes(readRange, fileSize) {
  const head = await readRange(0, Math.min(HEAD_BYTES, Math.max(0, fileSize - 1)));
  if (!head || !isMatroska(head)) {
    return null;
  }

  const seekHead = readSeekHead(head);
  if (!seekHead) {
    return null; // No SeekHead — a streamed or truncated mux.
  }

  const cuesRelative = seekHead.entries.get(ID_CUES);
  if (cuesRelative === undefined) {
    return null; // Indexless file: live capture, interrupted write, damaged upload.
  }

  // SeekHead positions are relative to Segment's payload.
  const cuesOffset = seekHead.segmentDataOffset + cuesRelative;
  if (!Number.isFinite(cuesOffset) || cuesOffset <= 0 || cuesOffset >= fileSize) {
    return null;
  }

  // The element header states the payload size, but reading it costs a round
  // trip; fetch a bounded window instead and let the parser stop at the end of
  // what it got. Cues sits near the file end, so the window is clamped there.
  const cuesEnd = Math.min(fileSize - 1, cuesOffset + MAX_CUES_BYTES);
  const cuesChunk = await readRange(cuesOffset, cuesEnd);
  if (!cuesChunk || cuesChunk.length === 0) {
    return null;
  }

  // The window starts exactly at the Cues element, so its own header comes
  // first; step over it to reach the CuePoints.
  const cuesElement = [...iterateElements(cuesChunk, 0, cuesChunk.length)][0];
  if (!cuesElement || cuesElement.id !== ID_CUES) {
    return null;
  }
  const payloadEnd = Math.min(cuesChunk.length, cuesElement.dataOffset + cuesElement.size);
  const payload = cuesChunk.subarray(cuesElement.dataOffset, payloadEnd);

  // Whose entries to keep. Tracks sits near the head and is normally inside the
  // bytes already fetched; when it is not, SeekHead says where it is and one
  // more short read gets it. Nothing is fetched twice and nothing is scanned.
  const videoTrack = await readVideoTrack(readRange, head, seekHead, fileSize);
  const timestampScale = readTimestampScale(head, seekHead.segmentDataOffset);
  const times = readCueTimes(payload, timestampScale, videoTrack);
  if (times.length > 0) {
    return times;
  }
  if (videoTrack === null) {
    return null;
  }
  // The filter left nothing, and that is not an answer about the file: a table
  // exists, and this reader simply failed to recognise which of its entries
  // belong to the picture — a track numbered one way in Tracks and another in
  // the cue points, or an entry with no CueTrack at all. Returning null here
  // would put an EVEN grid on a copied picture, which is the failure this
  // module exists to prevent, so the unfiltered table is used instead: less
  // exact than the picture's own keyframes, better than a grid that has nothing
  // to do with the file.
  const unfiltered = readCueTimes(payload, timestampScale, null);
  return unfiltered.length > 0 ? unfiltered : null;
}

/**
 * The video track's number — from the head when it is there, and from one extra
 * short read when it is not.
 *
 * @param {(start: number, end: number) => Promise<Buffer | null>} readRange
 * @param {Buffer} head
 * @param {{ segmentDataOffset: number, entries: Map<number, number> }} seekHead
 * @param {number} fileSize
 * @returns {Promise<number | null>} Null when Tracks cannot be read at all, and
 *   then every cue entry is kept — right for a file that indexes only its
 *   picture, wrong for one that does not, and nothing here can tell them apart.
 *   Refusing the index instead would put an even grid on a copied picture,
 *   which is the failure this reader exists to prevent.
 */
async function readVideoTrack(readRange, head, seekHead, fileSize) {
  const inHead = findElement(head, ID_TRACKS, [], seekHead.segmentDataOffset);
  if (inHead && inHead.dataOffset + inHead.size <= head.length) {
    return readVideoTrackNumber(head, inHead);
  }
  const relative = seekHead.entries.get(ID_TRACKS);
  if (relative === undefined) {
    return null;
  }
  const offset = seekHead.segmentDataOffset + relative;
  if (!Number.isFinite(offset) || offset <= 0 || offset >= fileSize) {
    return null;
  }
  const chunk = await readRange(offset, Math.min(fileSize - 1, offset + MAX_TRACKS_BYTES));
  if (!chunk || chunk.length === 0) {
    return null;
  }
  const element = [...iterateElements(chunk, 0, chunk.length)][0];
  if (!element || element.id !== ID_TRACKS) {
    return null;
  }
  return readVideoTrackNumber(chunk, { dataOffset: element.dataOffset, size: element.size });
}
