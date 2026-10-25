import { PacketIndex } from "./PacketIndex.js";
import { PacketRecords } from "./PacketRecords.js";
import { followingPacketTime } from "./following-packet-time.js";
import { isMp3Codec } from "./mp3-packet-dependencies.js";
import { BytesUnavailable, isUnavailable } from "./unavailable.js";

const DATA = "3626b2758e66cf11a6d900aa0062ce6c";

/** The Data Object's header: where its packets begin and end, and how many it declares. */
export async function readAsfData({ readRange, fileSize, info }) {
  const at = info.dataOffset;
  const data = await readRange(at, at + 49);
  if (data.subarray(0, 16).toString("hex") !== DATA) throw new Error("ASF Data Object is absent.");
  const size = Number(data.readBigUInt64LE(16));
  const count = Number(data.readBigUInt64LE(40));
  if (!Number.isSafeInteger(size) || size < 50 || at + size > fileSize || !Number.isSafeInteger(count)) {
    throw new Error("ASF Data Object exceeds the file.");
  }
  return { start: at + 50, end: at + size, count };
}

/** ASF payload addresses, including fragmented and compressed media objects. */
export async function readAsfPackets({ readRange, fileSize, tracks, info, firstPicture = false, packetMemory, state = {}, isCurrent }) {
  if (!state.initialized) {
  const data = await readAsfData({ readRange, fileSize, info });
  Object.assign(state, { initialized: true, at: data.start, end: data.end, count: data.count, packets: 0,
    frames: new Map(tracks.map(track => [track.trackNumber, new PacketRecords(packetMemory)])), assembling: new Map() });
  }
  let { at, packets } = state;
  const { end, count, frames, assembling } = state;
  const declared = new Map(tracks.map(track => [track.trackNumber, track]));
  while (at < end && (!count || packets < count)) {
    if (isCurrent?.() === false) return null;
    const previousObjects = new Map([...assembling].map(([id, object]) => [id, { ...object, ranges: [...object.ranges] }]));
    const previousLengths = new Map([...frames].map(([id, stream]) => [id, stream.length]));
    try {
    ({ next: at } = await readPacket({ readRange, at, end, info, declared, frames, assembling }));
    packets++;
    state.at = at;
    state.packets = packets;
    if (isCurrent?.() === false) return null;
    if (firstPicture) {
      const video = tracks.find(track => track.type === "video");
      const stream = video && frames.get(video.trackNumber);
      if (stream?.length) return { startTimeSeconds: stream.at(0).pts };
    }
    } catch (error) {
      assembling.clear();
      for (const [id, object] of previousObjects) assembling.set(id, object);
      for (const [id, length] of previousLengths) frames.get(id).length = length;
      throw error;
    }
  }
  if ((count && packets !== count) || assembling.size) throw new Error("ASF Data Object ends with incomplete packets or media objects.");
  if (firstPicture) return { startTimeSeconds: null };
  const index = new PacketIndex();
  for (const track of tracks) {
    if (!["video", "audio"].includes(track.type)) continue;
    const stream = frames.get(track.trackNumber);
    declareTrackOf(index, track);
    setDurations(stream, stream.length, track, info.durationSeconds, packetMemory);
    index.sharePackets(track.trackNumber, stream);
    index.complete(track.trackNumber);
  }
  return index;
}

/** The time a data packet is sent at, in seconds on its payloads' clock. */
export async function readAsfPacketTime({ readRange, at, end, info }) {
  const { timestamp } = await readPacketHeader(new Fields(readRange, at, end), info.packetLength);
  return timestamp / 1000 - info.prerollSeconds;
}

