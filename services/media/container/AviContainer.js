/**
 * @file AVI container — RIFF.
 *
 * Stream declarations and exact packet addresses from idx1 or OpenDML indexes.
 */

import { Container } from "./Container.js";
import { VideoTrack } from "../tracks/VideoTrack.js";
import { AudioTrack } from "../tracks/AudioTrack.js";
import { ContainerTrack } from "../tracks/ContainerTrack.js";
import { PacketIndex } from "./PacketIndex.js";
import { openDmlPackets } from "./avi-open-dml.js";
import { isUnavailable } from "./unavailable.js";
import { IndexMemoryUnavailable } from "./memory-unavailable.js";
import { Mpeg4PictureTiming } from "./mpeg4-picture-timing.js";
import { MpegElementaryIndex } from "./mpeg-elementary-index.js";
import { RetainedReads } from "./RetainedReads.js";
import { OutsideReadableEdges, edgeReader, emptyWorkTags, text, textList, yearOf } from "./work-tags.js";

const MPEG4_CODECS = new Set(["FMP4", "XVID", "DIVX", "DX50", "MP4V", "M4S2", "MP4S"]);
const MPEG_AUDIO_CODECS = new Set(["mp1", "mp2", "mp3"]);
const NAL_CODECS = new Map([["H264", "h264"], ["X264", "h264"], ["AVC1", "h264"], ["HEVC", "hevc"], ["H265", "hevc"]]);

export class AviContainer extends Container {
  #headers = null;
  #tracks = null;
  #packets = null;
  #scan = null;
  #indexed = null;
  #declarations = null;
  #workTags = null;

