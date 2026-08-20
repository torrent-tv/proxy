/**
 * @file Subtitle blocks out of Matroska clusters, from bytes already in hand.
 *
 * A subtitle track is sparse — a few kilobytes spread across a whole film — and
 * ffmpeg cannot extract a time range of one without walking the container to
 * the end. Measured 2026-08-19 on `Minions.and.Monsters.1080p.mkv`: asking for
 * four seconds at minute twenty read the file through and pulled the download
 * from 2.7 % to 81 %; asking with `-copyts -ss -to` took 154 s on a copy that
 * was already 81 % local and still emitted the whole track. So the subtitles
 * are not asked of ffmpeg.
 *
 * They do not have to be. A subtitle block sits in the same cluster as the
 * picture around it, and those clusters are being downloaded anyway for the
 * viewer to watch. Reading them as they arrive costs no network at all, and it
 * puts the cues ahead of the playhead by construction — which is the whole
 * requirement: subtitles arrive like the picture does, or they are not offered.
 *
 * This module is the byte-level half: given a cluster's bytes, it returns the
 * blocks of one track with their times. It reads element headers and skips
 * payloads by their declared length; nothing is decoded.
 *
 * Structure, from RFC 9559 §5.1.3 and §5.1.4:
 *
 *   Cluster (0x1F43B675)
 *     Timestamp (0xE7)            — the cluster's own time, in ticks
 *     SimpleBlock (0xA3)          — a block with no duration of its own
 *     BlockGroup (0xA0)
 *       Block (0xA1)              — the same header, and where subtitles live
 *       BlockDuration (0x9B)      — how long the cue stays on screen
 *
 * A block's header is: the track number as a variable-length integer, a signed
 * 16-bit timestamp relative to the cluster, and one byte of flags. Subtitles
 * are normally in a BlockGroup, because a cue without a duration has no end.
 */

import { iterateElements, readUint, readVint } from "./ebml-reader.js";

const ID_TIMESTAMP = 0xe7;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK_GROUP = 0xa0;
const ID_BLOCK = 0xa1;
const ID_BLOCK_DURATION = 0x9b;

/** Bits 1-2 of the flags byte say how a block is laced, or that it is not. */
const LACING_MASK = 0x06;
const LACING_NONE = 0x00;
const LACING_XIPH = 0x02;
const LACING_FIXED = 0x04;
const LACING_EBML = 0x06;

/**
 * @typedef {object} SubtitleBlock
 * @property {number} startSeconds - When the cue appears.
 * @property {number | null} durationSeconds - How long it stays, or null when
 *   the block carried no duration (a SimpleBlock; the caller decides).
 * @property {Buffer} payload - The block's own bytes, still in the codec's form.
 */

/**
 * Read one block's header.
 *
 * @param {Buffer} buffer
 * @param {number} start - First byte of the block's payload.
 * @param {number} end - One past its last byte.
 * @returns {{ trackNumber: number, relativeTicks: number, flags: number, dataOffset: number } | null}
 */
function readBlockHeader(buffer, start, end) {
  const track = readVint(buffer, start, false);
  if (!track || track.value === null) {
    return null;
  }
  const timestampAt = start + track.length;
  // Signed, and it can be negative: a block may belong slightly before the
  // cluster it is stored in.
  if (timestampAt + 3 > end) {
    return null;
  }
  return {
    trackNumber: Number(track.value),
    relativeTicks: buffer.readInt16BE(timestampAt),
    flags: buffer[timestampAt + 2],
    dataOffset: timestampAt + 3
  };
}

/**
 * Where a laced block's first frame begins.
 *
 * Subtitles are rarely laced, but a block that IS laced starts with a frame
 * count and a table of sizes, and reading the payload without stepping over
 * them yields the table as though it were text.
 *
 * @param {Buffer} buffer
 * @param {number} dataOffset - First byte after the block header.
 * @param {number} end
 * @param {number} flags
 * @returns {number | null} The offset of the first frame, or null when the
 *   lacing cannot be read.
 */
