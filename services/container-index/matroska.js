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

// How much of the file start to read. Must cover the EBML header, the SeekHead
// and Info; 64 KB is generous for every real muxer (the file measured needed
// under 4 KB) while still trivial to fetch.
const HEAD_BYTES = 64 * 1024;
// Cap on the Cues read. A two-hour film indexes to tens of KB; anything beyond
// this is not a normal index and not worth pulling over a torrent.
const MAX_CUES_BYTES = 8 * 1024 * 1024;
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
 * Cue times (seconds, ascending) from a Cues payload.
 *
 * @param {Buffer} cues
 * @param {number} timestampScale - Nanoseconds per tick.
 * @returns {number[]}
 */
function readCueTimes(cues, timestampScale) {
  const times = [];
  const secondsPerTick = timestampScale / 1e9;
  for (const point of iterateElements(cues)) {
    if (point.id !== ID_CUE_POINT) {
      continue;
    }
    const pointEnd = Math.min(cues.length, point.dataOffset + point.size);
    for (const field of iterateElements(cues, point.dataOffset, pointEnd)) {
      if (field.id === ID_CUE_TIME) {
        times.push(readUint(cues, field.dataOffset, field.size) * secondsPerTick);
        break;
      }
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

  const times = readCueTimes(payload, readTimestampScale(head, seekHead.segmentDataOffset));
  return times.length > 0 ? times : null;
}