  async #readHeaders() {
    if (this.#headers) return this.#headers;
    this.#declarations ??= new RetainedReads(this.packetMemory);
    const head = await this.readRange(0, Math.min(11, this.fileSize - 1));
    if (!isAvi(head)) throw new Error("AVI RIFF header is absent.");
    const end = 8 + head.readUInt32LE(4);
    if (end > this.fileSize || end < 12) throw new Error("AVI RIFF size is invalid.");
    const lists = await riffChunks(this.readRange, 12, end, "hdrl");
    const hdrl = lists.find(chunk => chunk.id === "LIST" && chunk.type === "hdrl");
    if (!hdrl) throw new Error("AVI stream header list is absent.");
    const chunks = await riffChunks(this.readRange, hdrl.start + 4, hdrl.end);
    const main = chunks.find(chunk => chunk.id === "avih");
    const avih = main ? await this.#declarations.read(main.start, main.end - 1, this.readRange) : null;
    if (avih && avih.length < 20) throw new Error("AVI main header is truncated.");
    const streams = [];
    for (const list of chunks.filter(chunk => chunk.id === "LIST" && chunk.type === "strl")) {
      const children = await riffChunks(this.readRange, list.start + 4, list.end);
      const fields = {};
      fields.codecRanges = [];
      fields.indexChunks = children.filter(chunk => chunk.id === "indx");
      for (const chunk of children) {
        if (!["strh", "strf", "strn", "strd"].includes(chunk.id)) continue;
        fields[chunk.id] = chunk.end > chunk.start
          ? await this.#declarations.read(chunk.start, chunk.end - 1, this.readRange) : Buffer.alloc(0);
        if (["strh", "strf", "strd"].includes(chunk.id) && chunk.end > chunk.start) fields.codecRanges.push([chunk.start, chunk.end - 1]);
      }
      if (!fields.strh || fields.strh.length < 48 || !fields.strf) throw new Error("AVI stream declaration is incomplete.");
      streams.push(fields);
    }
    this.#headers = { avih, streams };
    return this.#headers;
  }
  get formatName() {
    return "avi";
  }
  /**
   * What the file states about the work, from the `LIST INFO` chunk of the
   * RIFF (Microsoft, "Multimedia Programming Interface and Data
   * Specifications 1.0", INFO list): `INAM` the title, `IGNR` the genre,
   * `ICRD` the creation date, `ISBJ` the subject, `ICMT` comments.
   *
   * Looked for among the top-level chunks before `movi`, where writers put it;
   * walking past `movi` would read the header of what follows it, which lies
   * wherever the film ends. The specification states no character set, so a
   * value that is not valid UTF-8 is left out rather than shown garbled.
   *
   * @param {(start: number, end: number) => boolean} mayFetch
   * @returns {Promise<import("./work-tags.js").WorkTags>}
   */
  async readWorkTags(mayFetch) {
    if (this.#workTags) return this.#workTags;
    const tags = emptyWorkTags();
    const head = await this.readRange(0, Math.min(11, this.fileSize - 1));
    if (!isAvi(head)) throw new Error("AVI RIFF header is absent.");
    const end = Math.min(this.fileSize, 8 + head.readUInt32LE(4));
    const read = edgeReader(this.readRange, mayFetch, isUnavailable);
    try {
      const top = await riffChunks(read, 12, end, "movi");
      const info = top.find((chunk) => chunk.id === "LIST" && chunk.type === "INFO");
      const fields = new Map();
      for (const field of info ? await riffChunks(read, info.start + 4, info.end) : []) {
        if (field.end <= field.start || fields.has(field.id)) continue;
        const value = (await read(field.start, field.end - 1)).toString("utf8");
        // U+FFFD is what the decoder puts where the bytes were not UTF-8.
        if (!value.includes(String.fromCodePoint(0xfffd))) fields.set(field.id, text(value));
      }
      tags.title = fields.get("INAM") ?? null;
      tags.genres = textList([fields.get("IGNR")]);
      tags.year = yearOf(fields.get("ICRD"));
      tags.description = fields.get("ISBJ") ?? fields.get("ICMT") ?? null;
    } catch (error) {
      if (!(error instanceof OutsideReadableEdges)) throw error;
      tags.outsideEdges = true;
    }
    tags.trackTitles = await this.trackTitlesForWork();
    if (!tags.outsideEdges) this.#workTags = tags;
    return tags;
  }


  packetIndexBytes() { return (this.#packets ?? this.#scan?.index ?? this.#indexed?.index)?.allocatedBytes() ?? 0; }

  static detect(head) {
    return isAvi(head);
  }

  /**
   * The keyframe times this container's own index states, in ascending seconds.
   *
   * Static so a caller that has bytes and no container can ask; the instance
   * form is {@link Container#readKeyframeIndex}.
   *
   * @param {(start:number,end:number)=>Promise<Buffer|null>} readRange
   * @param {number} fileSize
   * @returns {Promise<number[]|null>} Null where the container has no index.
   */
  static readKeyframeTimes(readRange, fileSize) {
    return readAviKeyframeTimes(readRange, fileSize);
  }

  async readTracks() {
    if (this.#tracks) return this.#tracks;
    const { streams } = await this.#readHeaders();
    const counts = { video: 0, audio: 0, other: 0 };
    const tracks = streams.map(({ strh, strf, strn, strd }, trackNumber) => {
      const kind = strh.toString("ascii", 0, 4);
      const type = kind === "vids" ? "video" : kind === "auds" ? "audio" : "other";
      const scale = strh.readUInt32LE(20);
      const rate = strh.readUInt32LE(24);
      const params = { trackNumber, declaredIndex: counts[type]++, type,
        isEnabled: !(strh.readUInt32LE(8) & 1), isDefault: false, declaresDefault: false,
        language: "", name: strn?.toString("utf8").replace(/\0+$/, "") ?? "",
        codecPrivateB64: (strd ?? Buffer.alloc(0)).toString("base64") };
      let track;
      if (type === "video") {
        if (strf.length < 40 || strf.readUInt32LE(0) < 40) throw new Error("AVI bitmap format is truncated.");
        track = new VideoTrack({ ...params, codecId: strf.toString("ascii", 16, 20),
          width: Math.abs(strf.readInt32LE(4)), height: Math.abs(strf.readInt32LE(8)),
          bitDepth: strf.readUInt16LE(14), fps: scale > 0 && rate > 0 ? rate / scale : null });
        // Preserve the complete decoder declaration, including palette and private bytes.
        track.matroskaCodecId = "V_MS/VFW/FOURCC";
        track.matroskaCodecPrivateB64 = strf.toString("base64");
        const nalCodec = NAL_CODECS.get(track.codecId.toUpperCase());
        if (nalCodec) {
          track.codecId = nalCodec;
          delete track.matroskaCodecId;
          delete track.matroskaCodecPrivateB64;
        }
      } else if (type === "audio") {
        if (strf.length < 16) throw new Error("AVI wave format is truncated.");
        const tag = strf.readUInt16LE(0);
        track = new AudioTrack({ ...params, codecId: waveCodec(tag),
          channels: strf.readUInt16LE(2), samplingFrequency: strf.readUInt32LE(4),
          codecPrivateB64: strf.subarray(18).toString("base64") });
        track.matroskaCodecId = "A_MS/ACM";
        track.matroskaCodecPrivateB64 = (strf.length === 16
          ? Buffer.concat([strf, Buffer.alloc(2)]) : strf).toString("base64");
      } else track = new ContainerTrack({ ...params, codecId: strh.toString("ascii", 4, 8) });
      track.timeBase = scale > 0 && rate > 0 ? scale / rate : null;
      track.startTimeSeconds = track.timeBase === null ? null : strh.readUInt32LE(28) * track.timeBase;
      track.durationSeconds = track.timeBase === null ? null : strh.readUInt32LE(32) * track.timeBase;
      track.sampleSize = strh.readUInt32LE(44);
      if (["h264", "hevc"].includes(track.codecId)) track.presentationCadenceSeconds = track.timeBase;
      return track;
    });
    this.#tracks = tracks;
    return tracks;
  }

  /**
   * Duration from the main AVI header, per the RIFF AVI specification: the
   * header states microseconds per frame and the total number of frames, and
   * their product is the length.
   *
   * An AVI has no edit list and no timeline offset of any kind, so its start is
   * zero — a declaration of the format itself, not an absence.
   *
   * @returns {Promise<import("./Container.js").ContainerMediaInfo>}
   */
  async readMediaInfo() {
    if (this.mediaInfo) {
      return this.mediaInfo;
    }
    /** @type {import("./Container.js").ContainerMediaInfo} */
    const info = { format: this.formatName, durationSeconds: null, startTimeSeconds: 0 };
    const { avih } = await this.#readHeaders();
    const microsecondsPerFrame = avih?.readUInt32LE(0) ?? 0;
    const totalFrames = avih?.readUInt32LE(16) ?? 0;
    if (microsecondsPerFrame > 0 && totalFrames > 0) {
      info.durationSeconds = (microsecondsPerFrame * totalFrames) / 1e6;
    }
    this.mediaInfo = info;
    return info;
  }

  async parseKeyframeIndex() {
    const { streams } = await this.#readHeaders();
    const picture = (await this.readTracks()).find(track => track.type === "video");
    if (streams.some(stream => stream.indexChunks.length) || ["h264", "hevc"].includes(picture?.codecId) || MPEG4_CODECS.has(picture?.codecId.toUpperCase())) {
      const index = await this.readPacketIndex();
      return picture ? { times: index.keyframesOf(picture.trackNumber), tolerance: 0 } : null;
    }
    const r = await readAviKeyframeTimes(this.readRange, this.fileSize);
    if (!r) {
      return picture ? { times: (await this.readPacketIndex()).keyframesOf(picture.trackNumber), tolerance: 0 } : null;
    }
    if (Array.isArray(r)) return { times: r, tolerance: 0 };
    return r;
  }

  async readPacketIndex(interval) {
    if (this.#packets) return this.#packets;
    if (this.#scan) return this.#readUnindexed(interval);
    if (this.#indexed) return this.#readIndexed();
    const tracks = await this.readTracks();
    const { streams } = await this.#readHeaders();
    if (streams.some(stream => stream.indexChunks.length)) {
      const index = new PacketIndex({ packetMemory: this.packetMemory, deferMemory: true });
      const timings = new Map();
      try {
      for (const track of tracks.filter(track => ["video", "audio"].includes(track.type))) {
        if (!(track.timeBase > 0) || !streams[track.trackNumber].indexChunks.length) throw new Error("AVI OpenDML stream index is incomplete.");
        index.declareTrack(track.trackNumber, { type: track.type, codecId: track.codecId, codecRanges: streams[track.trackNumber].codecRanges });
        let pts = track.startTimeSeconds;
        for await (const packet of openDmlPackets({ readRange: this.readRange, fileSize: this.fileSize,
          indexes: streams[track.trackNumber].indexChunks, streamId: track.trackNumber })) {
          if (!packet.length) {
            if (track.type === "video") { index.extendLastPresentation(track.trackNumber, track.timeBase); pts += track.timeBase; }
            continue;
          }
          if (track.sampleSize > 0 && packet.length % track.sampleSize) throw new Error("AVI packet contains an incomplete fixed-size sample.");
          const duration = track.timeBase * (track.sampleSize > 0 ? packet.length / track.sampleSize : 1);
          await this.#appendPacket(index, timings, track, { pts, duration, keyframe: track.type !== "video" || packet.keyframe,
            ranges: [[packet.start, packet.start + packet.length - 1]] });
          pts += duration;
          index.flushPending();
        }
        timings.get(track.trackNumber)?.elementary?.complete();
        index.flushPending();
        index.complete(track.trackNumber);
      }
      this.#packets = index;
      return index;
      } catch (error) {
        index.dispose();
        throw error;
      }
    }
    const header = await this.readRange(0, 11);
    const chunks = await riffChunks(this.readRange, 12, 8 + header.readUInt32LE(4));
    const movi = chunks.find(chunk => chunk.id === "LIST" && chunk.type === "movi");
    const table = chunks.find(chunk => chunk.id === "idx1");
    if (!movi) throw new Error("AVI media list is absent.");
    if (!table) {
      const index = new PacketIndex({ packetMemory: this.packetMemory, deferMemory: true });
      const clocks = new Map();
      for (const track of tracks.filter(track => ["video", "audio"].includes(track.type))) {
        if (!(track.timeBase > 0)) throw new Error("AVI stream time base is invalid.");
        if (track.type === "video" && !["h264", "hevc"].includes(track.codecId) && !MPEG4_CODECS.has(track.codecId.toUpperCase()) && !["MJPG", "JPEG", "DIB ", "\0\0\0\0"].includes(track.codecId.toUpperCase())) {
          throw new Error("AVI video without an index requires elementary picture timing.");
        }
        if (track.type === "audio" && !(track.sampleSize > 0) && !MPEG_AUDIO_CODECS.has(track.codecId)) throw new Error("AVI variable-size audio requires elementary frame timing.");
        index.declareTrack(track.trackNumber, { type: track.type, codecId: track.codecId, codecRanges: streams[track.trackNumber].codecRanges });
        clocks.set(track.trackNumber, track.startTimeSeconds);
      }
      this.#scan = { index, tracks, clocks, timings: new Map(), at: 0,
        stack: [{ end: this.fileSize, next: this.fileSize }] };
      return this.#readUnindexed(interval);
    }
    if ((table.end - table.start) % 16 !== 0) throw new Error("AVI packet index entry is truncated.");
    const index = new PacketIndex({ packetMemory: this.packetMemory, deferMemory: true });
    const clocks = new Map();
    const timings = new Map();
    if (tracks.some(track => ["video", "audio", "subtitle"].includes(track.type) && !(track.timeBase > 0))) {
      throw new Error("AVI stream time base is invalid.");
    }
    for (const track of tracks) {
      if (!["video", "audio", "subtitle"].includes(track.type)) continue;
      index.declareTrack(track.trackNumber, { type: track.type, codecId: track.codecId, codecRanges: streams[track.trackNumber].codecRanges });
      clocks.set(track.trackNumber, track.startTimeSeconds);
    }
    this.#indexed = { index, clocks, timings, tracks, movi, table, offsetBase: null, at: table.start };
    return this.#readIndexed();
  }

  async #readIndexed() {
    const state = this.#indexed;
    const { index, clocks, timings, tracks, movi, table } = state;
    try {
    index.flushPending();
    for (; state.at < table.end;) {
      const at = state.at;
      const entry = await this.readRange(at, at + 15);
      const chunkId = entry.toString("ascii", 0, 4);
      if (!/^[0-9]{2}(db|dc|wb)$/.test(chunkId)) { state.at += 16; continue; }
      const id = Number(chunkId.slice(0, 2));
      const track = tracks.find(track => track.trackNumber === id);
      if (!track || !clocks.has(id)) throw new Error("AVI packet refers to an undeclared stream.");
      const flags = entry.readUInt32LE(4);
      const offset = entry.readUInt32LE(8);
      const length = entry.readUInt32LE(12);
      if (length === 0) {
        if (track.type === "video") { index.extendLastPresentation(id, track.timeBase); clocks.set(id, clocks.get(id) + track.timeBase); }
        state.at += 16;
        continue;
      }
      if (state.offsetBase === null) {
        for (const base of [movi.start, 0, movi.start + 4]) {
          const address = base + offset;
          if (address < movi.start + 4 || address + 8 + length > movi.end) continue;
          const probe = await this.readRange(address, address + 7);
          if (probe.toString("ascii", 0, 4) === chunkId && probe.readUInt32LE(4) === length) { state.offsetBase = base; break; }
        }
        if (state.offsetBase === null) throw new Error("AVI packet index has no valid offset base.");
      }
      const address = state.offsetBase + offset;
      if (address < movi.start + 4 || address + 8 + length > movi.end) throw new Error("AVI indexed packet exceeds its media list.");
      const probe = await this.readRange(address, address + 7);
      if (probe.toString("ascii", 0, 4) !== chunkId || probe.readUInt32LE(4) !== length) throw new Error("AVI packet index disagrees with its chunk header.");
      if (track.sampleSize > 0 && length % track.sampleSize !== 0) throw new Error("AVI packet contains an incomplete fixed-size sample.");
      const duration = track.timeBase * (track.sampleSize > 0 ? length / track.sampleSize : 1);
      const pts = clocks.get(id);
      await this.#appendPacket(index, timings, track, { pts, duration, keyframe: track.type !== "video" || chunkId.endsWith("db") || !!(flags & 0x10),
        ranges: [[address + 8, address + 8 + length - 1]] });
      clocks.set(id, pts + duration);
      // The pending facts own this entry even if their allocation must wait.
      state.at += 16;
      index.flushPending();
    }
    for (const timing of timings.values()) timing.elementary?.complete();
    index.flushPending();
    for (const id of clocks.keys()) index.complete(id);
    this.#packets = index;
    this.#indexed = null;
    return index;
    } catch (error) {
      if (!isUnavailable(error) && !(error instanceof IndexMemoryUnavailable)) {
        index.dispose();
        this.#indexed = null;
      }
      throw error;
    }
  }

  async #readUnindexed(interval) {
    const state = this.#scan;
    state.index.flushPending();
    const ready = () => interval && state.tracks.filter(track => state.clocks.has(track.trackNumber) &&
      (!interval.trackIds || interval.trackIds.includes(track.trackNumber))).every(track =>
      state.index.inputFor({ trackId: track.trackNumber, from: interval.from, to: interval.to }).kind === "result");
    try {
      while (state.stack.length) {
        if (ready()) return state.index;
        const parent = state.stack.at(-1);
        if (state.at === parent.end) { state.at = parent.next; state.stack.pop(); continue; }
        if (state.at + 8 > parent.end) throw new Error("AVI media chunk header is truncated.");
        const head = await this.readRange(state.at, state.at + 7);
        const id = head.toString("ascii", 0, 4), length = head.readUInt32LE(4);
        const start = state.at + 8, end = start + length, next = end + (length & 1);
        if (end > parent.end || next > parent.end) throw new Error("AVI media chunk exceeds its containing list.");
        if (id === "LIST" || id === "RIFF") {
          if (length < 4) throw new Error("AVI media list has no type.");
          const type = (await this.readRange(start, start + 3)).toString("ascii");
          if (id === "RIFF" && type !== "AVI " && type !== "AVIX") throw new Error("AVI continuation form type is invalid.");
          if (id === "LIST" && type !== "rec " && type !== "movi") { state.at = next; continue; }
          state.stack.push({ end, next });
          state.at = start + 4;
          continue;
        }
        if (/^[0-9]{2}(db|dc|wb)$/.test(id)) {
          const trackId = Number(id.slice(0, 2));
          const track = state.tracks.find(track => track.trackNumber === trackId);
          if (!track || !state.clocks.has(trackId)) throw new Error("AVI packet refers to an undeclared stream.");
          if (track.sampleSize > 0 && length % track.sampleSize) throw new Error("AVI packet contains an incomplete fixed-size sample.");
          const duration = track.timeBase * (track.sampleSize > 0 ? length / track.sampleSize : 1);
          const pts = state.clocks.get(trackId);
          if (length) await this.#appendPacket(state.index, state.timings, track, { pts, duration, keyframe: true, ranges: [[start, end - 1]] });
          else if (track.type === "video") state.index.extendLastPresentation(trackId, track.timeBase);
          state.clocks.set(trackId, pts + duration);
          if (!MPEG4_CODECS.has(track.codecId.toUpperCase()) && !["h264", "hevc"].includes(track.codecId) && !MPEG_AUDIO_CODECS.has(track.codecId) && (track.type === "audio" || length)) state.index.coverThrough(trackId, Math.max(0, pts + duration));
        }
        state.at = next;
        state.index.flushPending();
      }
    } catch (error) {
      if (isUnavailable(error) && ready()) return state.index;
      throw error;
    }
    for (const timing of state.timings.values()) timing.elementary?.complete();
    state.index.flushPending();
    for (const trackId of state.clocks.keys()) state.index.complete(trackId);
    this.#packets = state.index;
    return this.#packets;
  }

