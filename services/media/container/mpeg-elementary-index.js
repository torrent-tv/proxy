import { mpegAudioFrame } from "./mpeg-audio-frame.js";
import { PacketIndex } from "./PacketIndex.js";
import { H264ElementaryIndex } from "./h264-elementary-index.js";
import { HevcElementaryIndex } from "./hevc-elementary-index.js";
import { LatmFrames } from "./latm-frame.js";
import { ac3Frame } from "./ac3-frame.js";
import { dtsFrame } from "./dts-frame.js";
import { MpegAudioReservoir } from "./mpeg-audio-reservoir.js";

/** Preserve elementary-frame addresses while transport packets are discarded. */
export class MpegElementaryIndex {
  index;
  #states = new Map();
  #completed = false;

  constructor(tracks, { packetMemory, index = null } = {}) {
    this.index = index ?? new PacketIndex({ packetMemory, deferMemory: true });
    for (const track of tracks.filter(track => ["video", "audio"].includes(track.type))) {
      if (!index) this.index.declareTrack(track.trackNumber, { type: track.type, codecId: track.codecId });
      const supported = track.type === "video" ? ["mpeg1video", "mpeg2video", "h264", "hevc"].includes(track.codecId)
        : ["mp1", "mp2", "mp3", "aac", "aac_latm", "ac3", "eac3", "dts"].includes(track.codecId);
      if (!supported) {
        this.index.refuse(track.trackNumber, `elementary-index-unavailable:${track.codecId || "unknown"}`);
        continue;
      }
      this.#states.set(track.trackNumber, { track, offset: 0, mappings: [], stamps: [], carry: Buffer.alloc(0),
        latm: track.codecId === "aac_latm" ? new LatmFrames() : null,
        nalIndex: track.codecId === "h264" ? new H264ElementaryIndex(track, this.index)
          : track.codecId === "hevc" ? new HevcElementaryIndex(track, this.index) : null,
        picture: null, pendingStart: 0, lastPicture: -1, presentationBase: null, lastDts: null, referencePts: null,
        audioBytes: Buffer.alloc(0), audioStart: 0, audioPts: null, lastTimestamp: null, clockShift: 0,
        reservoir: new MpegAudioReservoir(), packetCount: 0,
        lastExtension: -1, requiresStamp: false });
    }
  }

  push(id, bytes, sourceStart, { pts = null, dts = null } = {}) {
    const state = this.#states.get(id);
    if (!state || bytes.length === 0) return;
    const position = state.offset;
    if (!state.nalIndex) state.mappings.push({ from: position, to: position + bytes.length, sourceStart });
    let normalized = null;
    if (pts !== null) {
      const cycle = 2 ** 33 / 90000;
      const clock = dts ?? pts;
      if (state.lastTimestamp === null) {
        if (clock > pts + cycle / 2) state.clockShift -= cycle;
        else if (clock < pts - cycle / 2) state.clockShift += cycle;
      } else {
        if (clock + state.clockShift < state.lastTimestamp - cycle / 2) state.clockShift += cycle;
        else if (clock + state.clockShift > state.lastTimestamp + cycle / 2) state.clockShift -= cycle;
      }
      state.lastTimestamp = clock + state.clockShift;
      let presentation = pts + state.clockShift;
      if (presentation < state.lastTimestamp - cycle / 2) presentation += cycle;
      else if (presentation > state.lastTimestamp + cycle / 2) presentation -= cycle;
      normalized = { position, pts: presentation, dts: state.lastTimestamp };
      if (!state.nalIndex) state.stamps.push(normalized);
    }
    state.offset += bytes.length;
    if (state.nalIndex) state.nalIndex.push(bytes, sourceStart, normalized);
    else if (state.track.type === "video") this.#video(state, bytes, position);
    else this.#audio(state, bytes);
  }

  complete() {
    if (this.#completed) return this.index;
    for (const state of this.#states.values()) {
      if (state.nalIndex) { state.nalIndex.complete(); continue; }
      if (state.track.type === "video" && state.picture) this.#closePicture(state, state.offset);
      if (state.track.type === "audio" && state.audioBytes.length) throw new Error("MPEG audio ends inside a frame.");
      this.index.complete(state.track.trackNumber);
    }
    this.#completed = true;
    return this.index;
  }

  #video(state, chunk, position) {
    const bytes = Buffer.concat([state.carry, chunk]);
    const base = position - state.carry.length;
    for (let at = 0; at + 3 < bytes.length; at++) {
      if (bytes[at] !== 0 || bytes[at + 1] !== 0 || bytes[at + 2] !== 1) continue;
      const offset = base + at, code = bytes[at + 3];
      if (code === 0xb5 && at + 9 <= bytes.length && bytes[at + 4] >> 4 === 8 &&
        state.picture && offset > state.lastExtension) {
        if ((bytes[at + 6] & 3) !== 3) throw new Error("MPEG field pictures require field-specific packet timing.");
        const repeat = (bytes[at + 7] & 2) !== 0;
        const top = (bytes[at + 7] & 128) !== 0;
        const progressiveFrame = (bytes[at + 8] & 128) !== 0;
        if (repeat) {
          if (!progressiveFrame) throw new Error("MPEG repeated fields require field-specific packet timing.");
          state.picture.duration *= state.track.progressiveSequence ? top ? 3 : 2 : 1.5;
          state.requiresStamp = true;
        }
        state.lastExtension = offset;
      }
      if ((code === 0xb3 || code === 0xb8) && offset > state.lastPicture) {
        if (state.pendingStart === null) state.pendingStart = offset;
      }
      if (code !== 0 || at + 6 > bytes.length || offset <= state.lastPicture) continue;
      if (!(state.track.fps > 0)) throw new Error("MPEG video cadence is not declared.");
      const reference = (bytes[at + 4] << 2) | (bytes[at + 5] >> 6);
      const type = (bytes[at + 5] >> 3) & 7;
      if (type < 1 || type > 3) throw new Error("MPEG picture type is invalid.");
      const start = state.pendingStart ?? offset;
      if (state.picture) this.#closePicture(state, start);
      const stamp = stampAt(state, offset);
      if (state.requiresStamp && !stamp) throw new Error("MPEG repeated frames require an explicit following timestamp.");
      state.requiresStamp = false;
      if (stamp) state.presentationBase = stamp.pts - reference / state.track.fps;
      if (state.presentationBase === null) throw new Error("MPEG picture has no presentation timestamp.");
      const pts = stamp?.pts ?? state.presentationBase + reference / state.track.fps;
      const dts = stamp?.dts ?? (state.lastDts === null ? pts : state.lastDts + 1 / state.track.fps);
      state.picture = { start, pts, dts, duration: 1 / state.track.fps, keyframe: type === 1 };
      state.lastDts = dts;
      state.lastPicture = offset;
      state.pendingStart = null;
      if (type !== 3) {
        // The next reference picture proves that the preceding reference and
        // its intervening B pictures have all been read in decode order.
        if (state.referencePts !== null && pts > state.referencePts) this.index.coverThrough(state.track.trackNumber, Math.max(0, state.referencePts));
        state.referencePts = pts;
      }
    }
    state.carry = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 9)));
  }

  #closePicture(state, end) {
    const { start, ...packet } = state.picture;
    if (!(end > start)) throw new Error("MPEG picture has no bytes.");
    this.index.append(state.track.trackNumber, { ...packet, ranges: addresses(state, start, end) });
    state.mappings = state.mappings.filter(mapping => mapping.to > end);
  }

  #audio(state, chunk) {
    state.audioBytes = Buffer.concat([state.audioBytes, chunk]);
    while (state.audioBytes.length >= (state.track.codecId === "dts" ? 24 : ["aac", "ac3", "eac3"].includes(state.track.codecId) ? 7 : 4)) {
      const frame = state.latm ? state.latm.read(state.audioBytes) : state.track.codecId === "aac" ? adtsFrame(state.audioBytes)
        : ["ac3", "eac3"].includes(state.track.codecId) ? ac3Frame(state.audioBytes)
          : state.track.codecId === "dts" ? dtsFrame(state.audioBytes) : mpegAudioFrame(state.audioBytes);
      if (state.audioBytes.length < frame.size) break;
      const stamp = stampAt(state, state.audioStart);
      if (stamp) state.audioPts = stamp.pts;
      if (state.audioPts === null) throw new Error("MPEG audio frame has no presentation timestamp.");
      if (frame.codecPrivateB64) {
        if (state.track.codecPrivateB64 && state.track.codecPrivateB64 !== frame.codecPrivateB64) throw new Error("AAC configuration changes require packet-specific declarations.");
        state.track.codecPrivateB64 = frame.codecPrivateB64;
      }
      Object.assign(state.track, { codecId: frame.codecId, samplingFrequency: frame.sampleRate, channels: frame.channels });
      const reservoir = frame.codecId === "mp3" ? state.reservoir.prepare(state.audioBytes, frame.size, state.packetCount) : null;
      this.index.append(state.track.trackNumber, { pts: state.audioPts, dts: state.audioPts,
        ...(reservoir ? { decodeFromIndex: reservoir.decodeFromIndex } : {}),
        ...(frame.bitOffset === undefined ? {} : { bitOffset: frame.bitOffset, bitLength: frame.bitLength }),
        duration: frame.duration, keyframe: true, ranges: addresses(state, state.audioStart + (frame.headerBytes ?? 0), state.audioStart + frame.size) });
      reservoir?.commit();
      state.packetCount++;
      state.audioPts += frame.duration;
      this.index.coverThrough(state.track.trackNumber, Math.max(0, state.audioPts));
      state.audioStart += frame.size;
      state.audioBytes = state.audioBytes.subarray(frame.size);
      state.mappings = state.mappings.filter(mapping => mapping.to > state.audioStart);
    }
    state.audioBytes = Buffer.from(state.audioBytes);
  }
}

