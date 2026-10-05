import { PacketIndex } from "./PacketIndex.js";
import { PacketRecords } from "./PacketRecords.js";
import { RetainedBytes } from "./RetainedBytes.js";
import { mpegAudioFrame } from "./mpeg-audio-frame.js";
import { isMp3Codec } from "./mp3-packet-dependencies.js";

/** Fragment sample tables retain exact payload addresses and declared clocks. */
export async function readMp4Fragments({ readRange, fileSize, tracks, memory, state, firstTrackIds = null }) {
  if (!state.frames) {
    state.frames = new Map(tracks.map(track => [track.id, new PacketRecords(memory)]));
    state.clocks = new Map();
    state.at = 0;
    state.media = [];
  }
  while (state.at < fileSize) {
    const at = state.at;
    if (fileSize - at < 8) throw new Error("MP4 ends inside a fragment box header.");
    const header = await readRange(at, at + 7);
    const type = header.toString("latin1", 4, 8);
    const width = header.readUInt32BE() === 1 ? 16 : 8;
    const size = width === 16 ? Number((await readRange(at + 8, at + 15)).readBigUInt64BE()) :
      header.readUInt32BE() || fileSize - at;
    if (!Number.isSafeInteger(size) || size < width || size > fileSize - at) throw new Error("MP4 fragment box exceeds the file.");
    if (type === "mdat") state.media.push([at + width, at + size]);
    if (type === "moof") {
      const allocation = new RetainedBytes(memory);
      const lengths = new Map([...state.frames].map(([id, frames]) => [id, frames.length]));
      const clocks = new Map(state.clocks);
      try {
        const bytes = await allocation.read(size, () => readRange(at, at + size - 1));
        let precedingEnd = at;
        const fragments = children(bytes, width, bytes.length, "traf");
        if (!fragments.length) throw new Error("MP4 fragment has no track runs.");
        for (const traf of fragments) {
          const tfhd = child(bytes, traf.dataOffset, traf.end, "tfhd");
          if (!tfhd || tfhd.dataOffset + 8 > tfhd.end) throw new Error("MP4 fragment has no complete track header.");
          const flags = bytes.readUIntBE(tfhd.dataOffset + 1, 3);
          const id = bytes.readUInt32BE(tfhd.dataOffset + 4);
          const track = tracks.find(track => track.id === id);
          if (!track) throw new Error("MP4 fragment names an undeclared track.");
          let cursor = tfhd.dataOffset + 8;
          const take = width => {
            if (cursor + width > tfhd.end) throw new Error("MP4 fragment defaults are truncated.");
            const value = width === 8 ? Number(bytes.readBigUInt64BE(cursor)) : bytes.readUInt32BE(cursor);
            cursor += width;
            if (!Number.isSafeInteger(value)) throw new Error("MP4 fragment default exceeds its integer range.");
            return value;
          };
          const base = flags & 1 ? take(8) : flags & 0x20000 ? at : precedingEnd;
          const description = flags & 2 ? take(4) : track.description;
          if (description !== 1) throw new Error("MP4 fragment changes its sample description.");
          const defaultDuration = flags & 8 ? take(4) : track.duration;
          const defaultSize = flags & 16 ? take(4) : track.size;
          const defaultFlags = flags & 32 ? take(4) : track.flags;
          if (cursor !== tfhd.end) throw new Error("MP4 fragment defaults contain undeclared fields.");
          const tfdt = child(bytes, traf.dataOffset, traf.end, "tfdt");
          let decode = state.clocks.get(id) ?? 0;
          if (tfdt) {
            const wide = bytes[tfdt.dataOffset] === 1;
            if (bytes[tfdt.dataOffset] > 1 || tfdt.dataOffset + (wide ? 12 : 8) > tfdt.end) throw new Error("MP4 fragment decode clock is truncated.");
            decode = wide ? Number(bytes.readBigUInt64BE(tfdt.dataOffset + 4)) : bytes.readUInt32BE(tfdt.dataOffset + 4);
            if (!Number.isSafeInteger(decode)) throw new Error("MP4 fragment decode clock exceeds its integer range.");
          }
          let address = base;
          for (const trun of children(bytes, traf.dataOffset, traf.end, "trun")) {
            if (trun.dataOffset + 8 > trun.end || bytes[trun.dataOffset] > 1) throw new Error("MP4 fragment run header is invalid.");
            const runFlags = bytes.readUIntBE(trun.dataOffset + 1, 3);
            const count = bytes.readUInt32BE(trun.dataOffset + 4);
            let field = trun.dataOffset + 8;
            const read = signed => {
              if (field + 4 > trun.end) throw new Error("MP4 fragment sample field is truncated.");
              const value = signed ? bytes.readInt32BE(field) : bytes.readUInt32BE(field);
              field += 4;
              return value;
            };
            if (runFlags & 1) address = base + read(true);
            const firstFlags = runFlags & 4 ? read(false) : defaultFlags;
            for (let sample = 0; sample < count; sample++) {
              const duration = runFlags & 0x100 ? read(false) : defaultDuration;
              const size = runFlags & 0x200 ? read(false) : defaultSize;
              const flags = runFlags & 0x400 ? read(false) : sample === 0 ? firstFlags : defaultFlags;
              const composition = runFlags & 0x800 ? read(bytes[trun.dataOffset] === 1) : 0;
              if (!(duration > 0) || !(size > 0) || !Number.isSafeInteger(address) || address < 0 ||
                  address + size > fileSize || !Number.isSafeInteger(decode + duration)) throw new Error("MP4 fragment sample timing or address is invalid.");
              if (track.track.codecId === "mpeg_audio") {
                if (size < 4) throw new Error("MP4 MPEG audio first sample header is truncated.");
                const facts = mpegAudioFrame(await readRange(address, address + 3));
                track.track.codecId = facts.codecId;
                track.track.channels = facts.channels;
                track.track.samplingFrequency = facts.sampleRate;
              }
              state.frames.get(id).push({ pts: (decode + composition) / track.scale + track.shift,
                dts: decode / track.scale + track.shift, duration: duration / track.scale,
                ...(isMp3Codec(track.track.codecId) ? { decodeFromIndex: state.frames.get(id).length, decodeDependencyUnknown: true } : {}),
                keyframe: !(flags & 0x10000), ranges: [[address, address + size - 1]] });
              decode += duration;
              address += size;
            }
            if (field !== trun.end) throw new Error("MP4 fragment sample count differs from its run size.");
          }
          state.clocks.set(id, decode);
          precedingEnd = address;
        }
      } catch (error) {
        for (const [id, length] of lengths) state.frames.get(id).length = length;
        state.clocks = clocks;
        throw error;
      } finally { allocation.dispose(); }
    }
    state.at += size;
    if (firstTrackIds?.every(id => state.frames.get(id)?.length > 0)) return null;
  }
  const index = new PacketIndex({ packetMemory: memory });
  for (const track of tracks) {
    const frames = state.frames.get(track.id);
    for (const packet of frames) for (const [start, end] of packet.ranges) {
      if (!state.media.some(([from, to]) => from <= start && end < to)) throw new Error("MP4 fragment sample is outside its media data boxes.");
    }
    index.declareTrack(track.id, { type: track.track.type, codecId: track.track.codecId,
      prerollSeconds: track.track.seekPrerollSeconds ?? 0, reorderDepth: track.track.reorderDepth ?? 0 });
    index.sharePackets(track.id, frames);
    index.complete(track.id);
  }
  return index;
}

function children(bytes, start, end, wanted) {
  const found = [];
  for (let at = start; at < end;) {
    if (end - at < 8) throw new Error("MP4 fragment child header is truncated.");
    const stated = bytes.readUInt32BE(at);
    const width = stated === 1 ? 16 : 8;
    if (end - at < width) throw new Error("MP4 fragment extended child header is truncated.");
    const size = stated === 1 ? Number(bytes.readBigUInt64BE(at + 8)) : stated || end - at;
    if (!Number.isSafeInteger(size) || size < width || size > end - at) {
      throw new Error("MP4 fragment child exceeds its parent.");
    }
    if (bytes.toString("latin1", at + 4, at + 8) === wanted) found.push({ dataOffset: at + width, end: at + size });
    at += size;
  }
  return found;
}

function child(bytes, start, end, wanted) {
  const found = children(bytes, start, end, wanted);
  if (found.length > 1) throw new Error(`MP4 fragment repeats ${wanted}.`);
  return found[0] ?? null;
}