  async #appendPacket(index, timings, track, packet) {
    if ((track.type === "audio" && MPEG_AUDIO_CODECS.has(track.codecId)) ||
        (track.type === "video" && ["h264", "hevc"].includes(track.codecId))) {
      let timing = timings.get(track.trackNumber);
      if (!timing) timings.set(track.trackNumber, timing = {
        elementary: new MpegElementaryIndex([track], { index }), stamped: false, current: null
      });
      const [start, end] = packet.ranges[0];
      if (timing.current?.start !== start) timing.current = { start, at: start };
      index.flushPending();
      while (timing.current.at <= end) {
        const at = timing.current.at, last = Math.min(end, at + this.portionBytes - 1);
        const bytes = await this.readRange(at, last);
        timing.elementary.push(track.trackNumber, bytes, at, timing.stamped ? {} : { pts: track.startTimeSeconds, dts: track.startTimeSeconds });
        timing.stamped = true;
        timing.current.at = last + 1;
        index.flushPending();
      }
      return;
    }
    if (track.type !== "video" || !MPEG4_CODECS.has(track.codecId.toUpperCase())) {
      index.append(track.trackNumber, packet);
      return;
    }
    let timing = timings.get(track.trackNumber);
    if (!timing) timings.set(track.trackNumber, timing = new Mpeg4PictureTiming(this.packetMemory));
    const [start, end] = packet.ranges[0];
    const picture = await timing.read(this.readRange, start, end, track.startTimeSeconds);
    for (const one of picture.pictures) {
      if (one.coded) index.append(track.trackNumber, { ...packet, pts: one.pts, keyframe: one.keyframe, ranges: [[one.start, one.end]] });
      else if (!picture.packed) index.extendLastPresentation(track.trackNumber, packet.duration);
      if (one.coveredThrough !== null) index.coverThrough(track.trackNumber, Math.max(0, one.coveredThrough));
    }
    picture.commit();
  }
}

