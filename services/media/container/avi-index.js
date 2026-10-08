/**
 * @file What an AVI index states, read without reading the media it indexes.
 *
 * `idx1` and the OpenDML standard indexes (`ix##`, reached through each
 * stream's `indx` super index) give, for every packet, its stream, the file
 * position of its payload, its size and whether it is a keyframe. A packet's
 * time follows from its place in its stream: FFmpeg's AVI demuxer advances a
 * stream's clock by one unit per packet, or by the payload's byte count over
 * the sample size where the stream declares one (`get_duration`, avidec.c).
 * FFmpeg copies and decodes on exactly that clock, so these times are the
 * times a run reading the original file will see.
 *
 * Nothing here reads a packet. The packet reassembly this replaces confirmed
 * every index entry against the chunk header in `movi`, which made the
 * keyframe table wait for nearly the whole film (torrent-tv/meta#151).
 */

import { IndexMemoryUnavailable } from "./memory-unavailable.js";

const IDX1_ENTRY_BYTES = 16;
/** Index bytes read per request; one request's worth of the proxy's input route. */
const READ_BYTES = 1024 * 1024;
/** Bytes held per packet: position (8), size (4), time (8), keyframe flag (1). */
const ENTRY_BYTES = 21;
const AVIIF_KEYFRAME = 0x10;
/**
 * Packets of a stream FFmpeg can read past the last one a run needs before it
 * stops reading: its demuxer runs in a thread and goes on until a selected
 * stream's queue is full (fftools n8.1). Eight packets queued to the decoder
 * or muxer (`DEFAULT_PACKET_THREAD_QUEUE_SIZE`), two frames queued to the
 * filter (`DEFAULT_FRAME_THREAD_QUEUE_SIZE`), at most sixteen packets held by
 * a frame-threaded decoder (`MAX_AUTO_THREADS`), and at most sixteen pictures
 * held for reordering (H.264's largest picture buffer). Without it a picture
 * whose every frame is a keyframe left FFmpeg one frame of margin, and its
 * read-ahead asked for bytes the run did not hold (torrent-tv/meta#151).
 */
const READ_AHEAD_PACKETS = 8 + 2 + 16 + 16;

/** One stream's packets in file order, in typed arrays. */
class StreamPackets {
  constructor(count) {
    this.count = 0;
    this.starts = new Float64Array(count);
    this.lengths = new Uint32Array(count);
    this.times = new Float64Array(count);
    this.keyframes = new Uint8Array(count);
  }

  push(start, length, time, keyframe) {
    const at = this.count++;
    this.starts[at] = start;
    this.lengths[at] = length;
    this.times[at] = time;
    this.keyframes[at] = keyframe ? 1 : 0;
  }

  /** The last packet whose time is at or before `seconds`, or 0. */
  atOrBefore(seconds) {
    let low = 0, high = this.count;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.times[middle] <= seconds) low = middle + 1;
      else high = middle;
    }
    return Math.max(0, low - 1);
  }
}

/**
 * Read the index of one AVI.
 *
 * @param {object} params
 * @param {(start: number, end: number) => Promise<Buffer>} params.read - Strict byte read.
 * @param {number} params.fileSize
 * @param {{ start: number, end: number }} params.movi - The first `movi` list (`start` at its type).
 * @param {{ start: number, end: number } | null} params.idx1 - The `idx1` chunk's payload, if any.
 * @param {Array<{ type: string, timeBase: number | null, sampleSize: number, startTimeSeconds: number | null,
 *   indexChunks: Array<{ start: number, end: number }> }>} params.streams - In stream-number order.
 * @param {{ reserve?: (bytes: number) => boolean, release?: (bytes: number) => void }} params.allocation
 * @returns {Promise<AviIndex | null>} Null when the file states no index.
 */
export async function readAviIndex({ read, fileSize, movi, idx1, streams, allocation }) {
  const useOpenDml = streams.some(stream => stream.indexChunks.length);
  if (!useOpenDml && !idx1) return null;
  if (streams.some(stream => ["video", "audio"].includes(stream.type) && !(stream.timeBase > 0))) {
    throw new Error("AVI stream time base is invalid.");
  }
  return useOpenDml
    ? readOpenDml({ read, fileSize, streams, allocation })
    : readIdx1({ read, fileSize, movi, idx1, streams, allocation });
}

