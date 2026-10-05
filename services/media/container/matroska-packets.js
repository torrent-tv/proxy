import { ElementReader } from "./ebml-stream.js";
import { readUint, readVint } from "./ebml-reader.js";
import { readBlockHeader } from "./matroska-clusters.js";
import { PacketIndex } from "./PacketIndex.js";
import { PacketRecords } from "./PacketRecords.js";
import { isMp3Codec } from "./mp3-packet-dependencies.js";
import { followingPacketTime } from "./following-packet-time.js";

const CLUSTER = 0x1f43b675;
const LEVEL_ONE = new Set([CLUSTER, 0x1c53bb6b, 0x114d9b74, 0x1549a966, 0x1654ae6b, 0x1043a770, 0x1941a469, 0x1254c367]);

/** Index frame addresses by reading structural headers, never frame bodies. */
export async function readMatroskaPackets({ readRange, fileSize, portionBytes, layout, tracks, durationSeconds, interval, packetMemory, state = {} }) {
  const reader = new ElementReader({ read: readRange, fileSize, portionBytes });
  const declared = new Map(tracks.filter(track => ["video", "audio", "subtitle"].includes(track.type)).map(track => [track.trackNumber, track]));
  if (!state.packets) {
    state.packets = new Map([...declared.keys()].map(id => [id, new PacketRecords(packetMemory)]));
    state.at = layout.firstClusterAt ?? layout.segmentEnd;
  }
  const packets = state.packets;
  if (intervalCovered(declared, packets, interval)) return buildIndex(declared, packets, durationSeconds, false, interval, packetMemory);
  let at = state.at;
  while (at < layout.segmentEnd) {
    const element = state.cluster?.element ?? await validHeader(reader, at, layout.segmentEnd);
    if (element.id !== CLUSTER) {
      if (element.end === null) throw new Error("An unknown-sized Matroska element is not a Cluster.");
      at = element.end;
      state.at = at;
      continue;
    }
    const limit = element.end ?? layout.segmentEnd;
    if (!state.cluster) state.cluster = { element, cursor: element.dataOffset, clusterTicks: null };
    let { cursor, clusterTicks } = state.cluster;
    while (cursor < limit) {
      const child = await validHeader(reader, cursor, limit);
      if (element.end === null && LEVEL_ONE.has(child.id)) break;
      if (child.end === null) throw new Error("Matroska Cluster child has unknown size.");
      if (child.id === 0xe7) {
        clusterTicks = readUint(await reader.bytes(child.dataOffset, child.size), 0, child.size);
      } else if (child.id === 0xa3 || child.id === 0xa0) {
        if (clusterTicks === null) throw new Error("Matroska block precedes its Cluster Timestamp.");
        const block = child.id === 0xa3 ? { element: child, duration: null, referenced: false } : await blockGroup(reader, child);
        if (block.element) {
          const first = await reader.bytes(block.element.dataOffset, 1);
          let trackWidth = 1;
          while (trackWidth <= 8 && !(first[0] & (1 << (8 - trackWidth)))) trackWidth++;
          if (trackWidth > 8 || trackWidth + 3 > block.element.size) throw new Error("Matroska block header is truncated.");
          const head = await reader.bytes(block.element.dataOffset, trackWidth + 3);
          const header = readBlockHeader(head, 0, head.length);
          const track = header && declared.get(header.trackNumber);
          if (!header) throw new Error("Matroska block header is truncated.");
          if (!track) {
            if (!tracks.some(track => track.trackNumber === header.trackNumber)) throw new Error("Matroska block names an undeclared media track.");
            cursor = child.end;
            state.cluster.cursor = cursor;
            continue;
          }
          const ranges = await frameRanges(reader, block.element, header);
          const duration = block.duration === null ? track.defaultDurationSeconds ?? 0 : block.duration * layout.secondsPerTick / ranges.length;
          if (ranges.length > 1 && !(duration > 0)) throw new Error("Matroska laced frames need a declared or codec-derived duration.");
          const pts = (clusterTicks + header.relativeTicks * (track.timestampScale ?? 1)) * layout.secondsPerTick - (track.codecDelaySeconds ?? 0);
          const records = packets.get(header.trackNumber);
          const previousLength = records.length;
          try {
          for (let frame = 0; frame < ranges.length; frame++) {
            const padding = paddingForFrame(block.discardPaddingSeconds ?? 0, duration, ranges.length, frame);
            records.push({ pts: pts + frame * duration, duration,
              ...(track.type === "audio" && isMp3Codec(track.codecId)
                ? { decodeFromIndex: records.length, decodeDependencyUnknown: true } : {}),
              ...(padding ? { discardPaddingSeconds: padding } : {}),
              keyframe: child.id === 0xa3 ? !!(header.flags & 0x80) : !block.referenced,
              ranges: [ranges[frame]] });
          }
          } catch (error) {
            records.length = previousLength;
            throw error;
          }
        }
      } else if (child.id === 0xaf) throw new Error("Matroska media blocks are encrypted.");
      cursor = child.end;
      state.cluster.cursor = cursor;
      state.cluster.clusterTicks = clusterTicks;
      if (intervalCovered(declared, packets, interval)) return buildIndex(declared, packets, durationSeconds, false, interval, packetMemory);
    }
    if (cursor <= at) throw new Error("Matroska packet walk did not advance.");
    at = element.end ?? cursor;
    state.at = at;
    state.cluster = null;
  }
  return buildIndex(declared, packets, durationSeconds, true, undefined, packetMemory);
}