/** Walk declared chunks without reading media or alignment padding. */
async function riffChunks(read, start, end, stopAfterListType = null) {
  const chunks = [];
  for (let at = start; at < end;) {
    if (at + 8 > end) throw new Error("AVI chunk header is truncated.");
    const head = await read(at, at + 7);
    const id = head.toString("ascii", 0, 4);
    const size = head.readUInt32LE(4);
    const dataStart = at + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > end) throw new Error("AVI chunk exceeds its containing list.");
    let type = null;
    if (id === "LIST") {
      if (size < 4) throw new Error("AVI list type is absent.");
      type = (await read(dataStart, dataStart + 3)).toString("ascii");
    }
    chunks.push({ id, type, start: dataStart, end: dataEnd });
    if (type !== null && type === stopAfterListType) break;
    at = dataEnd + (size & 1);
  }
  return chunks;
}

function waveCodec(tag) {
  return new Map([[1, "pcm"], [3, "pcm_float"], [0x50, "mp2"], [0x55, "mp3"],
    [0xff, "aac"], [0x160, "wmav1"], [0x161, "wmav2"], [0x2000, "ac3"], [0x2001, "dts"]]).get(tag) ?? `wave:${tag}`;
}

// ---------------------------------------------------------------------------
// RIFF speaking about AVI: the idx1 index and its keyframe flag.
// Here because the class is the only way in.
// ---------------------------------------------------------------------------
/**
 * @file Keyframe index for AVI, read without downloading the file.
 *
 * AVI ends with an `idx1` chunk: one fixed-size entry per stream chunk, each
 * carrying a flags word whose keyframe bit says whether that chunk starts a
 * keyframe. Frame number times the video stream's frame duration gives the
 * time, so the index alone is enough — no media has to be read.
 *
 * `idx1` lives at the end of the file and the top-level chunk headers state
 * their sizes, so it is reached by stepping over headers (typically two hops:
 * `LIST hdrl`, `LIST movi`), not by scanning.
 *
 * Still relevant despite the format's age: older releases are largely XviD in
 * AVI, and those are exactly the files that get copied rather than re-encoded.
 */