/** Whole entries of `unit` bytes, about one request at a time. */
async function* blocks(read, start, end, unit) {
  const step = Math.max(unit, Math.floor(READ_BYTES / unit) * unit);
  for (let at = start; at < end; at += step) {
    yield { at, bytes: await read(at, Math.min(end, at + step) - 1) };
  }
}

function reserve(allocation, count) {
  const bytes = count * ENTRY_BYTES;
  if (allocation?.reserve?.(bytes) === false) throw new IndexMemoryUnavailable(bytes);
  return bytes;
}

function durationOf(stream, length) {
  return stream.timeBase * (stream.sampleSize > 0 ? length / stream.sampleSize : 1);
}

async function readIdx1({ read, fileSize, movi, idx1, streams, allocation }) {
  if ((idx1.end - idx1.start) % IDX1_ENTRY_BYTES !== 0) throw new Error("AVI packet index entry is truncated.");
  const counts = new Array(streams.length).fill(0);
  let first = null;
  // Entries are 16 bytes and blocks are a multiple of 16, so none straddles.
  let anyKeyframe = false;
  for await (const { at, bytes } of blocks(read, idx1.start, idx1.end, IDX1_ENTRY_BYTES)) {
    for (let offset = 0; offset < bytes.length; offset += IDX1_ENTRY_BYTES) {
      const id = streamOf(bytes.toString("ascii", offset, offset + 4), streams.length);
      if (id === null) continue;
      counts[id]++;
      if (bytes.readUInt32LE(offset + 4) & AVIIF_KEYFRAME) anyKeyframe = true;
      if (first === null && bytes.readUInt32LE(offset + 12) > 0) {
        first = { chunkId: bytes.toString("ascii", offset, offset + 4), offset: bytes.readUInt32LE(offset + 8), length: bytes.readUInt32LE(offset + 12), at: at + offset };
      }
    }
  }
  if (first === null) return null;
  // Offsets count from the `movi` type or from the start of the file; the one
  // that lands on the first entry's own chunk header is the file's convention.
  let base = null;
  for (const candidate of [movi.start, 0, movi.start + 4]) {
    const address = candidate + first.offset;
    if (address < movi.start + 4 || address + 8 + first.length > movi.end) continue;
    const head = await read(address, address + 7);
    if (head.toString("ascii", 0, 4) === first.chunkId && head.readUInt32LE(4) === first.length) { base = candidate; break; }
  }
  if (base === null) throw new Error("AVI packet index has no valid offset base.");
  const held = reserve(allocation, counts.reduce((sum, count) => sum + count, 0));
  try {
    const packets = counts.map(count => new StreamPackets(count));
    const clocks = streams.map(stream => stream.startTimeSeconds ?? 0);
    for await (const { bytes } of blocks(read, idx1.start, idx1.end, IDX1_ENTRY_BYTES)) {
      for (let offset = 0; offset < bytes.length; offset += IDX1_ENTRY_BYTES) {
        const chunkId = bytes.toString("ascii", offset, offset + 4);
        const id = streamOf(chunkId, streams.length);
        if (id === null) continue;
        const length = bytes.readUInt32LE(offset + 12);
        const start = base + bytes.readUInt32LE(offset + 8) + 8;
        if (length && (start < movi.start + 12 || start + length > movi.end)) throw new Error("AVI indexed packet exceeds its media list.");
        // FFmpeg takes the index flag alone, and every entry as a keyframe
        // when no entry carries it (avi_read_idx1).
        const keyframe = !anyKeyframe || !!(bytes.readUInt32LE(offset + 4) & AVIIF_KEYFRAME);
        packets[id].push(start, length, clocks[id], keyframe);
        clocks[id] += durationOf(streams[id], length);
      }
    }
    return new AviIndex({ packets, indexRanges: [[idx1.start - 8, fileSize - 1]], held, allocation });
  } catch (error) {
    allocation?.release?.(held);
    throw error;
  }
}

