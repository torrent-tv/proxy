import { pesPayload } from "./pes-header.js";
export { pesPayload } from "./pes-header.js";
import { Container } from "./Container.js";
import { VideoTrack } from "../tracks/VideoTrack.js";
import { AudioTrack } from "../tracks/AudioTrack.js";
import { ContainerTrack } from "../tracks/ContainerTrack.js";
import { mpegSectionCrc } from "./MpegTsContainer.js";
import { mpegVideoConfiguration } from "./mpeg-video-configuration.js";
import { MpegElementaryIndex } from "./mpeg-elementary-index.js";
import { ready } from "./mpeg-ts-packets.js";

const TYPES = new Map([[1, ["video", "mpeg1video"]], [2, ["video", "mpeg2video"]],
  [0x10, ["video", "mpeg4"]], [0x1b, ["video", "h264"]], [0x24, ["video", "hevc"]],
  [3, ["audio", "mp2"]], [4, ["audio", "mp2"]], [0x0f, ["audio", "aac"]],
  [0x81, ["audio", "ac3"]], [0x87, ["audio", "eac3"]]]);

/** Program stream declarations and PES headers, without source-read waits. */
export class MpegPsContainer extends Container {
  #offset = 0;
  #streams = new Map();
  #tracks = null;
  #mapRead = false;
  #firstTime = null;
  #lastTime = null;
  #videoPrefixes = new Map();
  #packetState = { offset: 0, current: null, elementary: null, complete: false };
  #duration = null;

  get formatName() { return "mpegps"; }
  packetIndexBytes() { return this.#packetState.elementary?.index.allocatedBytes() ?? 0; }
  static detect(head) {
    return head.length >= 5 && head[0] === 0 && head[1] === 0 && head[2] === 1 &&
      (head[3] === 0xba || head[3] === 0xbb);
  }

  async readTracks() {
    if (this.#tracks) return this.#tracks;
    await this.#scan(true);
    const counts = new Map();
    this.#tracks = [...this.#streams].map(([trackNumber, stream]) => {
      const declaredIndex = counts.get(stream.type) ?? 0;
      counts.set(stream.type, declaredIndex + 1);
      const params = { ...stream, trackNumber, declaredIndex, isEnabled: true, isDefault: false, declaresDefault: false };
      return stream.type === "video" ? new VideoTrack(params) : stream.type === "audio" ? new AudioTrack(params) : new ContainerTrack(params);
    });
    return this.#tracks;
  }

