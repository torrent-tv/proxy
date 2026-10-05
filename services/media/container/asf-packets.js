import { PacketIndex } from "./PacketIndex.js";
import { PacketRecords } from "./PacketRecords.js";
import { followingPacketTime } from "./following-packet-time.js";
import { isMp3Codec } from "./mp3-packet-dependencies.js";

const DATA = "3626b2758e66cf11a6d900aa0062ce6c";

/** ASF payload addresses, including fragmented and compressed media objects. */
export async function readAsfPackets({ readRange, fileSize, tracks, info, firstPicture = false, packetMemory, state = {} }) {
  if (!state.initialized) {
  const at = info.dataOffset;
  const data = await readRange(at, at + 49);
  if (data.subarray(0, 16).toString("hex") !== DATA) throw new Error("ASF Data Object is absent.");
  const size = Number(data.readBigUInt64LE(16));
  const count = Number(data.readBigUInt64LE(40));
  if (!Number.isSafeInteger(size) || size < 50 || at + size > fileSize || !Number.isSafeInteger(count)) {
    throw new Error("ASF Data Object exceeds the file.");
  }
  Object.assign(state, { initialized: true, at: at + 50, end: at + size, count, packets: 0,
    frames: new Map(tracks.map(track => [track.trackNumber, new PacketRecords(packetMemory)])), assembling: new Map() });
  }
  let { at, packets } = state;
  const { end, count, frames, assembling } = state;
  const declared = new Map(tracks.map(track => [track.trackNumber, track]));
  while (at < end && (!count || packets < count)) {
    const previousObjects = new Map([...assembling].map(([id, object]) => [id, { ...object, ranges: [...object.ranges] }]));
    const previousLengths = new Map([...frames].map(([id, stream]) => [id, stream.length]));
    try {
    const fields = new Fields(readRange, at, end);
    let flags = await fields.uint(1);
    if (flags & 0x80) {
      if (flags & 0x60) throw new Error("ASF error-correction length type is unsupported.");
      fields.skip(flags & 15);
      flags = await fields.uint(1);
    }
    const properties = await fields.uint(1);
    const length = await fields.sized(flags >> 5, info.packetLength);
    await fields.sized(flags >> 1, 0);
    const padding = await fields.sized(flags >> 3, 0);
    const timestamp = await fields.uint(4);
    await fields.uint(2);
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
        if (offset === 0) {
          if (object) throw new Error("ASF media object ended before all fragments arrived.");
          if (!(objectSize > 0)) throw new Error("ASF media object size is absent.");
          object = { number, size: objectSize, received: 0, pts: time / 1000 - info.prerollSeconds, keyframe, ranges: [] };
          assembling.set(id, object);
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
    at += Math.max(length, info.minimumPacketLength ?? length);
    packets++;
    state.at = at;
    state.packets = packets;
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
    index.declareTrack(track.trackNumber, { type: track.type, codecId: track.codecId, codecRanges: track.codecRanges ?? [],
      prerollSeconds: track.seekPrerollSeconds ?? 0 });
    const following = (track.defaultDurationSeconds === undefined || track.defaultDurationSeconds === null) && stream.some(frame => frame.duration === undefined)
      ? followingPacketTime(stream, info.durationSeconds, packetMemory) : null;
    try { for (let position = 0; position < stream.length; position++) {
      const stated = stream.durationAt(position), pts = stream.ptsAt(position);
      const duration = !Number.isNaN(stated) ? stated : track.defaultDurationSeconds ?? following(pts) - pts;
      if (!(duration > 0)) throw new Error("ASF frame duration cannot be determined.");
      if (duration !== stated) stream.setDuration(position, duration);
    } } finally { following?.dispose(); }
    index.sharePackets(track.trackNumber, stream);
    index.complete(track.trackNumber);
  }
  return index;
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