/**
 * The packets of `interval` alone, read from the data packet numbered
 * `first` on and only as far as the interval needs, without the packets
 * before it or after it. The whole walk of the Data Object answered no
 * interval before it had read the file to its end, so a film of this format
 * had no segment with input bytes, its first included, until the whole of it
 * was downloaded (torrent-tv/meta#243).
 *
 * Two rules of the format make that possible. Packets are stored in the order
 * they are sent, and a payload is sent no later than it is presented, so once
 * a packet sent at `t` is read, every payload presented before `t` has been
 * read. The walk stops there once, for every track, that holds the first two
 * presentation times at or after the interval's end: the frame at the first
 * is the last this window keeps, and the second states its duration.
 *
 * What the window begins with is not known until it is read: a media object
 * whose first fragment lies before `first` is passed over, and the
 * answer says whether the window holds each track from early enough
 * (`startCovered`): sound from `WINDOW_LEAD_SECONDS` before the interval, and
 * a picture from a keyframe at or before it. If it does not, the caller reads
 * the window again from an earlier packet.
 *
 * The packets are read a portion at a time. A portion that is not held whole
 * is read a packet at a time, and a packet that is not held is said as
 * missing together with the bytes the rest of the window is estimated to take
 * at the file's average rate, so the swarm is asked for the window once
 * rather than a piece at a time.
 *
 * @param {object} params
 * @param {{ start: number, end: number, count: number, length: number }} params.data - The fixed-length packets.
 * @param {object[]} params.requested - The tracks the interval is read for.
 * @param {number} params.first - The number of the packet the window begins at.
 * @param {{ from: number, to: number }} params.interval
 * @param {number} params.sentFrom - When packet `first` is sent, as far as the caller knows.
 * @returns {Promise<{ index: PacketIndex, startCovered: boolean }>}
 */
export async function readAsfWindow({ readRange, data, tracks, requested, info, first, interval, sentFrom, isCurrent }) {
  const declared = new Map(tracks.map(track => [track.trackNumber, track]));
  // Not admitted to IndexMemory: one segment's records, a few hundred, held
  // by the request that asked and dropped with it. Nothing owns a window to
  // dispose of it, and admitted, each segment's would stay counted until the
  // file is forgotten.
  const frames = new Map(tracks.map(track => [track.trackNumber, new PacketRecords()]));
  const assembling = new Map();
  const started = new Set();
  const ids = requested.map(track => track.trackNumber);
  /** Per track, the two earliest distinct presentation times at or after the interval's end. */
  const after = new Map(ids.map(id => [id, []]));
  const examined = new Map(ids.map(id => [id, 0]));
  const dataEnd = data.start + data.count * data.length;
  const rate = info.durationSeconds > 0 ? (dataEnd - data.start) / info.durationSeconds : 0;
  let at = data.start + first * data.length, sent = sentFrom, reachedEnd = false;
  let buffer = null, bufferAt = 0;
  const held = (start, end) => buffer !== null && start >= bufferAt && end < bufferAt + buffer.length;
  const read = (start, end) => held(start, end) ? buffer.subarray(start - bufferAt, end - bufferAt + 1) : readRange(start, end);
  const load = async () => {
    if (isCurrent?.() === false) return false;
    try {
      buffer = await readRange(at, Math.min(dataEnd - 1, at + WINDOW_PORTION_PACKETS * data.length - 1));
    } catch (error) {
      if (isCurrent?.() === false) return false;
      if (!isUnavailable(error)) throw error;
      try {
        buffer = await readRange(at, Math.min(dataEnd - 1, at + data.length - 1));
      } catch (missing) {
        if (isCurrent?.() === false) return false;
        if (!isUnavailable(missing)) throw missing;
        const ahead = Math.ceil(Math.max(0, interval.to + WINDOW_LEAD_SECONDS - sent) * rate);
        throw new BytesUnavailable(at, Math.min(dataEnd - 1, Math.max(at + data.length, at + ahead) - 1), 0);
      }
    }
    if (isCurrent?.() === false) return false;
    bufferAt = at;
    return true;
  };
  for (;;) {
    if (isCurrent?.() === false) return null;
    if (at >= dataEnd) { reachedEnd = true; break; }
    if (!held(at, Math.min(dataEnd, at + data.length) - 1) && !(await load())) return null;
    if (isCurrent?.() === false) return null;
    ({ next: at, sent } = await readPacket({ readRange: read, at, end: data.end, info, declared, frames, assembling, started }));
    for (const id of ids) {
      const stream = frames.get(id), times = after.get(id);
      for (let position = examined.get(id); position < stream.length; position++) {
        const pts = stream.ptsAt(position);
        if (pts < interval.to || times.includes(pts)) continue;
        times.push(pts);
        times.sort((left, right) => left - right);
        times.length = Math.min(times.length, 2);
      }
      examined.set(id, stream.length);
    }
    if (ids.every(id => after.get(id).length === 2 && sent >= after.get(id)[1])) break;
  }
  const index = new PacketIndex();
  let startCovered = true;
  for (const track of requested) {
    const id = track.trackNumber, stream = frames.get(id);
    declareTrackOf(index, track);
    const last = reachedEnd ? Infinity : after.get(id)[0];
    let kept = 0;
    for (let position = 0; position < stream.length; position++) if (stream.ptsAt(position) <= last) kept = position + 1;
    setDurations(stream, kept, track, info.durationSeconds, undefined);
    stream.length = kept;
    startCovered &&= coversStart(stream, track, interval.from);
    index.sharePackets(id, stream);
    if (reachedEnd) index.complete(id);
    else index.coverThrough(id, last);
  }
  return { index, startCovered };
}