function firstFrameOffset(buffer, dataOffset, end, flags) {
  const lacing = flags & LACING_MASK;
  if (lacing === LACING_NONE) {
    return dataOffset;
  }
  if (dataOffset >= end) {
    return null;
  }
  const frames = buffer[dataOffset] + 1;
  let at = dataOffset + 1;
  if (lacing === LACING_FIXED) {
    return at;
  }
  if (lacing === LACING_XIPH) {
    // Each size but the last is a run of 0xFF bytes ending in a smaller one.
    for (let frame = 0; frame < frames - 1; frame += 1) {
      while (at < end && buffer[at] === 0xff) {
        at += 1;
      }
      at += 1;
    }
    return at <= end ? at : null;
  }
  if (lacing === LACING_EBML) {
    // The first size is a plain variable-length integer, the rest are signed
    // differences from it; either way each is one such integer to step over.
    for (let frame = 0; frame < frames - 1; frame += 1) {
      const size = readVint(buffer, at, false);
      if (!size) {
        return null;
      }
      at += size.length;
    }
    return at <= end ? at : null;
  }
  return null;
}

/**
 * Every block of one track inside one cluster.
 *
 * @param {Buffer} buffer - Bytes holding the cluster's payload.
 * @param {{ dataOffset: number, size: number }} cluster - Where that payload is.
 * @param {number} trackNumber - The track to keep.
 * @param {number} secondsPerTick - From the segment's timestamp scale.
 * @returns {SubtitleBlock[]}
 */
export function blocksOfTrack(buffer, cluster, trackNumber, secondsPerTick) {
  const end = Math.min(buffer.length, cluster.dataOffset + cluster.size);
  /** @type {SubtitleBlock[]} */
  const blocks = [];
  let clusterTicks = null;

  const take = (blockStart, blockEnd, durationTicks) => {
    const header = readBlockHeader(buffer, blockStart, blockEnd);
    if (!header || header.trackNumber !== trackNumber || clusterTicks === null) {
      return;
    }
    const payloadAt = firstFrameOffset(buffer, header.dataOffset, blockEnd, header.flags);
    if (payloadAt === null || payloadAt >= blockEnd) {
      return;
    }
    blocks.push({
      startSeconds: (clusterTicks + header.relativeTicks) * secondsPerTick,
      durationSeconds: durationTicks === null ? null : durationTicks * secondsPerTick,
      payload: buffer.subarray(payloadAt, blockEnd)
    });
  };

  for (const element of iterateElements(buffer, cluster.dataOffset, end)) {
    const elementEnd = Math.min(end, element.dataOffset + element.size);
    if (element.id === ID_TIMESTAMP) {
      clusterTicks = readUint(buffer, element.dataOffset, element.size);
      continue;
    }
    if (element.id === ID_SIMPLE_BLOCK) {
      take(element.dataOffset, elementEnd, null);
      continue;
    }
    if (element.id !== ID_BLOCK_GROUP) {
      continue;
    }
    // A group holds the block and, for a subtitle, the duration that says when
    // the cue leaves the screen. Both are read before either is used, because
    // the duration may be written after the block.
    let blockStart = null;
    let blockEnd = null;
    let durationTicks = null;
    for (const field of iterateElements(buffer, element.dataOffset, elementEnd)) {
      const fieldEnd = Math.min(elementEnd, field.dataOffset + field.size);
      if (field.id === ID_BLOCK) {
        blockStart = field.dataOffset;
        blockEnd = fieldEnd;
      } else if (field.id === ID_BLOCK_DURATION) {
        durationTicks = readUint(buffer, field.dataOffset, field.size);
      }
    }
    if (blockStart !== null) {
      take(blockStart, blockEnd, durationTicks);
    }
  }
  return blocks;
}