function stampAt(state, position) {
  let latest = null;
  while (state.stamps[0]?.position <= position) latest = state.stamps.shift();
  return latest;
}

function addresses(state, from, to) {
  const ranges = state.mappings.filter(mapping => mapping.from < to && mapping.to > from).map(mapping => [
    mapping.sourceStart + Math.max(from, mapping.from) - mapping.from,
    mapping.sourceStart + Math.min(to, mapping.to) - mapping.from - 1
  ]);
  if (ranges.reduce((sum, [a, b]) => sum + b - a + 1, 0) !== to - from) throw new Error("MPEG elementary bytes have missing addresses.");
  return ranges;
}

function adtsFrame(bytes) {
  if (bytes[0] !== 0xff || (bytes[1] & 0xf6) !== 0xf0) throw new Error("AAC ADTS header is invalid.");
  const objectType = (bytes[2] >> 6) + 1;
  const frequencyIndex = (bytes[2] >> 2) & 15;
  const sampleRate = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350][frequencyIndex];
  const channelConfiguration = ((bytes[2] & 1) << 2) | (bytes[3] >> 6);
  if (!sampleRate || !channelConfiguration) throw new Error("AAC ADTS requires a declared sample rate and channel configuration.");
  if (bytes[6] & 3) throw new Error("AAC ADTS multiple raw blocks require block-specific addresses.");
  const headerBytes = bytes[1] & 1 ? 7 : 9;
  const size = ((bytes[3] & 3) << 11) | (bytes[4] << 3) | (bytes[5] >> 5);
  if (size <= headerBytes) throw new Error("AAC ADTS frame excludes its payload.");
  const configuration = Buffer.from([(objectType << 3) | (frequencyIndex >> 1), ((frequencyIndex & 1) << 7) | (channelConfiguration << 3)]);
  return { size, headerBytes, sampleRate, channels: channelConfiguration === 7 ? 8 : channelConfiguration,
    duration: 1024 / sampleRate, codecId: "aac", codecPrivateB64: configuration.toString("base64") };
}