/** How far before an interval a window holds sound: its decoder's preroll and an MP3 reservoir lie well within it. */
export const WINDOW_LEAD_SECONDS = 1;
/** How far before its mark a window may begin: the search for its first packet stops within it. */
export const WINDOW_SEARCH_SECONDS = 2;
/** How many packets one read of a window takes. */
const WINDOW_PORTION_PACKETS = 64;

function coversStart(stream, track, from) {
  if (!stream.length) return false;
  if (track.type === "audio") return stream.ptsAt(0) <= from - WINDOW_LEAD_SECONDS;
  for (let position = 0; position < stream.length; position++) {
    if (stream.keyframeAt(position) && stream.ptsAt(position) <= from) return true;
  }
  return false;
}

function declareTrackOf(index, track) {
  index.declareTrack(track.trackNumber, { type: track.type, codecId: track.codecId, codecRanges: track.codecRanges ?? [],
    prerollSeconds: track.seekPrerollSeconds ?? 0 });
}

/** The first `count` records' durations, from the next presentation time where the format states none. */
function setDurations(stream, count, track, endSeconds, packetMemory) {
  const following = (track.defaultDurationSeconds === undefined || track.defaultDurationSeconds === null) && stream.some(frame => frame.duration === undefined)
    ? followingPacketTime(stream, endSeconds, packetMemory) : null;
  try { for (let position = 0; position < count; position++) {
    const stated = stream.durationAt(position), pts = stream.ptsAt(position);
    const duration = !Number.isNaN(stated) ? stated : track.defaultDurationSeconds ?? following(pts) - pts;
    if (!(duration > 0)) throw new Error("ASF frame duration cannot be determined.");
    if (duration !== stated) stream.setDuration(position, duration);
  } } finally { following?.dispose(); }
}

async function readPacketHeader(fields, packetLength) {
  let flags = await fields.uint(1);
  if (flags & 0x80) {
    if (flags & 0x60) throw new Error("ASF error-correction length type is unsupported.");
    fields.skip(flags & 15);
    flags = await fields.uint(1);
  }
  const properties = await fields.uint(1);
  const length = await fields.sized(flags >> 5, packetLength);
  await fields.sized(flags >> 1, 0);
  const padding = await fields.sized(flags >> 3, 0);
  const timestamp = await fields.uint(4);
  await fields.uint(2);
  return { flags, properties, length, padding, timestamp };
}

/**
 * One data packet's payloads, recorded into `frames` and `assembling`.
 * `started`, when given, holds the streams whose media objects a walk that
 * began after the first packet has seen begin; a later fragment of an object
 * that began before the walk is passed over until one begins.
 *
 * @returns {Promise<{ next: number, sent: number }>} Where the next packet
 *   begins, and when this one is sent in seconds on its payloads' clock.
 */
