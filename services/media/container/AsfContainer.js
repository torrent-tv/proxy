import { Container } from "./Container.js";
import { VideoTrack } from "../tracks/VideoTrack.js";
import { AudioTrack } from "../tracks/AudioTrack.js";
import { readAsfPackets } from "./asf-packets.js";
import { RetainedReads } from "./RetainedReads.js";

const HEADER = "3026b2758e66cf11a6d900aa0062ce6c";
const FILE = "a1dcab8c47a9cf118ee400c00c205365";
const STREAM = "9107dcb7b7a9cf118ee600c00c205365";
const EXTENSION = "b503bf5f2ea9cf118ee300c00c205365";
const EXTENDED_STREAM = "cba5e61472c632438399a96952065b5a";
const LANGUAGES = "7c4346a9efe0fc4bb229393ede415c85";
const AUDIO = "409e69f84d5bcf11a8fd00805f5c442b";
const VIDEO = "c0ef19bc4d5bcf11a8fd00805f5c442b";
const ENCRYPTION = new Set(["fbb3112223bdd211b4b700a0c955fc6e", "14e68a292226174cb935dae07e9e28c9"]);
const AUDIO_CODECS = new Map([[1, "pcm_s16le"], [0x55, "mp3"], [0xff, "aac"],
  [0x160, "wmav1"], [0x161, "wmav2"], [0x162, "wmapro"], [0x163, "wmalossless"], [0x2000, "ac3"]]);

/** ASF declarations are bounded objects, read without fetching source packets. */
export class AsfContainer extends Container {
  #tracks = null;
  #info = null;
  #header = null;
  #objects = [];
  #offset = 30;
  #packets = null;
  #packetState = {};
  #startRead = false;
  #duration = null;
  #declarations = null;