async function readOpenDml({ read, fileSize, streams, allocation }) {
  const standards = [];
  for (const [id, stream] of streams.entries()) {
    for (const chunk of stream.indexChunks) {
      const header = await read(chunk.start, chunk.start + 23);
      if (header[3] !== 0 || header.readUInt16LE(0) !== 4) {
        throw new Error("AVI OpenDML super index structure is invalid.");
      }
      const count = header.readUInt32LE(4);
      if (count > Math.floor((chunk.end - chunk.start - 24) / 16)) throw new Error("AVI OpenDML index entry count exceeds its chunk.");
      const table = count ? await read(chunk.start + 24, chunk.start + 23 + count * 16) : Buffer.alloc(0);
      for (let at = 0; at < count; at++) {
        const offset = Number(table.readBigUInt64LE(at * 16)), size = table.readUInt32LE(at * 16 + 8);
        if (!offset && !size) continue;
        if (!Number.isSafeInteger(offset) || size < 32 || offset + size > fileSize) throw new Error("AVI OpenDML child index exceeds the file.");
        standards.push({ id, start: offset, end: offset + size });
      }
    }
  }
  // Headers first: the entry counts decide the allocation before any table is held.
  const parsed = [];
  for (const standard of standards) {
    const header = await read(standard.start, standard.start + 31);
    if (!/^ix[0-9]{2}$/.test(header.toString("ascii", 0, 4)) || header.readUInt32LE(4) + 8 !== standard.end - standard.start) {
      throw new Error("AVI OpenDML child index size disagrees with its header.");
    }
    const words = header.readUInt16LE(8), subtype = header[10], type = header[11];
    const count = header.readUInt32LE(12), chunkId = header.toString("ascii", 16, 20);
    if (type !== 1 || !((subtype === 0 && words === 2) || (subtype === 1 && words === 3))) throw new Error("AVI OpenDML standard index structure is invalid.");
    if (streamOf(chunkId, streams.length) !== standard.id) throw new Error("AVI OpenDML index refers to another stream.");
    if (count > Math.floor((standard.end - standard.start - 32) / (words * 4))) throw new Error("AVI OpenDML index entry count exceeds its chunk.");
    const base = Number(header.readBigUInt64LE(20));
    if (!Number.isSafeInteger(base)) throw new Error("AVI OpenDML address exceeds exact integer precision.");
    parsed.push({ ...standard, entryBytes: words * 4, count, base });
  }
  const counts = new Array(streams.length).fill(0);
  for (const standard of parsed) counts[standard.id] += standard.count;
  const held = reserve(allocation, counts.reduce((sum, count) => sum + count, 0));
  try {
    const packets = counts.map(count => new StreamPackets(count));
    const clocks = streams.map(stream => stream.startTimeSeconds ?? 0);
    for (const standard of parsed) {
      const stream = streams[standard.id];
      const tableStart = standard.start + 32;
      const tableEnd = tableStart + standard.count * standard.entryBytes;
      for await (const { bytes } of blocks(read, tableStart, tableEnd, standard.entryBytes)) {
        for (let offset = 0; offset + standard.entryBytes <= bytes.length; offset += standard.entryBytes) {
          const start = standard.base + bytes.readUInt32LE(offset);
          const encoded = bytes.readUInt32LE(offset + 4), length = encoded & 0x7fffffff;
          if (length && (start < 8 || start + length > fileSize)) throw new Error("AVI OpenDML packet exceeds the file.");
          packets[standard.id].push(start, length, clocks[standard.id], !(encoded & 0x80000000));
          clocks[standard.id] += durationOf(stream, length);
        }
      }
    }
    return new AviIndex({ packets, indexRanges: parsed.map(standard => [standard.start, standard.end - 1]), held, allocation });
  } catch (error) {
    allocation?.release?.(held);
    throw error;
  }
}

/** The stream an entry belongs to; entries of no declared stream are skipped, as FFmpeg does. */
function streamOf(chunkId, streamCount) {
  if (!/^[0-9]{2}(db|dc|wb)$/.test(chunkId)) return null;
  const id = Number(chunkId.slice(0, 2));
  return id < streamCount ? id : null;
}

