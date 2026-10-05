import { Container } from "./Container.js";
import { VideoTrack } from "../tracks/VideoTrack.js";
import { AudioTrack } from "../tracks/AudioTrack.js";
import { ContainerTrack } from "../tracks/ContainerTrack.js";
import { pesPayload } from "./pes-header.js";
import { MpegSequenceReader } from "./mpeg-sequence-reader.js";
import { readMpegTsPackets } from "./mpeg-ts-packets.js";

// ISO/IEC 13818-1 stream_type values; private streams are identified by descriptors.
const STREAM_TYPES = new Map([
  [0x01, ["video", "mpeg1video"]], [0x02, ["video", "mpeg2video"]],
  [0x10, ["video", "mpeg4"]], [0x1b, ["video", "h264"]], [0x24, ["video", "hevc"]],
  [0x03, ["audio", "mp2"]], [0x04, ["audio", "mp2"]],
  [0x0f, ["audio", "aac"]], [0x11, ["audio", "aac_latm"]],
  [0x81, ["audio", "ac3"]], [0x87, ["audio", "eac3"]], [0x8a, ["audio", "dts"]]
]);

/** Program and track declarations read packet by packet from existing bytes. */
export class MpegTsContainer extends Container {
  #layout = null;
  #offset = 0;
  #sections = new Map();
  #programs = new Map();
  #programTables = new Map();
  #patSections = new Set();
  #lastPatSection = null;
  #tracks = null;
  #mediaOffset = 0;
  #mediaPrefixes = new Map();
  #mediaStart = null;
  #mediaRead = false;
  #packetState = {};
  #duration = null;

