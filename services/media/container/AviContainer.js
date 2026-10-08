/**
 * @file AVI container — RIFF.
 *
 * Stream declarations, and from the index alone (`idx1` or OpenDML) the
 * keyframes and the original bytes a run needs: FFmpeg reads an indexed AVI
 * from the file itself (`avi-index.js`, torrent-tv/meta#151). Packets are
 * reassembled only for an AVI that states no index.
 */

import { Container } from "./Container.js";
import { VideoTrack } from "../tracks/VideoTrack.js";
import { AudioTrack } from "../tracks/AudioTrack.js";
import { ContainerTrack } from "../tracks/ContainerTrack.js";
import { PacketIndex } from "./PacketIndex.js";
import { readAviIndex } from "./avi-index.js";
import { isUnavailable } from "./unavailable.js";
import { Mpeg4PictureTiming } from "./mpeg4-picture-timing.js";
import { MpegElementaryIndex } from "./mpeg-elementary-index.js";
import { RetainedReads } from "./RetainedReads.js";
import { OutsideReadableEdges, edgeReader, emptyWorkTags, text, textList, yearOf } from "./work-tags.js";

const MPEG4_CODECS = new Set(["FMP4", "XVID", "DIVX", "DX50", "MP4V", "M4S2", "MP4S"]);
/** FFmpeg's input buffer, filled ahead of what its demuxer parses (`IO_BUFFER_SIZE`, libavformat/aviobuf.c n8.1). */
const FFMPEG_INPUT_BUFFER_BYTES = 32768;
/** Picture codecs whose every picture stands alone, so decoding order is showing order. */
const INTRA_PICTURE_CODECS = new Set(["MJPG", "JPEG", "DIB ", "\0\0\0\0", "I420", "YV12", "YUY2", "UYVY"]);
const MPEG_AUDIO_CODECS = new Set(["mp1", "mp2", "mp3"]);
const NAL_CODECS = new Map([["H264", "h264"], ["X264", "h264"], ["AVC1", "h264"], ["HEVC", "hevc"], ["H265", "hevc"]]);

export class AviContainer extends Container {
  #headers = null;
  #tracks = null;
  #packets = null;
  #scan = null;
  #declarations = null;
  #workTags = null;
  /** The index alone: undefined until read, null when the file states none. */
  #index = undefined;
  #layout = null;

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


  /** The first RIFF's `movi` list and `idx1` chunk. */
  async #topLevel() {
    if (this.#layout) return this.#layout;
    const header = await this.readRange(0, 11);
    const chunks = await riffChunks(this.readRange, 12, 8 + header.readUInt32LE(4));
    const movi = chunks.find(chunk => chunk.id === "LIST" && chunk.type === "movi");
    if (!movi) throw new Error("AVI media list is absent.");
    this.#layout = { movi, idx1: chunks.find(chunk => chunk.id === "idx1") ?? null };
    return this.#layout;
  }