const HEADER_BYTES = 8;
const PROBE_BYTES = 4096;
// Keyframe flag in an idx1 entry's flags word (AVIIF_KEYFRAME).
const KEYFRAME_FLAG = 0x10;
const IDX1_ENTRY_BYTES = 16;
// Cap on the idx1 read. One entry per chunk, 16 bytes each — a long film runs
// to a few MB; beyond this is not a normal index.
const MAX_IDX1_BYTES = 64 * 1024 * 1024;

/**
 * Whether this looks like AVI: a RIFF container whose form type is `AVI `.
 *
 * @param {Buffer} head
 * @returns {boolean}
 */
function isAvi(head) {
  return (
    head.length >= 12 &&
    head.toString("latin1", 0, 4) === "RIFF" &&
    head.toString("latin1", 8, 12) === "AVI "
  );
}

/**
 * Microseconds per frame and the video stream's chunk id prefix, from the main
 * header. Both live in the `hdrl` list near the file start.
 *
 * @param {Buffer} head
 * @returns {{ microsecondsPerFrame: number } | null}
 */
function readMainHeader(head) {
  // Top-level: "RIFF" size "AVI " then chunks. `avih` sits inside `LIST hdrl`.
  let offset = 12;
  while (offset + HEADER_BYTES <= head.length) {
    const id = head.toString("latin1", offset, offset + 4);
    const size = head.readUInt32LE(offset + 4);
    if (size <= 0) {
      return null;
    }
    if (id === "LIST") {
      // Descend: list type follows the header, then its own chunks.
      const listType = head.toString("latin1", offset + 8, offset + 12);
      if (listType === "hdrl") {
        let inner = offset + 12;
        while (inner + HEADER_BYTES <= Math.min(head.length, offset + 8 + size)) {
          const innerId = head.toString("latin1", inner, inner + 4);
          const innerSize = head.readUInt32LE(inner + 4);
          if (innerSize <= 0) {
            return null;
          }
          if (innerId === "avih" && inner + 8 + 4 <= head.length) {
            return { microsecondsPerFrame: head.readUInt32LE(inner + 8) };
          }
          inner += HEADER_BYTES + innerSize + (innerSize % 2);
        }
      }
      offset += HEADER_BYTES + 4 + (size - 4) + ((size - 4) % 2);
      continue;
    }
    offset += HEADER_BYTES + size + (size % 2);
  }
  return null;
}

