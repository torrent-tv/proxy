import { Container } from "./Container.js";
import { PacketIndex } from "./PacketIndex.js";
import { PacketRecords } from "./PacketRecords.js";
import { BytesUnavailable } from "./unavailable.js";
import { IndexMemoryUnavailable } from "./memory-unavailable.js";
import { ffprobeExtradata } from "./ffprobe-record.js";
import { VideoTrack } from "../tracks/VideoTrack.js";
import { AudioTrack } from "../tracks/AudioTrack.js";
import { SubtitleTrack } from "../tracks/SubtitleTrack.js";
import { TextSubtitleTrack } from "../tracks/TextSubtitleTrack.js";
import { MatroskaContainer } from "./MatroskaContainer.js";
import { Mp4Container } from "./Mp4Container.js";
import { flvPacketRanges } from "./flv-packet-ranges.js";

const TEXT_CODECS = new Map([
  ["subrip", "S_TEXT/UTF8"], ["srt", "S_TEXT/UTF8"],
  ["ass", "S_TEXT/ASS"], ["ssa", "S_TEXT/SSA"],
  ["webvtt", "S_TEXT/WEBVTT"], ["vtt", "S_TEXT/WEBVTT"],
  ["mov_text", "tx3g"], ["text", "S_TEXT/UTF8"]
]);

const indexed = track => track.type === "video" || track.type === "audio" ||
  (track.type === "subtitle" && track.isTextBased());

/** Additional formats use the same strict byte reader through an injected demuxer. */
export class FfprobeContainer extends Container {
  #probe;
  #tracks;
  #info;
  #index;
  #records;
  #complete = false;
  #packetScanComplete = false;
  #indexedRecords = 0;
  #timings = new Map();

  constructor(params) {
    super(params);
    this.#probe = params.probe;
    this.#records = new PacketRecords(this.packetMemory);
  }
  get formatName() { return "ffprobe"; }
  packetIndexBytes() { return this.#index?.allocatedBytes() ?? 0; }

  async #read(statement, onRecord) {
    const result = await this.#probe(statement, onRecord);
    if (result.kind === "needs-memory") throw new IndexMemoryUnavailable(result.bytes);
    if (result.kind === "needs-ranges") {
      const [start, end] = result.ranges[0];
      throw new BytesUnavailable(start, end, 0);
    }
    if (result.kind !== "result") throw new Error(result.message ?? result.reason ?? "Packet probe was cancelled.");
    return result.value;
  }