async function readPacket({ readRange, at, end, info, declared, frames, assembling, started = null }) {
  const fields = new Fields(readRange, at, end);
  const { flags, properties, length, padding, timestamp } = await readPacketHeader(fields, info.packetLength);
  if (!length || length > end - at || padding >= length) throw new Error("ASF packet length or padding is invalid.");
  const limit = at + length - padding;
  fields.limit = limit;
  const payloadFlags = flags & 1 ? await fields.uint(1) : 0x81;
  const payloadCount = flags & 1 ? payloadFlags & 63 : 1;
  if (!payloadCount) throw new Error("ASF packet has no payloads.");
  for (let payload = 0; payload < payloadCount; payload++) {
    const stream = await fields.uint(1);
    const id = stream & 127, keyframe = (stream & 128) !== 0;
    if (!declared.has(id)) throw new Error("ASF payload names an undeclared stream.");
    const number = await fields.sized(properties >> 4, 0);
    const offset = await fields.sized(properties >> 2, 0);
    const replicaLength = await fields.sized(properties, 0);
    let objectSize = null, time = timestamp, delta = null;
    if (replicaLength >= 8) {
      objectSize = await fields.uint(4);
      time = await fields.uint(4);
      fields.skip(replicaLength - 8);
    } else if (replicaLength === 1) {
      time = offset;
      delta = await fields.uint(1);
    } else if (replicaLength !== 0) throw new Error("ASF replicated payload data is invalid.");
    const payloadSize = flags & 1 ? await fields.sized(payloadFlags >> 6, 0) : limit - fields.at;
    if (!payloadSize || payloadSize > limit - fields.at) throw new Error("ASF payload exceeds its packet.");
    const payloadEnd = fields.at + payloadSize;
    if (delta !== null) {
      started?.add(id);
      while (fields.at < payloadEnd) {
        const frameSize = await fields.uint(1);
        if (!frameSize || frameSize > payloadEnd - fields.at) throw new Error("ASF compressed frame exceeds its payload.");
        frames.get(id).push({ pts: time / 1000 - info.prerollSeconds, ...(delta > 0 ? { duration: delta / 1000 } : {}),
          ...(isMp3Codec(declared.get(id)?.codecId) ? { decodeFromIndex: frames.get(id).length, decodeDependencyUnknown: true } : {}),
          keyframe, ranges: [[fields.at, fields.at + frameSize - 1]] });
        fields.skip(frameSize);
        time += delta;
      }
    } else {
      let object = assembling.get(id);
      if (offset !== 0 && !object && started && !started.has(id)) {
        fields.skip(payloadSize);
        continue;
      }
      if (offset === 0) {
        if (object) throw new Error("ASF media object ended before all fragments arrived.");
        if (!(objectSize > 0)) throw new Error("ASF media object size is absent.");
        object = { number, size: objectSize, received: 0, pts: time / 1000 - info.prerollSeconds, keyframe, ranges: [] };
        assembling.set(id, object);
        started?.add(id);
      }
      if (!object || object.number !== number || object.received !== offset ||
        (objectSize !== null && object.size !== objectSize) || offset + payloadSize > object.size) {
        throw new Error("ASF media object fragments are incomplete or inconsistent.");
      }
      object.ranges.push([fields.at, payloadEnd - 1]);
      object.received += payloadSize;
      fields.skip(payloadSize);
      if (object.received === object.size) {
        frames.get(id).push({ pts: object.pts, keyframe: object.keyframe, ranges: object.ranges,
          ...(isMp3Codec(declared.get(id)?.codecId) ? { decodeFromIndex: frames.get(id).length, decodeDependencyUnknown: true } : {}) });
        assembling.delete(id);
      }
    }
  }
  if (fields.at !== limit) throw new Error("ASF payload count differs from its packet size.");
  return { next: at + Math.max(length, info.minimumPacketLength ?? length), sent: timestamp / 1000 - info.prerollSeconds };
}

class Fields {
  constructor(read, at, limit) { this.read = read; this.at = at; this.limit = limit; }
  skip(count) {
    if (!Number.isSafeInteger(count) || count < 0 || count > this.limit - this.at) throw new Error("ASF packet field exceeds its bounds.");
    this.at += count;
  }
  async uint(width) {
    const at = this.at;
    this.skip(width);
    return (await this.read(at, at + width - 1)).readUIntLE(0, width);
  }
  sized(type, fallback) {
    const width = [0, 1, 2, 4][type & 3];
    return width ? this.uint(width) : fallback;
  }
}