  async readMediaInfo() {
    const tracks = await this.readTracks();
    const picture = tracks.find(track => track.type === "video");
    if (["h264", "hevc"].includes(picture?.codecId)) {
      const index = await this.#readPackets(tracks, null, () => picture.codecPrivateB64 &&
        this.#packetState.elementary.index.boundsOf(picture.trackNumber) !== null);
      const bounds = index.boundsOf(picture.trackNumber);
      return { format: this.formatName, startTimeSeconds: bounds?.start ?? null,
        durationSeconds: this.#duration };
    }
    if (picture && (this.#videoPrefixes.size === 0 || this.#firstTime === null)) await this.#scan(false, true);
    for (const track of tracks.filter(track => track.type === "video")) {
      const prefix = this.#videoPrefixes.get(track.trackNumber);
      const facts = prefix && mpegVideoConfiguration(prefix);
      if (facts) Object.assign(track, facts, { codecId: track.codecId || facts.codecId });
    }
    return { format: this.formatName, startTimeSeconds: this.#firstTime,
      durationSeconds: this.#duration };
  }

  async readPacketIndex(interval) {
    const tracks = await this.readTracks();
    await this.readMediaInfo();
    return this.#readPackets(tracks, interval);
  }

  async #readPackets(tracks, interval, stopWhen = null) {
    const state = this.#packetState;
    state.elementary ??= new MpegElementaryIndex(tracks, { packetMemory: this.packetMemory });
    state.elementary.index.flushPending();
    if (state.complete) {
      this.#noteDuration(state.elementary.index, tracks);
      return state.elementary.index;
    }
    if (interval && ready(state.elementary.index, tracks, interval)) return state.elementary.index;
    while (state.offset < this.fileSize) {
      if (!state.current) {
        const prefix = await this.readRange(state.offset, state.offset + 3);
        if (prefix.length !== 4 || prefix[0] !== 0 || prefix[1] !== 0 || prefix[2] !== 1) throw new Error("MPEG-PS lost packet synchronization.");
        const id = prefix[3];
        if (id === 0xb9) { state.offset += 4; break; }
        if (id === 0xba) {
          const version = await this.readRange(state.offset + 4, state.offset + 4);
          let size;
          if ((version[0] & 0xc0) === 0x40) {
            const pack = await this.readRange(state.offset + 4, state.offset + 13);
            size = 14 + (pack[9] & 7);
          } else if ((version[0] & 0xf0) === 0x20) size = 12;
          else throw new Error("MPEG-PS pack version is invalid.");
          if (state.offset + size > this.fileSize) throw new Error("MPEG-PS pack exceeds the file.");
          state.offset += size;
          continue;
        }
        const sizeBytes = await this.readRange(state.offset + 4, state.offset + 5);
        const size = sizeBytes.readUInt16BE();
        if (!size && (id < 0xe0 || id > 0xef)) throw new Error("Only MPEG-PS video PES may omit its length.");
        const end = size ? state.offset + 6 + size : await this.#nextPacket(state.offset + 6);
        if (end > this.fileSize) throw new Error("MPEG-PS packet exceeds the file.");
        if (id !== 0xbd && !tracks.some(track => track.trackNumber === id && ["video", "audio"].includes(track.type))) {
          state.offset = end;
          continue;
        }
        const headerBytes = await this.readRange(state.offset + 6, Math.min(end - 1, state.offset + 270));
        const header = pesPayload(headerBytes);
        let start = state.offset + 6 + header.offset;
        let trackId = id;
        if (id === 0xbd) {
          if (start + 4 > end) throw new Error("MPEG-PS private audio header is truncated.");
          const privateHeader = await this.readRange(start, start + 3);
          trackId = privateHeader[0];
          if (!tracks.some(track => track.trackNumber === trackId && track.type === "audio" && ["ac3", "dts"].includes(track.codecId))) {
            state.offset = end;
            continue;
          }
          start += 4;
        }
        if (start > end) throw new Error("MPEG-PS PES header exceeds its packet.");
        state.current = { id: trackId, end, cursor: start, header, timestampGiven: false };
      }
      const current = state.current;
      while (current.cursor < current.end) {
        const size = Math.min(current.end - current.cursor, this.portionBytes);
        const bytes = await this.readRange(current.cursor, current.cursor + size - 1);
        state.elementary.push(current.id, bytes, current.cursor, current.timestampGiven ? {} : current.header);
        current.timestampGiven = true;
        current.cursor += size;
        state.elementary.index.flushPending();
        if (stopWhen?.()) return state.elementary.index;
      }
      state.offset = current.end;
      state.current = null;
      if (interval && ready(state.elementary.index, tracks, interval)) return state.elementary.index;
    }
    if (state.offset !== this.fileSize) throw new Error("MPEG-PS has bytes after its program end.");
    const index = state.elementary.complete();
    state.complete = true;
    index.flushPending();
    this.#noteDuration(index, tracks);
    return index;
  }

  #noteDuration(index, tracks) {
    const timed = tracks.find(track => track.type === "video") ?? tracks.find(track => track.type === "audio");
    const bounds = timed && index.boundsOf(timed.trackNumber);
    if (bounds) {
      this.#firstTime = bounds.start;
      this.#duration = bounds.end - bounds.start;
    }
  }

  async #scan(stopAtMap, stopAtPicture = false) {
    while (this.#offset < this.fileSize) {
      if (this.#offset + 4 > this.fileSize) throw new Error("MPEG-PS start code is truncated.");
      const prefix = await this.readRange(this.#offset, this.#offset + 3);
      if (prefix[0] !== 0 || prefix[1] !== 0 || prefix[2] !== 1) throw new Error("MPEG-PS lost packet synchronization.");
      const id = prefix[3];
      if (id === 0xb9) { this.#offset += 4; break; }
      if (id === 0xba) {
        const version = await this.readRange(this.#offset + 4, this.#offset + 4);
        let size;
        if ((version[0] & 0xc0) === 0x40) {
          const pack = await this.readRange(this.#offset + 4, this.#offset + 13);
          size = 14 + (pack[9] & 7);
        } else if ((version[0] & 0xf0) === 0x20) size = 12;
        else throw new Error("MPEG-PS pack version is invalid.");
        if (this.#offset + size > this.fileSize) throw new Error("MPEG-PS pack exceeds the file.");
        this.#offset += size;
        continue;
      }
      const lengthBytes = await this.readRange(this.#offset + 4, this.#offset + 5);
      const length = lengthBytes.readUInt16BE();
      if (length === 0 && (id < 0xe0 || id > 0xef)) throw new Error("Only MPEG-PS video PES may omit its length.");
      const end = length === 0 ? await this.#nextPacket(this.#offset + 6) : this.#offset + 6 + length;
      if (end > this.fileSize) throw new Error("MPEG-PS packet exceeds the file.");
      if (id === 0xbc) {
        const map = await this.readRange(this.#offset, end - 1);
        this.#programMap(map);
      } else if ((id >= 0xc0 && id <= 0xef) || id === 0xbd || id === 0xfd) {
        const bytes = await this.readRange(this.#offset + 6, Math.min(end - 1, this.#offset + 6 + 264));
        const payload = pesPayload(bytes);
        if (id >= 0xe0 && id <= 0xef && !this.#videoPrefixes.has(id) &&
          bytes.indexOf(Buffer.from([0, 0, 1, 0xb3]), payload.offset) >= 0) {
          this.#videoPrefixes.set(id, Buffer.from(bytes.subarray(payload.offset)));
        }
        if (payload.pts !== null) {
          if (this.#firstTime === null) this.#firstTime = payload.pts;
          this.#lastTime = Math.max(this.#lastTime ?? payload.pts, payload.pts);
        }
        if (!this.#mapRead) {
          if (id >= 0xe0 && id <= 0xef) this.#streams.set(id, { type: "video", codecId: this.#streams.get(id)?.codecId || videoCodec(bytes.subarray(payload.offset)) });
          else if (id >= 0xc0 && id <= 0xdf) this.#streams.set(id, { type: "audio", codecId: this.#streams.get(id)?.codecId || audioCodec(bytes.subarray(payload.offset)) });
          else if (id === 0xfd) this.#streams.set(id, { type: "video", codecId: "" });
          else if (payload.offset < bytes.length) {
            const substream = bytes[payload.offset];
            if (substream >= 0x80 && substream <= 0x87) this.#streams.set(substream, { type: "audio", codecId: "ac3" });
            else if (substream >= 0x88 && substream <= 0x8f) this.#streams.set(substream, { type: "audio", codecId: "dts" });
            else if (substream >= 0xa0 && substream <= 0xaf) this.#streams.set(substream, { type: "audio", codecId: "pcm_dvd" });
            else if (substream >= 0x20 && substream <= 0x3f) this.#streams.set(substream, { type: "subtitle", codecId: "dvd_subtitle" });
          }
        }
      }
      this.#offset = end;
      if (stopAtMap && this.#mapRead) break;
      if (stopAtPicture && this.#videoPrefixes.size > 0 && this.#firstTime !== null) break;
    }
  }

  async #nextPacket(start) {
    let cursor = start, carry = Buffer.alloc(0);
    while (cursor < this.fileSize) {
      const width = Math.min(this.fileSize - cursor, this.portionBytes);
      const chunk = await this.readRange(cursor, cursor + width - 1);
      const bytes = Buffer.concat([carry, chunk]);
      for (let at = 0; at + 3 < bytes.length; at++) {
        // Elementary picture, sequence and GOP start codes remain PES payload.
        if (bytes[at] === 0 && bytes[at + 1] === 0 && bytes[at + 2] === 1 && bytes[at + 3] >= 0xb9) {
          return cursor - carry.length + at;
        }
      }
      carry = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 3)));
      cursor += width;
    }
    return this.fileSize;
  }

  #programMap(bytes) {
    if (bytes.length < 16 || mpegSectionCrc(bytes) !== 0) throw new Error("MPEG-PS program map is invalid.");
    if (!(bytes[6] & 0x80)) return;
    const infoLength = bytes.readUInt16BE(8);
    let at = 10 + infoLength;
    if (at + 2 > bytes.length - 4) throw new Error("MPEG-PS program descriptors exceed its map.");
    const end = at + 2 + bytes.readUInt16BE(at);
    at += 2;
    if (end !== bytes.length - 4) throw new Error("MPEG-PS elementary map length is invalid.");
    const streams = new Map();
    while (at < end) {
      if (at + 4 > end) throw new Error("MPEG-PS stream declaration is truncated.");
      const [type, codecId] = TYPES.get(bytes[at]) ?? ["other", ""];
      const number = bytes[at + 1];
      const next = at + 4 + bytes.readUInt16BE(at + 2);
      if (next > end) throw new Error("MPEG-PS stream descriptors exceed its map.");
      streams.set(number, { type, codecId });
      at = next;
    }
    this.#streams = streams;
    this.#mapRead = true;
  }
}

function videoCodec(bytes) {
  for (let at = 0; at + 4 < bytes.length; at++) {
    if (bytes[at] === 0 && bytes[at + 1] === 0 && bytes[at + 2] === 1 &&
      (bytes[at + 3] & 0x9f) === 7) return "h264";
  }
  const sequence = bytes.indexOf(Buffer.from([0, 0, 1, 0xb3]));
  if (sequence < 0) return "";
  const extension = bytes.indexOf(Buffer.from([0, 0, 1, 0xb5]), sequence + 4);
  if (extension >= 0 && (bytes[extension + 4] >> 4) === 1) return "mpeg2video";
  if (bytes.indexOf(Buffer.from([0, 0, 1, 0xb8]), sequence + 4) >= 0 ||
    bytes.indexOf(Buffer.from([0, 0, 1, 0]), sequence + 4) >= 0) return "mpeg1video";
  return "";
}

function audioCodec(bytes) {
  for (let at = 0; at + 3 < bytes.length; at++) {
    if (bytes[at] !== 0xff || (bytes[at + 1] & 0xe0) !== 0xe0) continue;
    const layer = (bytes[at + 1] >> 1) & 3;
    const version = (bytes[at + 1] >> 3) & 3;
    if (version === 1 || layer === 0 || (bytes[at + 2] >> 4) === 15 || ((bytes[at + 2] >> 2) & 3) === 3) continue;
    return layer === 1 ? "mp3" : layer === 2 ? "mp2" : "mp1";
  }
  return "";
}