  async readTracks() {
    if (this.#tracks) return this.#tracks;
    const records = await this.#read("streams");
    const counts = { video: 0, audio: 0, subtitle: 0 };
    const tracks = [];
    for (const record of records) {
      if (record.kind !== "stream" || !Object.hasOwn(counts, record.codec_type)) continue;
      const stream = integer(record.index, "stream index");
      if (tracks.some(track => track.trackNumber === stream + 1)) throw new Error("Duplicate ffprobe stream.");
      const privateSize = record.extradata_size === undefined ? 0 : integer(record.extradata_size, "extradata size");
      const base = { trackNumber: stream + 1, declaredIndex: counts[record.codec_type]++, codecId: record.codec_name,
        language: record["tag:language"] ?? "", declaresLanguage: Object.hasOwn(record, "tag:language"),
        name: record["tag:title"] ?? "", isEnabled: true, isDefault: record["disposition:default"] === "1",
        declaresDefault: Object.hasOwn(record, "disposition:default"),
        codecPrivateB64: privateSize ? ffprobeExtradata(record.extradata, privateSize).toString("base64") : "" };
      if (base.codecId === "alac" && privateSize) {
        const atom = Buffer.from(base.codecPrivateB64, "base64");
        if (atom.length < 36 || atom.readUInt32BE() !== atom.length || atom.toString("ascii", 4, 8) !== "alac") {
          throw new Error("The ALAC probe did not supply a complete decoder atom.");
        }
        base.codecPrivateB64 = atom.subarray(12).toString("base64");
      }
      let track;
      if (record.codec_type === "video") {
        track = new VideoTrack({ ...base, width: number(record.width), height: number(record.height), fps: ratio(record.r_frame_rate) });
        track.reorderDepth = record.has_b_frames === undefined ? 0 : integer(record.has_b_frames, "reorder depth");
      } else if (record.codec_type === "audio") {
        track = new AudioTrack({ ...base, channels: number(record.channels), samplingFrequency: number(record.sample_rate),
          bitDepth: Number(/^pcm_[suf](\d+)/.exec(record.codec_name)?.[1]) ||
            number(record.bits_per_raw_sample) || number(record.bits_per_sample) || null });
        track.prerollSeconds = track.codecId === "opus" ? 0.08 : 0;
        if (track.codecId === "opus") {
          const head = Buffer.from(track.codecPrivateB64, "base64");
          if (head.length < 19 || head.toString("ascii", 0, 8) !== "OpusHead") throw new Error("Opus decoder configuration is absent.");
          track.codecDelaySeconds = head.readUInt16LE(10) / 48000;
          track.seekPrerollSeconds = 0.08;
        }
      } else {
        const codecId = TEXT_CODECS.get(record.codec_name);
        const Type = codecId ? TextSubtitleTrack : SubtitleTrack;
        track = new Type({ ...base, ...(codecId ? { codecId } : {}), isForced: record["disposition:forced"] === "1" });
      }
      tracks.push(track);
    }
    if (!tracks.length) throw new Error("The packet probe found no declared media streams.");
    const format = records.find(record => record.kind === "format");
    this.#info = { format: format?.format_name ?? "unknown", durationSeconds: number(format?.duration), startTimeSeconds: number(format?.start_time) };
    this.#tracks = tracks;
    return tracks;
  }

  async readMediaInfo() { await this.readTracks(); return this.#info; }

  async readPacketIndex(interval) {
    const tracks = await this.readTracks();
    if (this.#complete) return this.#index;
    let position = 0;
    let missing;
    try { if (!this.#packetScanComplete) await this.#read("packets", record => {
      if (record.kind === "scan-start") { position = 0; return; }
      if (record.kind === "scan-end") {
        if (position !== this.#records.length) throw new Error("Packet scan ended before its retained index.");
        this.#packetScanComplete = true;
        return;
      }
      if (record.kind !== "packet") return;
      const streamId = integer(record.stream_index, "packet stream") + 1;
      const track = tracks.find(track => track.trackNumber === streamId);
      if (!track || !indexed(track)) return;
      const start = integer(record.pos, "packet address"), size = integer(record.size, "packet size");
      if (!size || !Number.isSafeInteger(start + size) || start + size > this.fileSize) throw new Error("Packet bytes are outside the source file.");
      const pts = number(record.pts_time), duration = number(record.duration_time);
      const dts = number(record.dts_time) ?? (track.type === "subtitle" ? pts : null);
      if (pts === null || dts === null || duration === null || duration < 0 ||
          (duration === 0 && track.type !== "subtitle")) throw new Error("The demuxer cannot state complete packet timing.");
      const expectedHash = /^SHA256:([a-fA-F0-9]{64})$/.exec(record.data_hash ?? "")?.[1]?.toLowerCase();
      if (!expectedHash) throw new Error("The demuxer cannot verify packet byte addresses.");
      const packet = { pts, dts, duration, keyframe: record.flags?.includes("K") === true,
        ranges: [[start, start + size - 1]], expectedHash, streamId };
      const previous = this.#records.at(position++);
      if (previous) {
        if (previous.pts !== pts || previous.dts !== dts || previous.duration !== duration ||
            previous.keyframe !== packet.keyframe || previous.streamId !== streamId || previous.expectedHash !== expectedHash ||
            previous.ranges[0][0] !== start || previous.ranges[0][1] !== start + size - 1) {
          throw new Error("Repeated packet scan changed a previously indexed packet.");
        }
      } else this.#records.push(packet);
    }); } catch (error) {
      if (!(error instanceof BytesUnavailable)) throw error;
      missing = error;
    }
    if (!missing && !this.#packetScanComplete) throw new Error("Packet scan did not report its completion.");
    const index = this.#index ?? new PacketIndex({ packetMemory: this.packetMemory });
    const timings = this.#timings;
    if (!this.#index) {
    for (const track of tracks) {
      if (!indexed(track)) continue;
      index.declareTrack(track.trackNumber, { type: track.type, codecId: track.codecId, reorderDepth: track.reorderDepth ?? 0, prerollSeconds: track.prerollSeconds ?? 0 });
    }
    this.#index = index;
    }
    while (this.#indexedRecords < this.#records.length) {
      const record = this.#records.at(this.#indexedRecords);
      const id = record.streamId;
      const track = tracks.find(track => track.trackNumber === id);
      const start = record.ranges[0][0], size = record.ranges[0][1] - start + 1;
      const { pts, dts, duration } = record;
      const ranges = this.#info.format.split(",").includes("flv")
        ? await flvPacketRanges({ readRange: this.readRange, fileSize: this.fileSize, position: start, size, track, pts, dts })
        : [[start, start + size - 1]];
      index.append(id, { pts, dts, duration, keyframe: record.keyframe,
        ranges, expectedHash: record.expectedHash });
      const timing = timings.get(id) ?? { count: 0, tail: [] };
      timing.count++;
      timing.tail.push({ pts, duration });
      const keep = track.type === "video" ? track.reorderDepth + 1 : 1;
      if (timing.tail.length > keep) timing.tail.shift();
      timings.set(id, timing);
      this.#indexedRecords++;
    }
    for (const track of tracks) {
      if (!indexed(track)) continue;
      if (!missing) index.complete(track.trackNumber);
      else {
        const timing = timings.get(track.trackNumber) ?? { count: 0, tail: [] };
        const tail = timing.tail;
        if (tail.length && (track.type !== "video" || timing.count > track.reorderDepth)) {
          const through = track.type === "video" ? Math.min(...tail.map(packet => packet.pts)) : tail[0].pts + tail[0].duration;
          index.coverThrough(track.trackNumber, Math.max(0, through));
        }
      }
    }
    if (missing) {
      if (!interval || tracks.filter(track => indexed(track) &&
        (!interval.trackIds || interval.trackIds.includes(track.trackNumber))).some(track =>
        index.inputFor({ trackId: track.trackNumber, from: interval.from, to: interval.to }).kind !== "result")) throw missing;
      return index;
    }
    this.#index = index;
    this.#complete = true;
    this.#records.dispose();
    return index;
  }

  async parseKeyframeIndex() {
    const tracks = await this.readTracks();
    const video = tracks.find(track => track.type === "video");
    if (!video) return null;
    return { times: (await this.readPacketIndex()).keyframesOf(video.trackNumber), tolerance: 0 };
  }

  static cueTextOf(payload, codecId) {
    if (codecId === "tx3g") return Mp4Container.cueTextOf(payload, codecId);
    return MatroskaContainer.cueTextOf(payload, codecId);
  }
}

function number(value) { return value !== undefined && value !== "N/A" && Number.isFinite(Number(value)) ? Number(value) : null; }
function integer(value, field) {
  const result = number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`The demuxer cannot state ${field}.`);
  return result;
}
function ratio(value) {
  const [numerator, denominator] = String(value ?? "").split("/").map(Number);
  return numerator > 0 && denominator > 0 ? numerator / denominator : null;
}