  /**
   * What the index states, read once; null when the file states no index.
   * A shortage of bytes or memory is thrown and nothing is kept, so the next
   * read starts again from the index (the index is small and read in requests).
   */
  async #readIndex() {
    if (this.#index !== undefined) return this.#index;
    const tracks = await this.readTracks();
    const { streams } = await this.#readHeaders();
    const { movi, idx1 } = await this.#topLevel();
    const record = { dispose: () => this.#index?.dispose?.() };
    const allocation = this.packetMemory?.forRecord?.(record, "index") ?? this.packetMemory;
    const index = await readAviIndex({ read: this.readRange, fileSize: this.fileSize, movi, idx1, allocation,
      streams: tracks.map(track => ({ type: track.type, codecId: track.codecId, timeBase: track.timeBase,
        sampleSize: track.sampleSize, blockAlign: track.blockAlign ?? 0, startUnits: track.startUnits ?? 0,
        indexChunks: streams[track.trackNumber].indexChunks })) });
    this.#index = index;
    return index;
  }

  async supportsOriginalSourceRanges() {
    const index = await this.#readIndex();
    if (!index) return false;
    const picture = ContainerTrack.firstUsable(await this.readTracks(), "video");
    return !picture || index.keyframeTimes(picture.trackNumber).length > 0;
  }

  async readMappedSourceRanges(interval) { return this.readSourceRanges(interval); }

  /**
   * The bytes FFmpeg reads to produce `[from, to)` from the original file:
   * the declarations and the start of `movi` it probes, the index it loads at
   * open (`idx1` to the end of the file, or every OpenDML standard index), the
   * first packet of each stream it inspects, and the selected streams' packets
   * around the interval. Each range is held one input buffer of FFmpeg past its
   * last named byte, because that buffer is filled ahead of the packet parsed.
   */
  async readSourceRanges(interval) {
    if (!Number.isFinite(interval?.from) || !Number.isFinite(interval?.to) || interval.to <= interval.from) {
      throw new TypeError("Source ranges require a finite increasing interval.");
    }
    const index = await this.#readIndex();
    if (!index) return { kind: "needs-index", reason: "source-has-no-avi-index" };
    const tracks = await this.readTracks();
    const { movi } = await this.#topLevel();
    // Every audio and video stream, whichever the run outputs: FFmpeg's AVI
    // demuxer seeks to the earliest position any stream's index gives for the
    // keyframe time (`pos_min`, avi_read_seek) and reads every stream's packets
    // in file order. Naming only the run's own tracks left a picture-only run
    // asking for sound it was not given, and its seek failed (torrent-tv/meta#151).
    const requested = tracks.filter(track => ["video", "audio"].includes(track.type));
    const picture = ContainerTrack.firstUsable(tracks, "video");
    const padded = ([start, end]) => [Math.max(0, start), Math.min(this.fileSize - 1, end + FFMPEG_INPUT_BUFFER_BYTES)];
    const ranges = [[0, movi.start + 3], ...index.indexRanges, ...index.firstPackets(),
      ...index.mediaRanges({ from: interval.from, to: interval.to, picture: picture?.trackNumber ?? null,
        streams: requested.map(track => track.trackNumber) })].map(padded);
    ranges.sort((left, right) => left[0] - right[0]);
    const union = [];
    for (const range of ranges) {
      const previous = union.at(-1);
      if (previous && range[0] <= previous[1] + 1) previous[1] = Math.max(previous[1], range[1]);
      else union.push([...range]);
    }
    return { kind: "result", from: interval.from, to: interval.to, ranges: union, fileLength: this.fileSize };
  }

  packetIndexBytes() { return (this.#packets ?? this.#scan?.index)?.allocatedBytes() ?? 0; }

  static detect(head) {
    return isAvi(head);
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
        track.blockAlign = strf.readUInt16LE(12);
        track.matroskaCodecId = "A_MS/ACM";
        track.matroskaCodecPrivateB64 = (strf.length === 16
          ? Buffer.concat([strf, Buffer.alloc(2)]) : strf).toString("base64");
      } else track = new ContainerTrack({ ...params, codecId: strh.toString("ascii", 4, 8) });
      track.timeBase = scale > 0 && rate > 0 ? scale / rate : null;
      track.startTimeSeconds = track.timeBase === null ? null : strh.readUInt32LE(28) * track.timeBase;
      track.durationSeconds = track.timeBase === null ? null : strh.readUInt32LE(32) * track.timeBase;
      track.sampleSize = strh.readUInt32LE(44);
      track.startUnits = strh.readUInt32LE(28);
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
    const picture = ContainerTrack.firstUsable(await this.readTracks(), "video");
    if (!picture) return null;
    // The index states every keyframe on the clock FFmpeg reads the file by,
    // so no packet is read to learn them (torrent-tv/meta#151). A file with no
    // index has its packets scanned instead.
    // AVI states no presentation time, only each packet's place in decoding
    // order. A picture whose codec may show its pictures in another order
    // (B-pictures) is therefore not copied: FFmpeg stamps a copy with the
    // decoding times and the pictures lose their order — measured on an H.264
    // AVI with B-pictures, where a whole-file copy to MP4 decodes to other
    // pictures than the source. Reading the order from the bitstream is the
    // parsing the original-file path exists to avoid (torrent-tv/meta#151).
    const copyable = INTRA_PICTURE_CODECS.has(picture.codecId.toUpperCase());
    const index = await this.#readIndex();
    if (index) return { times: index.keyframeTimes(picture.trackNumber), tolerance: 0, copyable };
    return { times: (await this.readPacketIndex()).keyframesOf(picture.trackNumber), tolerance: 0, copyable };
  }

  async readPacketIndex(interval) {
    if (this.#packets) return this.#packets;
    if (this.#scan) return this.#readUnindexed(interval);
    // A file with an index is read by FFmpeg from the original bytes; packets
    // are reassembled only where no index states them (torrent-tv/meta#151).
    if (await this.#readIndex()) throw new Error("AVI with an index is read from the original file, not from reassembled packets.");
    const tracks = await this.readTracks();
    const { streams } = await this.#readHeaders();
    const index = new PacketIndex({ packetMemory: this.packetMemory, deferMemory: true });
    const clocks = new Map();
    for (const track of tracks.filter(track => ["video", "audio"].includes(track.type))) {
      if (!(track.timeBase > 0)) throw new Error("AVI stream time base is invalid.");
      if (track.type === "video" && !["h264", "hevc"].includes(track.codecId) && !MPEG4_CODECS.has(track.codecId.toUpperCase()) && !INTRA_PICTURE_CODECS.has(track.codecId.toUpperCase())) {
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



