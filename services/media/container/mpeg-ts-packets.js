import { pesPayload } from "./pes-header.js";
import { MpegElementaryIndex } from "./mpeg-elementary-index.js";

/** Incremental TS demultiplexing with exact elementary-payload addresses. */
export async function readMpegTsPackets({ readRange, fileSize, layout, tracks, state, interval, stopWhen, packetMemory }) {
  state.elementary ??= new MpegElementaryIndex(tracks, { packetMemory });
  state.pids ??= new Map();
  state.offset ??= 0;
  state.elementary.index.flushPending();
  if (state.complete) return state.elementary.index;
  if (interval && ready(state.elementary.index, tracks, interval)) return state.elementary.index;
  const wanted = new Set(tracks.filter(track => ["audio", "video"].includes(track.type)).map(track => track.trackNumber));
  const { width, sync } = layout;
  while (state.offset + width <= fileSize) {
    const sourceStart = state.offset + sync;
    const packet = await readRange(sourceStart, sourceStart + 187);
    if (packet[0] !== 0x47 || packet[1] & 0x80) throw new Error("MPEG-TS media packet is damaged.");
    const pid = ((packet[1] & 31) << 8) | packet[2];
    const control = (packet[3] >> 4) & 3;
    if (!control) throw new Error("MPEG-TS adaptation control is invalid.");
    const offset = control === 3 ? 5 + packet[4] : 4;
    if (offset > 188 || (control === 2 && packet[4] > 183)) throw new Error("MPEG-TS adaptation field exceeds its packet.");
    if (wanted.has(pid) && control !== 2 && offset < 188) {
      if (packet[3] & 0xc0) throw new Error("MPEG-TS media is scrambled.");
      let pes = state.pids.get(pid);
      const counter = packet[3] & 15;
      const duplicate = pes?.counter === counter;
      const discontinuity = control === 3 && packet[4] > 0 && (packet[5] & 0x80) !== 0;
      if (!duplicate) {
        if (pes && !discontinuity && counter !== ((pes.counter + 1) & 15)) throw new Error("MPEG-TS media has missing packets.");
        if (packet[1] & 0x40) {
          if (pes?.remaining > 0) throw new Error("MPEG-TS PES ended before its declared length.");
          pes = { counter, parts: [], header: null, remaining: null, timestampGiven: false };
          state.pids.set(pid, pes);
        }
        if (pes) {
          pes.counter = counter;
          feed(state.elementary, pid, pes, packet.subarray(offset), sourceStart + offset);
        }
      }
    }
    state.offset += width;
    state.elementary.index.flushPending();
    if (stopWhen?.(state.elementary.index)) return state.elementary.index;
    if (interval && ready(state.elementary.index, tracks, interval)) return state.elementary.index;
  }
  if (state.offset !== fileSize) throw new Error("MPEG-TS ends inside a transport packet.");
  for (const pes of state.pids.values()) {
    if (!pes.header || pes.remaining > 0) throw new Error("MPEG-TS ends inside a PES packet.");
  }
  const index = state.elementary.complete();
  state.complete = true;
  index.flushPending();
  return index;
}

function feed(index, pid, pes, bytes, sourceStart) {
  if (pes.header) return payload(index, pid, pes, bytes, sourceStart);
  pes.parts.push({ bytes, sourceStart });
  const header = Buffer.concat(pes.parts.map(part => part.bytes));
  if (header.length < 9) return;
  if (header[0] !== 0 || header[1] !== 0 || header[2] !== 1 || (header[6] & 0xc0) !== 0x80) throw new Error("MPEG-TS PES header is invalid.");
  const size = 9 + header[8];
  if (header.length < size) return;
  const optional = pesPayload(header.subarray(6, size));
  const declared = header.readUInt16BE(4);
  if (!declared && (header[3] < 0xe0 || header[3] > 0xef)) throw new Error("Only MPEG-TS video PES may omit its length.");
  if (declared && declared < size - 6) throw new Error("MPEG-TS PES length excludes its header.");
  pes.header = optional;
  pes.remaining = declared ? declared - (size - 6) : null;
  let skip = size;
  for (const part of pes.parts) {
    const count = Math.min(skip, part.bytes.length);
    skip -= count;
    if (count < part.bytes.length) payload(index, pid, pes, part.bytes.subarray(count), part.sourceStart + count);
  }
  pes.parts = [];
}

function payload(index, pid, pes, bytes, sourceStart) {
  const size = pes.remaining === null ? bytes.length : Math.min(pes.remaining, bytes.length);
  if (!size) return;
  index.push(pid, bytes.subarray(0, size), sourceStart, pes.timestampGiven ? {} : pes.header);
  pes.timestampGiven = true;
  if (pes.remaining !== null) pes.remaining -= size;
}

export function ready(index, tracks, interval) {
  const results = tracks.filter(track => ["audio", "video"].includes(track.type) &&
    (!interval.trackIds || interval.trackIds.includes(track.trackNumber))).map(track =>
    index.inputFor({ trackId: track.trackNumber, from: interval.from, to: interval.to }));
  return results.some(result => result.kind === "terminal") || results.every(result => result.kind === "result");
}