/** The packets an AVI index states, and the index bytes FFmpeg reads to learn them. */
export class AviIndex {
  #held;
  #allocation;
  /** @type {Map<number, Uint32Array> | undefined} */
  #keyframes;

  constructor({ packets, indexRanges, held, allocation }) {
    this.packets = packets;
    this.indexRanges = indexRanges;
    this.#held = held;
    this.#allocation = allocation;
  }

  /**
   * Positions of a stream's keyframes, ascending; made once, because every
   * interval of the film asks for them (each segment of each output).
   */
  #keyframesOf(stream) {
    this.#keyframes ??= new Map();
    let keys = this.#keyframes.get(stream);
    if (!keys) {
      const packets = this.packets[stream];
      const found = [];
      for (let at = 0; at < packets.count; at++) if (packets.keyframes[at] && packets.lengths[at]) found.push(at);
      keys = Uint32Array.from(found);
      this.#keyframes.set(stream, keys);
    }
    return keys;
  }

  /** Keyframe times of a stream, ascending. */
  keyframeTimes(stream) {
    const packets = this.packets[stream];
    return Array.from(this.#keyframesOf(stream), at => packets.times[at]);
  }

  /**
   * The payload bytes a reader of `[from, to)` needs from each stream.
   *
   * The picture is taken from the keyframe two keyframes before `from` — the
   * same margin the Matroska reading keeps in Cue points — to the keyframe that
   * follows the one after `to`. Every other selected stream is taken over the
   * same span of time, so an interleave that places sound ahead of or behind
   * its picture is covered in either direction. Each stream then runs on for
   * the packets FFmpeg reads ahead (`READ_AHEAD_PACKETS`).
   *
   * @param {{ from: number, to: number, picture: number | null, streams: number[] }} params
   * @returns {Array<[number, number]>}
   */
  mediaRanges({ from, to, picture, streams }) {
    let first = from, last = to;
    if (picture !== null) {
      const video = this.packets[picture];
      const keys = this.#keyframesOf(picture);
      if (!keys.length) throw new Error("AVI picture index states no keyframe.");
      // The first keyframe at or after a time, by halving: keyframe times ascend.
      const firstAtOrAfter = seconds => {
        let low = 0, high = keys.length;
        while (low < high) {
          const middle = (low + high) >> 1;
          if (video.times[keys[middle]] < seconds) low = middle + 1;
          else high = middle;
        }
        return low;
      };
      const atOrAfterFrom = firstAtOrAfter(from);
      const before = atOrAfterFrom < keys.length && video.times[keys[atOrAfterFrom]] === from ? atOrAfterFrom : atOrAfterFrom - 1;
      const afterIndex = firstAtOrAfter(to);
      const after = afterIndex < keys.length ? afterIndex : -1;
      first = video.times[keys[Math.max(0, before - 2)]];
      last = after < 0 || after + 1 >= keys.length ? Infinity : video.times[keys[after + 1]];
    }
    const ranges = [];
    for (const stream of streams) {
      const packets = this.packets[stream];
      if (!packets?.count) continue;
      const start = packets.atOrBefore(first);
      let end = packets.count - 1;
      if (Number.isFinite(last)) end = Math.min(end, packets.atOrBefore(last) + READ_AHEAD_PACKETS);
      let low = Infinity, high = -1;
      for (let at = start; at <= end; at++) {
        if (!packets.lengths[at]) continue;
        low = Math.min(low, packets.starts[at] - 8);
        high = Math.max(high, packets.starts[at] + packets.lengths[at] - 1);
      }
      if (high >= 0) ranges.push([low, high]);
    }
    return ranges;
  }

  /** Where each stream's first packet begins, header included. */
  firstPackets() {
    return this.packets.flatMap(packets => {
      for (let at = 0; at < packets.count; at++) if (packets.lengths[at]) return [[packets.starts[at] - 8, packets.starts[at] + 7]];
      return [];
    });
  }

  dispose() {
    if (!this.#held) return;
    this.#allocation?.release?.(this.#held);
    this.#held = 0;
  }
}