function paddingForFrame(seconds, duration, count, frame) {
  if (!seconds || count === 1) return seconds;
  const padding = Math.round(seconds * 1e9), frameTime = Math.round(duration * 1e9);
  if (Math.abs(padding) > frameTime * count) throw new Error("Matroska DiscardPadding exceeds its laced block duration.");
  const preceding = padding < 0 ? frame : count - frame - 1;
  return Math.sign(padding) * Math.max(0, Math.min(frameTime, Math.abs(padding) - preceding * frameTime)) / 1e9;
}

function intervalCovered(declared, packets, interval) {
  if (!interval || !Number.isFinite(interval.to)) return false;
  const requested = [...declared].filter(([id, track]) => interval.trackIds
    ? interval.trackIds.includes(id) : ["video", "audio"].includes(track.type));
  return requested.length > 0 && requested.every(([id, track]) => {
    const depth = track.type === "video" ? track.reorderDepth : 0;
    if (!Number.isSafeInteger(depth) || depth < 0) return false;
    const stream = packets.get(id);
    return stream.length > depth && stream.slice(-(depth + 1)).every(packet => packet.pts >= interval.to);
  });
}

function buildIndex(declared, packets, durationSeconds, complete, interval, packetMemory) {
  const index = new PacketIndex();
  for (const [id, track] of declared) {
    index.declareTrack(id, { type: track.type, codecId: track.codecId, codecRanges: track.codecRanges ?? [], prerollSeconds: track.seekPrerollSeconds ?? 0, reorderDepth: track.reorderDepth ?? 0 });
    const stream = packets.get(id);
    let needsFollowing = false;
    for (let position = 0; position < stream.length; position++) {
      if (stream.durationAt(position) === 0 || stream.derivedDurationAt(position)) { needsFollowing = true; break; }
    }
    if (needsFollowing) {
      const endFor = followingPacketTime(stream, complete ? durationSeconds : null, packetMemory);
      try { for (let position = 0; position < stream.length; position++) {
        if (stream.durationAt(position) !== 0 && !stream.derivedDurationAt(position)) continue;
        const pts = stream.ptsAt(position), end = endFor(pts);
        stream.setDuration(position, Number.isFinite(end) && end > pts ? end - pts : 0, true);
      } } finally { endFor.dispose(); }
    }
    index.sharePackets(id, stream);
    if (complete) index.complete(id);
    else if (interval.trackIds ? interval.trackIds.includes(id) : ["video", "audio"].includes(track.type)) {
      index.coverThrough(id, interval.to);
    }
  }
  return index;
}

async function validHeader(reader, at, limit) {
  const element = await reader.header(at, limit);
  if (!element || (element.end !== null && element.end > limit)) throw new Error("Matroska element exceeds its parent.");
  return element;
}

async function blockGroup(reader, parent) {
  const result = { element: null, duration: null, referenced: false };
  for (let at = parent.dataOffset; at < parent.end;) {
    const child = await validHeader(reader, at, parent.end);
    if (child.end === null) throw new Error("Matroska BlockGroup child has unknown size.");
    if (child.id === 0xa1) {
      if (result.element) throw new Error("Matroska BlockGroup declares multiple Blocks.");
      result.element = child;
    }
    if (child.id === 0x9b) result.duration = readUint(await reader.bytes(child.dataOffset, child.size), 0, child.size);
    if (child.id === 0x75a2) {
      if (child.size < 1 || child.size > 8) throw new Error("Matroska DiscardPadding has an invalid integer size.");
      const bytes = await reader.bytes(child.dataOffset, child.size);
      const signed = Buffer.alloc(8, bytes[0] & 128 ? 255 : 0);
      bytes.copy(signed, 8 - bytes.length);
      const nanoseconds = Number(signed.readBigInt64BE());
      if (!Number.isSafeInteger(nanoseconds)) throw new Error("Matroska DiscardPadding exceeds its exact time range.");
      result.discardPaddingSeconds = nanoseconds / 1e9;
    }
    if (child.id === 0xfb) result.referenced = true;
    if (child.id === 0xa4) throw new Error("Matroska packet changes CodecState; its packet configuration must be indexed.");
    at = child.end;
  }
  return result;
}

/** Decode all lacing forms without copying a frame to inspect its length. */
async function frameRanges(reader, element, header) {
  let at = element.dataOffset + header.dataOffset;
  const lacing = header.flags & 6;
  if (!lacing) return [[at, element.end - 1]];
  const count = (await reader.bytes(at++, 1))[0] + 1;
  const sizes = [];
  if (lacing === 2) {
    for (let frame = 0; frame < count - 1; frame++) {
      let size = 0, byte;
      do {
        if (at >= element.end) throw new Error("Matroska Xiph lace is truncated.");
        byte = (await reader.bytes(at++, 1))[0];
        size += byte;
      } while (byte === 255);
      sizes.push(size);
    }
  } else if (lacing === 6) {
    for (let frame = 0; frame < count - 1; frame++) {
      const bytes = await reader.bytes(at, Math.min(8, element.end - at));
      const size = readVint(bytes, 0, false);
      if (!size || size.value === null) throw new Error("Matroska EBML lace is truncated.");
      at += size.length;
      sizes.push(frame === 0 ? Number(size.value) : sizes.at(-1) + Number(size.value) - (2 ** (7 * size.length - 1) - 1));
    }
  } else {
    if ((element.end - at) % count !== 0) throw new Error("Matroska fixed lace does not divide its payload.");
    for (let frame = 0; frame < count - 1; frame++) sizes.push((element.end - at) / count);
  }
  sizes.push(element.end - at - sizes.reduce((sum, size) => sum + size, 0));
  return sizes.map(size => {
    if (!Number.isSafeInteger(size) || size <= 0 || at + size > element.end) throw new Error("Matroska lace exceeds its frame data.");
    const range = [at, at + size - 1];
    at += size;
    return range;
  });
}