/**
 * Step over top-level chunks to find `idx1`.
 *
 * @param {(start: number, end: number) => Promise<Buffer | null>} readRange
 * @param {number} fileSize
 * @returns {Promise<{ offset: number, size: number } | null>}
 */
async function findIdx1(readRange, fileSize) {
  let offset = 12; // Past "RIFF" size "AVI ".
  while (offset + HEADER_BYTES < fileSize) {
    const probe = await readRange(offset, Math.min(fileSize - 1, offset + HEADER_BYTES - 1));
    if (!probe || probe.length < HEADER_BYTES) {
      return null;
    }
    const id = probe.toString("latin1", 0, 4);
    const size = probe.readUInt32LE(4);
    if (size <= 0) {
      return null;
    }
    if (id === "idx1") {
      return { offset: offset + HEADER_BYTES, size };
    }
    // Chunks are word-aligned; a LIST carries its type inside the payload, so
    // the same size arithmetic covers both cases.
    offset += HEADER_BYTES + size + (size % 2);
  }
  return null;
}

/**
 * Read the keyframe times of an AVI file.
 *
 * @param {(start: number, end: number) => Promise<Buffer | null>} readRange
 * @param {number} fileSize
 * @returns {Promise<number[] | null>} Ascending seconds, or null when the file
 *   has no `idx1` (OpenDML-only index, interrupted write, damaged upload).
 */