  get formatName() { return "mpegts"; }
  packetIndexBytes() { return this.#packetState.elementary?.index.allocatedBytes() ?? 0; }

  static detect(head) {
    return (head[0] === 0x47 && (head[3] & 0x30) !== 0) ||
      (head[4] === 0x47 && (head[7] & 0x30) !== 0);
  }

  async #packetLayout() {
    if (this.#layout) return this.#layout;
    const head = await this.readRange(0, Math.min(7, this.fileSize - 1));
    const sync = head[0] === 0x47 ? 0 : head[4] === 0x47 ? 4 : -1;
    if (sync < 0) throw new Error("MPEG-TS sync byte is absent.");
    const widths = sync === 4 ? [192] : [188, 204];
    for (const width of widths) {
      const next = width + sync;
      if (next >= this.fileSize) continue;
      const byte = await this.readRange(next, next);
      if (byte[0] !== 0x47) continue;
      if (next + width < this.fileSize) {
        const following = await this.readRange(next + width, next + width);
        if (following[0] !== 0x47) continue;
      }
      this.#layout = { width, sync };
      return this.#layout;
    }
    throw new Error("MPEG-TS packet spacing is invalid.");
  }

  async readTracks() {
    if (this.#tracks) return this.#tracks;
    const { width, sync } = await this.#packetLayout();
    while (this.#offset + width <= this.fileSize) {
      const raw = await this.readRange(this.#offset + sync, this.#offset + sync + 187);
      this.#consumePacket(raw);
      this.#offset += width;
      const patComplete = this.#lastPatSection !== null && this.#patSections.size === this.#lastPatSection + 1;
      if (!patComplete || this.#programs.size === 0 ||
        [...this.#programs.keys()].some(program => !this.#programTables.has(program))) continue;
      const streams = [...this.#programs.keys()].flatMap(program => this.#programTables.get(program));
      const counts = new Map();
      this.#tracks = streams.map(stream => {
        const declaredIndex = counts.get(stream.type) ?? 0;
        counts.set(stream.type, declaredIndex + 1);
        const params = { ...stream, trackNumber: stream.pid, declaredIndex, isEnabled: true, isDefault: false, declaresDefault: false };
        if (stream.type === "video") return new VideoTrack(params);
        if (stream.type === "audio") return new AudioTrack(params);
        return new ContainerTrack(params);
      });
      return this.#tracks;
    }
    throw new Error("MPEG-TS ends before its program tables are complete.");
  }

  async readMediaInfo() {
    const tracks = await this.readTracks();
    if (this.#mediaRead) return { format: this.formatName, durationSeconds: this.#duration, startTimeSeconds: this.#mediaStart };
    const video = tracks.find(track => track.type === "video");
    if (["h264", "hevc"].includes(video?.codecId)) {
      const index = await readMpegTsPackets({ readRange: this.readRange, fileSize: this.fileSize,
        packetMemory: this.packetMemory,
        layout: await this.#packetLayout(), tracks, state: this.#packetState,
        stopWhen: value => video.codecPrivateB64 && value.boundsOf(video.trackNumber) !== null });
      const bounds = index.boundsOf(video.trackNumber);
      if (bounds) {
        this.#mediaStart = bounds.start;
        this.#mediaRead = true;
        if (index.isComplete()) this.#duration = bounds.end - bounds.start;
      }
      return { format: this.formatName, durationSeconds: this.#duration, startTimeSeconds: this.#mediaStart };
    }
    if (!video) {
      this.#mediaRead = true;
      return { format: this.formatName, durationSeconds: null, startTimeSeconds: null };
    }
    const { width, sync } = await this.#packetLayout();
    while (this.#mediaOffset + width <= this.fileSize) {
      const packet = await this.readRange(this.#mediaOffset + sync, this.#mediaOffset + sync + 187);
      const pid = ((packet[1] & 31) << 8) | packet[2];
      if (packet[0] !== 0x47 || packet[1] & 0x80) throw new Error("MPEG-TS media packet is damaged.");
      const control = (packet[3] >> 4) & 3;
      if (!control) throw new Error("MPEG-TS adaptation control is invalid.");
      const offset = control === 3 ? 5 + packet[4] : 4;
      if (offset > 188) throw new Error("MPEG-TS adaptation field exceeds its packet.");
      if (pid === video.trackNumber && control !== 2 && offset < 188) {
        if (packet[3] & 0xc0) throw new Error("MPEG-TS media is scrambled.");
        const payload = packet.subarray(offset);
        let state = this.#mediaPrefixes.get(pid);
        const counter = packet[3] & 15;
        if (packet[1] & 0x40) state = { bytes: Buffer.alloc(0), header: null,
          sequence: state?.sequence ?? new MpegSequenceReader(video.codecId), counter: (counter + 15) & 15 };
        if (state && counter !== state.counter) {
          if (counter !== ((state.counter + 1) & 15)) throw new Error("MPEG-TS media has missing packets.");
          let elementary = payload;
          if (!state.header) {
            const prefix = Buffer.concat([state.bytes, payload]);
            if (prefix.length >= 9) {
              if (prefix[0] !== 0 || prefix[1] !== 0 || prefix[2] !== 1) throw new Error("MPEG-TS PES prefix is invalid.");
              if ((prefix[6] & 0xc0) !== 0x80) throw new Error("MPEG-TS requires an MPEG-2 PES header.");
              if (prefix.length >= 9 + prefix[8]) {
                state.header = pesPayload(prefix.subarray(6));
                elementary = prefix.subarray(6 + state.header.offset);
              }
            }
            state.bytes = state.header ? Buffer.alloc(0) : Buffer.from(prefix);
            if (!state.header) elementary = Buffer.alloc(0);
          }
          const facts = ["mpeg1video", "mpeg2video"].includes(video.codecId) ? state.sequence.push(elementary) : null;
          state.counter = counter;
          this.#mediaPrefixes.set(pid, state);
          if (state.header?.pts !== null && state.header?.pts !== undefined && this.#mediaStart === null) this.#mediaStart = state.header.pts;
          if (facts) {
            Object.assign(video, facts, { codecId: video.codecId || facts.codecId });
            this.#mediaRead = true;
          }
        }
      }
      this.#mediaOffset += width;
      if (this.#mediaRead) break;
    }
    return { format: this.formatName, durationSeconds: null, startTimeSeconds: this.#mediaStart };
  }

  async readPacketIndex(interval) {
    const tracks = await this.readTracks();
    await this.readMediaInfo();
    const index = await readMpegTsPackets({ readRange: this.readRange, fileSize: this.fileSize,
      packetMemory: this.packetMemory,
      layout: await this.#packetLayout(), tracks, state: this.#packetState, interval });
    const timed = tracks.find(track => track.type === "video") ?? tracks.find(track => track.type === "audio");
    if (timed && index.boundsOf(timed.trackNumber)) {
      const bounds = index.boundsOf(timed.trackNumber);
      this.#mediaStart = bounds.start;
      if (index.isComplete()) this.#duration = bounds.end - bounds.start;
    }
    return index;
  }

  #consumePacket(packet) {
    if (packet[0] !== 0x47) throw new Error("MPEG-TS packet lost synchronization.");
    if (packet[1] & 0x80) throw new Error("MPEG-TS packet declares a transport error.");
    const pid = ((packet[1] & 0x1f) << 8) | packet[2];
    if (pid !== 0 && ![...this.#programs.values()].includes(pid)) return;
    const control = (packet[3] >> 4) & 3;
    if (control === 0) throw new Error("MPEG-TS adaptation control is invalid.");
    if (control === 2) return;
    if (packet[3] & 0xc0) throw new Error("MPEG-TS program table is scrambled.");
    const offset = control === 3 ? 5 + packet[4] : 4;
    if (offset > 188) throw new Error("MPEG-TS adaptation field exceeds its packet.");
    if (offset === 188) return;
    let state = this.#sections.get(pid);
    if (!state) {
      state = { bytes: Buffer.alloc(0), counter: null };
      this.#sections.set(pid, state);
    }
    const counter = packet[3] & 15;
    if (counter === state.counter) return;
    const start = (packet[1] & 0x40) !== 0;
    if (state.counter !== null && counter !== ((state.counter + 1) & 15) && state.bytes.length > 0) {
      throw new Error("MPEG-TS program table has missing packets.");
    }
    state.counter = counter;
    const payload = packet.subarray(offset);
    if (start) {
      const pointer = payload[0];
      if (pointer + 1 > payload.length) throw new Error("MPEG-TS section pointer exceeds its packet.");
      if (state.bytes.length) this.#appendSections(pid, state, payload.subarray(1, pointer + 1));
      if (state.bytes.length) throw new Error("MPEG-TS section ended before its declared length.");
      this.#appendSections(pid, state, payload.subarray(pointer + 1));
    } else if (state.bytes.length) {
      this.#appendSections(pid, state, payload);
    }
  }

  #appendSections(pid, state, bytes) {
    state.bytes = Buffer.concat([state.bytes, bytes]);
    while (state.bytes.length > 0) {
      if (state.bytes[0] === 0xff) { state.bytes = Buffer.alloc(0); return; }
      if (state.bytes.length < 3) return;
      const length = 3 + (((state.bytes[1] & 15) << 8) | state.bytes[2]);
      if (length < 12 || length > 1024) throw new Error("MPEG-TS program section length is invalid.");
      if (state.bytes.length < length) return;
      const section = state.bytes.subarray(0, length);
      state.bytes = state.bytes.subarray(length);
      if (mpegSectionCrc(section) !== 0) throw new Error("MPEG-TS program section CRC is invalid.");
      if (!(section[5] & 1)) continue;
      if (pid === 0 && section[0] === 0) this.#readPat(section);
      else if (section[0] === 2) this.#readPmt(section);
    }
  }

  #readPat(section) {
    this.#lastPatSection = section[7];
    this.#patSections.add(section[6]);
    for (let offset = 8; offset + 4 <= section.length - 4; offset += 4) {
      const program = section.readUInt16BE(offset);
      if (program !== 0) this.#programs.set(program, section.readUInt16BE(offset + 2) & 0x1fff);
    }
  }

  #readPmt(section) {
    const program = section.readUInt16BE(3);
    if (!this.#programs.has(program)) return;
    if (section[6] !== 0 || section[7] !== 0) throw new Error("MPEG-TS PMT section numbering is invalid.");
    const streams = [];
    let offset = 12 + (section.readUInt16BE(10) & 0x0fff);
    while (offset < section.length - 4) {
      if (offset + 5 > section.length - 4) throw new Error("MPEG-TS stream declaration is truncated.");
      const streamType = section[offset];
      const pid = section.readUInt16BE(offset + 1) & 0x1fff;
      const end = offset + 5 + (section.readUInt16BE(offset + 3) & 0x0fff);
      if (end > section.length - 4) throw new Error("MPEG-TS descriptor exceeds its section.");
      let [type, codecId] = STREAM_TYPES.get(streamType) ?? ["other", ""];
      let language = "";
      for (let at = offset + 5; at < end;) {
        if (at + 2 > end || at + 2 + section[at + 1] > end) throw new Error("MPEG-TS descriptor is truncated.");
        const tag = section[at];
        const data = section.subarray(at + 2, at + 2 + section[at + 1]);
        if (tag === 0x0a && data.length >= 4) language = data.subarray(0, 3).toString("ascii");
        if (streamType === 0x06) {
          if (tag === 0x6a) [type, codecId] = ["audio", "ac3"];
          if (tag === 0x7a) [type, codecId] = ["audio", "eac3"];
          if (tag === 0x7b) [type, codecId] = ["audio", "dts"];
          if (tag === 0x59) [type, codecId] = ["subtitle", "dvb_subtitle"];
        }
        at += 2 + data.length;
      }
      streams.push({ pid, type, codecId, language, declaresLanguage: language.length > 0 });
      offset = end;
    }
    this.#programTables.set(program, streams);
  }
}

/** MPEG-2 section CRC-32: polynomial 0x04c11db7, no reflection or final XOR. */
export function mpegSectionCrc(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0);
  }
  return crc >>> 0;
}