  get formatName() { return "asf"; }
  packetIndexBytes() {
    return (this.#packets?.allocatedBytes() ?? 0) +
      [...(this.#packetState.frames?.values() ?? [])].reduce((sum, records) => sum + records.allocatedBytes, 0);
  }
  static detect(head) { return head.length >= 16 && head.subarray(0, 16).toString("hex") === HEADER; }

  async #readHeader() {
    if (this.#info) return;
    this.#declarations ??= new RetainedReads(this.packetMemory);
    if (!this.#header) {
      const bytes = await this.readRange(0, 29);
      if (!AsfContainer.detect(bytes) || bytes[28] !== 1 || bytes[29] !== 2) throw new Error("ASF header is invalid.");
      const size = Number(bytes.readBigUInt64LE(16));
      const count = bytes.readUInt32LE(24);
      if (!Number.isSafeInteger(size) || size < 30 || size > this.fileSize || count * 24 > size - 30) {
        throw new Error("ASF header object sizes exceed the file.");
      }
      this.#header = { size, count };
    }
    while (this.#objects.length < this.#header.count) {
      const head = await this.readRange(this.#offset, this.#offset + 23);
      const size = Number(head.readBigUInt64LE(16));
      if (!Number.isSafeInteger(size) || size < 24 || this.#offset + size > this.#header.size) {
        throw new Error("ASF child object exceeds its header.");
      }
      const guid = head.subarray(0, 16).toString("hex");
      if (ENCRYPTION.has(guid)) throw new Error("ASF media is encrypted.");
      const bytes = [FILE, STREAM, EXTENSION, EXTENDED_STREAM, LANGUAGES].includes(guid)
        ? await this.#declarations.read(this.#offset + 24, this.#offset + size - 1, this.readRange) : null;
      this.#objects.push({ guid, bytes });
      this.#offset += size;
    }
    const objects = [...this.#objects];
    for (const object of this.#objects) {
      if (object.guid !== EXTENSION) continue;
      const bytes = object.bytes;
      if (bytes.length < 22) throw new Error("ASF header extension is truncated.");
      const end = 22 + bytes.readUInt32LE(18);
      if (end > bytes.length) throw new Error("ASF header extension length is invalid.");
      for (let at = 22; at < end;) {
        if (at + 24 > end) throw new Error("ASF extension object is truncated.");
        const size = Number(bytes.readBigUInt64LE(at + 16));
        if (!Number.isSafeInteger(size) || size < 24 || at + size > end) throw new Error("ASF extension object size is invalid.");
        const guid = bytes.subarray(at, at + 16).toString("hex");
        if (ENCRYPTION.has(guid)) throw new Error("ASF media is encrypted.");
        objects.push({ guid, bytes: bytes.subarray(at + 24, at + size) });
        at += size;
      }
    }
    const properties = objects.find(object => object.guid === FILE)?.bytes;
    if (!properties || properties.length < 80) throw new Error("ASF file properties are absent or truncated.");
    const duration = Number(properties.readBigUInt64LE(40)) / 1e7;
    const preroll = Number(properties.readBigUInt64LE(56)) / 1000;
    const streaming = (properties.readUInt32LE(64) & 1) !== 0;
    const tracks = [];
    const counts = { video: 0, audio: 0 };
    for (const object of objects) {
      if (object.guid !== STREAM) continue;
      const bytes = object.bytes;
      if (bytes.length < 54) throw new Error("ASF stream properties are truncated.");
      const type = bytes.subarray(0, 16).toString("hex");
      const flags = bytes.readUInt16LE(48);
      if (flags & 0x8000) throw new Error("ASF stream is encrypted.");
      const number = flags & 0x7f;
      if (!number || tracks.some(track => track.trackNumber === number)) throw new Error("ASF stream number is invalid.");
      const length = bytes.readUInt32LE(40);
      if (54 + length > bytes.length) throw new Error("ASF codec declaration is truncated.");
      const data = bytes.subarray(54, 54 + length);
      const base = { trackNumber: number, isEnabled: true, isDefault: false, declaresDefault: false };
      if (type === VIDEO) {
        if (data.length < 51) throw new Error("ASF video format is truncated.");
        const bitmapSize = data.readUInt32LE(11);
        if (bitmapSize < 40 || 11 + bitmapSize > data.length) throw new Error("ASF bitmap format size is invalid.");
        const codecId = data.toString("latin1", 27, 31);
        const track = new VideoTrack({ ...base, declaredIndex: counts.video++, codecId,
          width: Math.abs(data.readInt32LE(15)), height: Math.abs(data.readInt32LE(19)),
          codecPrivateB64: data.subarray(51, 11 + bitmapSize).toString("base64") });
        track.matroskaCodecId = "V_MS/VFW/FOURCC";
        track.matroskaCodecPrivateB64 = data.subarray(11).toString("base64");
        tracks.push(track);
      } else if (type === AUDIO) {
        if (data.length < 16) throw new Error("ASF audio format is truncated.");
        const tag = data.readUInt16LE(0);
        const extraLength = data.length >= 18 ? data.readUInt16LE(16) : 0;
        if (extraLength + 18 > data.length && extraLength > 0) throw new Error("ASF audio codec settings are truncated.");
        const track = new AudioTrack({ ...base, declaredIndex: counts.audio++, codecId: AUDIO_CODECS.get(tag) ?? `wave:${tag}`,
          channels: data.readUInt16LE(2), samplingFrequency: data.readUInt32LE(4),
          codecPrivateB64: data.subarray(18, 18 + extraLength).toString("base64") });
        track.matroskaCodecId = "A_MS/ACM";
        track.matroskaCodecPrivateB64 = (data.length === 16
          ? Buffer.concat([data, Buffer.alloc(2)]) : data).toString("base64");
        tracks.push(track);
      }
    }
    const languages = [];
    for (const object of objects.filter(object => object.guid === LANGUAGES)) {
      const bytes = object.bytes;
      if (bytes.length < 2) throw new Error("ASF language list is truncated.");
      let at = 2;
      for (let index = 0; index < bytes.readUInt16LE(0); index++) {
        if (at >= bytes.length) throw new Error("ASF language entry is truncated.");
        const length = bytes[at++];
        if (length % 2 || at + length > bytes.length) throw new Error("ASF language entry length is invalid.");
        languages.push(bytes.toString("utf16le", at, at + length).replace(/\0+$/, ""));
        at += length;
      }
    }
    for (const object of objects.filter(object => object.guid === EXTENDED_STREAM)) {
      const bytes = object.bytes;
      if (bytes.length < 64) throw new Error("ASF extended stream properties are truncated.");
      const track = tracks.find(track => track.trackNumber === bytes.readUInt16LE(48));
      if (!track) throw new Error("ASF extended properties name an undeclared stream.");
      const durationTicks = Number(bytes.readBigUInt64LE(52));
      if (!Number.isSafeInteger(durationTicks)) throw new Error("ASF average frame duration exceeds its integer range.");
      if (durationTicks > 0) {
        track.averageFrameDurationSeconds = durationTicks / 1e7;
        if (track.type === "video") track.fps = 1e7 / durationTicks;
      }
      const language = languages[bytes.readUInt16LE(50)];
      if (language) {
        track.language = language;
        track.languageBcp47 = language;
        track.declaresLanguage = true;
        track.languageSource = "bcp47";
      }
      let at = 64;
      for (let index = 0; index < bytes.readUInt16LE(60); index++) {
        if (at + 4 > bytes.length) throw new Error("ASF stream name is truncated.");
        const length = bytes.readUInt16LE(at + 2);
        if (length % 2 || at + 4 + length > bytes.length) throw new Error("ASF stream name length is invalid.");
        if (!track.name) track.name = bytes.toString("utf16le", at + 4, at + 4 + length).replace(/\0+$/, "");
        at += 4 + length;
      }
      const extensions = [];
      for (let index = 0; index < bytes.readUInt16LE(62); index++) {
        if (at + 22 > bytes.length) throw new Error("ASF payload extension declaration is truncated.");
        const length = bytes.readUInt32LE(at + 18);
        if (at + 22 + length > bytes.length) throw new Error("ASF payload extension information exceeds its object.");
        extensions.push({ id: bytes.subarray(at, at + 16).toString("hex"), size: bytes.readUInt16LE(at + 16) });
        at += 22 + length;
      }
      track.payloadExtensions = extensions;
    }
    this.#tracks = tracks;
    this.#duration = streaming ? null : Math.max(0, duration - preroll);
    this.#info = { format: this.formatName, durationSeconds: streaming ? null : Math.max(0, duration - preroll),
      startTimeSeconds: null, bitrateKbps: properties.readUInt32LE(76) / 1000,
      prerollSeconds: preroll, minimumPacketLength: properties.readUInt32LE(68), packetLength: properties.readUInt32LE(72), dataOffset: this.#header.size };
  }

  async readTracks() { await this.#readHeader(); return this.#tracks; }
  async readMediaInfo() {
    await this.#readHeader();
    if (!this.#startRead && this.#info.dataOffset < this.fileSize && this.#tracks.some(track => track.type === "video")) {
      const first = await readAsfPackets({ readRange: this.readRange, fileSize: this.fileSize,
        tracks: this.#tracks, info: this.#info, firstPicture: true, state: this.#packetState, packetMemory: this.packetMemory });
      this.#info = { ...this.#info, startTimeSeconds: first.startTimeSeconds,
        durationSeconds: this.#duration === null ? null : Math.max(0, this.#duration - (first.startTimeSeconds ?? 0)) };
      this.#startRead = true;
    }
    return this.#info;
  }
  async parseKeyframeIndex() {
    const index = await this.readPacketIndex();
    const track = this.#tracks.find(track => track.type === "video");
    return track ? { times: index.keyframesOf(track.trackNumber), tolerance: 0 } : null;
  }
  async readPacketIndex() {
    await this.#readHeader();
    if (!this.#packets) {
      const index = await readAsfPackets({ readRange: this.readRange, fileSize: this.fileSize, tracks: this.#tracks,
        info: { ...this.#info, durationSeconds: this.#duration }, state: this.#packetState, packetMemory: this.packetMemory });
      const timeline = this.#tracks.find(track => track.type === "video") ?? this.#tracks.find(track => track.type === "audio");
      const bounds = timeline ? index.boundsOf(timeline.trackNumber) : null;
      if (bounds) {
        this.#info = { ...this.#info, startTimeSeconds: bounds.start,
          durationSeconds: this.#duration === null ? bounds.end - bounds.start : Math.max(0, this.#duration - bounds.start) };
        this.#startRead = true;
      }
      this.#packets = index;
      this.#packetState = {};
    }
    return this.#packets;
  }
}