async function readAviKeyframeTimes(readRange, fileSize) {
  const head = await readRange(0, Math.min(PROBE_BYTES - 1, fileSize - 1));
  if (!head || !isAvi(head)) {
    return null;
  }
  const mainHeader = readMainHeader(head);
  if (!mainHeader || !mainHeader.microsecondsPerFrame) {
    return null;
  }

  const idx1 = await findIdx1(readRange, fileSize);
  if (!idx1 || idx1.size > MAX_IDX1_BYTES) {
    return null;
  }

  const table = await readRange(idx1.offset, Math.min(fileSize - 1, idx1.offset + idx1.size - 1));
  if (!table || table.length < IDX1_ENTRY_BYTES) {
    return null;
  }

  const secondsPerFrame = mainHeader.microsecondsPerFrame / 1e6;
  const times = [];
  let videoFrame = 0;
  for (let at = 0; at + IDX1_ENTRY_BYTES <= table.length; at += IDX1_ENTRY_BYTES) {
    const chunkId = table.toString("latin1", at, at + 4);
    // Video chunks are "##db" (uncompressed) or "##dc" (compressed); audio is
    // "##wb" and must not advance the frame counter.
    const isVideo = chunkId.endsWith("db") || chunkId.endsWith("dc");
    if (!isVideo) {
      continue;
    }
    const flags = table.readUInt32LE(at + 4);
    if ((flags & KEYFRAME_FLAG) !== 0) {
      times.push(videoFrame * secondsPerFrame);
    }
    videoFrame += 1;
  }
  if (times.length === 0) {
    return null;
  }
  // AVI names a keyframe by its FRAME NUMBER, and the time above is that number
  // multiplied by the frame duration the header declares. The frames are the
  // right ones — measured 2026-08-21 against the files themselves, 1196 index
  // entries against 1196 real keyframes and 901 against 901, exactly — but the
  // names are 10-44 ms away from the presentation times the demuxer computes,
  // always under one frame. So the caller is told how far a time here may be
  // from the instant it refers to, and can ask for a seek late enough that it
  // still lands on the frame rather than on the one before it.
  return { times, tolerance: secondsPerFrame };
}
