/**
 * @file MP4/MOV container — ISO/IEC 14496-12.
 *
 * Parses moov for all track types in one walk:
 *  - tkhd: track_ID, flags track_enabled (0x000001), alternate_group, width/height
 *  - mdhd: timescale, language (packed 5-bit), version handling
 *  - hdlr: handler_type (vide/soun/text/sbtl/subt/subp/clcp)
 *  - elng: extendedLanguage BCP47 (when present, replaces mdhd language per spec)
 *  - stsd: sample entry format (avc1/hev1/mp4a/tx3g/wvtt/stpp)
 *  - stbl tables for subtitle cue ranges (stts/stsz/stsc/stco/co64) and video keyframes (stss/stts/ctts/elst)
 *
 * Keyframe reading is delegated to mp4.js. The subtitle sample table is read in
 * this module, because every rule in it is a statement of ISO/IEC 14496-12 about
 * this container. Track creation is centralised here so that track_enabled,
 * `elng` and alternate_group are handled once for every media type.
 */

import { Container } from "./Container.js";
import { RetainedBytes } from "./RetainedBytes.js";
import { VideoTrack } from "../tracks/VideoTrack.js";
import { AudioTrack } from "../tracks/AudioTrack.js";
import { TextSubtitleTrack, TEXT_FORMATS_MP4 } from "../tracks/TextSubtitleTrack.js";
import { ImageSubtitleTrack } from "../tracks/ImageSubtitleTrack.js";
import { isUnavailable } from "./unavailable.js";
import { PacketIndex } from "./PacketIndex.js";
import { h264Configuration } from "./h264-configuration.js";
import { hevcConfiguration } from "./hevc-configuration.js";
import { mpegAudioFrame } from "./mpeg-audio-frame.js";
import { readMp4Fragments } from "./mp4-fragments.js";
import { workFromMoov } from "./mp4-work-tags.js";
import { COVER_TYPES, MAX_COVER_BYTES, emptyWorkTags, imageTypeOf } from "./work-tags.js";

/** A box header is eight bytes, or sixteen when the size field says 1 (§4.2). */
const HEADER_BYTES = 8;
const LARGE_SIZE_MARKER = 1;
const LARGE_HEADER_BYTES = 16;

/**
 * One box header, per ISO/IEC 14496-12 §4.2.
 *
 * @param {Buffer} buf
 * @param {number} off
 * @returns {{ type: string, size: number, dataOffset: number, end: number } | null}
 */
function readBox(buffer, offset) {
  if (offset + HEADER_BYTES > buffer.length) {
    return null;
  }
  let size = buffer.readUInt32BE(offset);
  const type = buffer.toString("latin1", offset + 4, offset + 8);
  let headerBytes = HEADER_BYTES;
  // A size of 1 means the real size is the 64-bit value after the type.
  if (size === LARGE_SIZE_MARKER) {
    if (offset + LARGE_HEADER_BYTES > buffer.length) {
      return null;
    }
    size = Number(buffer.readBigUInt64BE(offset + HEADER_BYTES));
    headerBytes = LARGE_HEADER_BYTES;
  }
  if (size < headerBytes) {
    return null;
  }
  return { type, size, dataOffset: offset + headerBytes, end: offset + size };
}

/**
 * Every direct child box of the given type.
 *
 * @param {Buffer} buf
 * @param {number} start
 * @param {number} end
 * @param {string} type
 * @returns {Array<{ type: string, size: number, dataOffset: number, end: number }>}
 */
function childrenOf(buf, start, end, type) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    const b = readBox(buf, p);
    if (!b) break;
    if (b.type === type) out.push(b);
    p = b.end;
  }
  return out;
}

/**
 * The first direct child box of the given type, or null.
 *
 * @param {Buffer} buf
 * @param {number} s
 * @param {number} e
 * @param {string} t
 * @returns {{ type: string, size: number, dataOffset: number, end: number } | null}
 */
function childOf(buf, s, e, t) {
  return childrenOf(buf, s, e, t)[0] ?? null;
}

/**
 * The channel count, sampling frequency and decoder configuration one audio
 * sample entry states (ISO/IEC 14496-12 §12.2.3, AudioSampleEntry).
 *
 * After the 8 bytes every SampleEntry begins with come 8 reserved bytes —
 * whose first two QuickTime uses as a version that lengthens the entry by 16
 * (version 1) or 36 (version 2) bytes — then `channelcount`, `samplesize`, two
 * reserved fields and `samplerate` as 16.16 fixed point. Child boxes follow.
 * For `mp4a` the child `esds` holds the AudioSpecificConfig (ISO/IEC 14496-1
 * §7.2.6: ES_Descriptor, then DecoderConfigDescriptor, then
 * DecoderSpecificInfo).
 *
 * @param {Buffer} buf
 * @param {{ type: string, dataOffset: number, end: number }} entry
 * @returns {{ channels: number | null, sampleRate: number | null, decoderConfig: Buffer | null } | null}
 */
function readAudioSampleEntry(buf, entry) {
  const base = entry.dataOffset;
  if (base + 28 > entry.end || base + 28 > buf.length) {
    return null;
  }
  const version = buf.readUInt16BE(base + 8);
  let channels = buf.readUInt16BE(base + 16);
  let sampleRate = buf.readUInt32BE(base + 24) / 65536;
  let bitDepth = buf.readUInt16BE(base + 18);
  let codecId = entry.type;
  if (entry.type === ".mp3") codecId = "mp3";
  let codecDelaySeconds = 0;
  let seekPrerollSeconds = 0;
  const childrenStart = base + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0);
  if (version > 2 || childrenStart > entry.end) throw new Error("QuickTime audio sample description is incomplete or unsupported.");
  if (version === 2) {
    sampleRate = buf.readDoubleBE(base + 32);
    channels = buf.readUInt32BE(base + 40);
    bitDepth = buf.readUInt32BE(base + 48);
    if (entry.type === "lpcm") {
      const flags = buf.readUInt32BE(base + 52);
      if ((flags & 32) || !(flags & 8)) throw new Error("QuickTime LPCM needs packed interleaved samples.");
      codecId = `pcm_${flags & 1 ? "f" : flags & 4 ? "s" : "u"}${bitDepth}${bitDepth === 8 ? "" : flags & 2 ? "be" : "le"}`;
    }
  } else {
    codecId = new Map([["sowt", `pcm_s${bitDepth}le`], ["twos", `pcm_s${bitDepth}be`],
      ["in24", "pcm_s24be"], ["in32", "pcm_s32be"], ["fl32", "pcm_f32be"], ["fl64", "pcm_f64be"], ["raw ", "pcm_u8"]]).get(entry.type) ?? entry.type;
    const declaredBits = /^pcm_[suf](\d+)/.exec(codecId);
    if (declaredBits) bitDepth = Number(declaredBits[1]);
    const wave = childOf(buf, childrenStart, entry.end, "wave");
    const endian = childOf(buf, childrenStart, entry.end, "enda") ??
      (wave && childOf(buf, wave.dataOffset, wave.end, "enda"));
    if (endian && /^pcm_[sf]\d+(?:be|le)$/.test(codecId)) {
      if (endian.end - endian.dataOffset !== 2) throw new Error("QuickTime PCM byte-order declaration is invalid.");
      const little = buf.readUInt16BE(endian.dataOffset);
      if (little > 1) throw new Error("QuickTime PCM byte order is unsupported.");
      codecId = codecId.replace(/(?:be|le)$/, little ? "le" : "be");
    }
  }
  let decoderConfig = null;
  if (entry.type === "mp4a" && childrenStart < entry.end) {
    const wave = childOf(buf, childrenStart, Math.min(entry.end, buf.length), "wave");
    const esds = childOf(buf, childrenStart, Math.min(entry.end, buf.length), "esds") ??
      (wave && childOf(buf, wave.dataOffset, wave.end, "esds"));
    if (esds) {
      const description = decoderSpecificInfoOf(buf, esds.dataOffset + 4, Math.min(esds.end, buf.length));
      decoderConfig = description?.decoderConfig ?? null;
      if ([0x69, 0x6b].includes(description?.objectType)) {
        codecId = "mpeg_audio";
        decoderConfig = null;
      }
    }
  }
  if (entry.type === "alac") {
    const config = childOf(buf, childrenStart, entry.end, "alac");
    if (!config || config.end - config.dataOffset < 28) throw new Error("ALAC decoder configuration is absent or truncated.");
    decoderConfig = buf.subarray(config.dataOffset + 4, config.end);
  }
  if (entry.type === "Opus") {
    const config = childOf(buf, childrenStart, entry.end, "dOps");
    if (!config || config.end - config.dataOffset < 11) throw new Error("MP4 Opus decoder declaration is absent or truncated.");
    const data = buf.subarray(config.dataOffset, config.end);
    const family = data[10];
    if (data[0] !== 0 || !data[1] || (!family && data[1] > 2) || (family && data.length < 13 + data[1])) {
      throw new Error("MP4 Opus channel mapping is invalid.");
    }
    const head = Buffer.alloc(19);
    head.write("OpusHead");
    head[8] = 1;
    head[9] = data[1];
    head.writeUInt16LE(data.readUInt16BE(2), 10);
    head.writeUInt32LE(data.readUInt32BE(4), 12);
    head.writeInt16LE(data.readInt16BE(8), 16);
    head[18] = family;
    decoderConfig = family ? Buffer.concat([head, data.subarray(11, 13 + data[1])]) : head;
    codecDelaySeconds = data.readUInt16BE(2) / 48000;
    seekPrerollSeconds = 0.08;
    sampleRate = 48000;
    channels = data[1];
  }
  return {
    channels: channels > 0 ? channels : null,
    sampleRate: sampleRate > 0 ? sampleRate : null,
    decoderConfig, bitDepth: bitDepth > 0 ? bitDepth : null, codecId, codecDelaySeconds, seekPrerollSeconds
  };
}

/**
 * The DecoderSpecificInfo inside an `esds` payload, or null.
 *
 * Descriptors are a tag byte and a size of one to four bytes, seven bits each,
 * the high bit saying another follows (ISO/IEC 14496-1 §8.3.3).
 *
 * @param {Buffer} buf
 * @param {number} start
 * @param {number} end
 * @returns {Buffer | null}
 */
function decoderSpecificInfoOf(buf, start, end) {
  const descriptorAt = (offset, limit = end) => {
    if (offset >= limit) return null;
    const tag = buf[offset];
    let size = 0;
    let cursor = offset + 1;
    let complete = false;
    for (let i = 0; i < 4 && cursor < limit; i += 1) {
      const byte = buf[cursor];
      cursor += 1;
      size = (size * 128) + (byte & 0x7f);
      if ((byte & 0x80) === 0) { complete = true; break; }
    }
    if (!complete || cursor + size > limit) throw new Error("MP4 audio descriptor exceeds its declared parent.");
    return { tag, dataOffset: cursor, end: cursor + size };
  };
  const es = descriptorAt(start);
  if (!es || es.tag !== 0x03 || es.dataOffset + 3 > es.end) return null;
  const flags = buf[es.dataOffset + 2];
  let cursor = es.dataOffset + 3;
  if (flags & 0x80) cursor += 2;
  if (flags & 0x40) {
    if (cursor >= es.end) throw new Error("MP4 audio descriptor URL length is absent.");
    cursor += 1 + buf[cursor];
  }
  if (flags & 0x20) cursor += 2;
  if (cursor > es.end) throw new Error("MP4 audio descriptor flags exceed its declared size.");
  while (cursor < es.end) {
    const descriptor = descriptorAt(cursor, es.end);
    if (!descriptor) return null;
    if (descriptor.tag === 0x04) {
      // objectTypeIndication, streamType, bufferSizeDB, maxBitrate, avgBitrate.
      if (descriptor.dataOffset + 13 > descriptor.end) throw new Error("MP4 audio decoder descriptor is truncated.");
      const objectType = buf[descriptor.dataOffset];
      let inner = descriptor.dataOffset + 13;
      while (inner < descriptor.end) {
        const child = descriptorAt(inner, descriptor.end);
        if (!child) return null;
        if (child.tag === 0x05) {
          return { objectType, decoderConfig: child.end > child.dataOffset ? Buffer.from(buf.subarray(child.dataOffset, child.end)) : null };
        }
        inner = child.end;
      }
      return { objectType, decoderConfig: null };
    }
    cursor = descriptor.end;
  }
  return null;
}

export class Mp4Container extends Container {
  #tracks = null;
  get formatName() {
    return "mp4";
  }

  packetIndexBytes() { return this.packetIndex?.allocatedBytes() ?? 0; }

  static detect(head) {
    return isMp4(head);
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
  static async readKeyframeTimes(readRange, fileSize) {
    const index = await new Mp4Container({ readRange, fileSize }).parseKeyframeIndex();
    return index ? index.times : null;
  }

  /**
   * This container's text subtitle tracks, with every cue's time and byte
   * range — ISO/IEC 14496-12 §8.5 and §8.7.
   *
   * @param {(start:number,end:number)=>Promise<Buffer|null>} readRange
   * @param {number} fileSize
   * @returns {Promise<{ tracks: object[] } | null>}
   */
  static async readSubtitlePlan(readRange, fileSize) {
    const held = await new Mp4Container({ readRange, fileSize }).#moovBuffer();
    return held ? subtitlePlanFromMoov(held.moov) : null;
  }

  /**
   * The same reading, over the file this container was built on.
   *
   * The static form exists for a caller that has bytes and no container; this
   * is the one to use otherwise, because the reader is already here.
   *
   * @returns {Promise<object|null>}
   */
  async readSubtitlePlan() {
    const held = await this.#moovBuffer();
    const plan = held ? subtitlePlanFromMoov(held.moov) : null;
    if (!plan) {
      return null;
    }
    // An MP4 states every sample's byte range in its own table, so a cue costs
    // its own few dozen bytes rather than the cluster around it — which is why
    // there are `samples` here and no `clusterPositions`.
    //
    // An MP4 has no element meaning "show this subtitle track by default", so
    // `declared` is empty: the container states nothing, and nothing is shown
    // unasked.
    return {
      tracks: plan.tracks.map((track, order) => ({
        trackNumber: track.trackId,
        declaredIndex: Number.isInteger(track.declaredIndex) ? track.declaredIndex : order,
        codecId: track.format,
        language: track.language,
        languageSource: "language",
        name: "",
        isDefault: order === 0,
        codecPrivate: "",
        clusterPositions: [],
        samples: track.samples
      })),
      declared: [],
      secondsPerTick: 0.001,
      segmentDataOffset: 0
    };
  }


  /**
   * Read the samples of one subtitle track that are HELD now.
   *
   * An MP4 states every sample's byte range in its own table, so a cue costs its
   * own few dozen bytes rather than the cluster around it — which is why this
   * reads per sample where Matroska reads per cluster.
   *
   * Nothing is fetched: a sample whose bytes are not downloaded is left for the
   * next call, and so is one whose read did not complete — a sample is marked
   * read only once its bytes are in hand.
   *
   * @param {object} _plan
   * @param {{ trackNumber: number, codecId: string, samples: {offset: number, size: number, startSeconds: number, endSeconds: number}[] }} track
   * @param {object} progress
   * @param {import("./Container.js").HeldReader} held
   * @returns {Promise<{ found: Map<number, object[]>, covered: number, indexed: number, withdrawn: number[] }>}
   */
  async readHeldCues(_plan, track, progress, held) {
    if (!progress.mp4) {
      progress.mp4 = { harvested: new Map() };
    }
    let harvested = progress.mp4.harvested.get(track.trackNumber);
    if (!harvested) {
      harvested = new Set();
      progress.mp4.harvested.set(track.trackNumber, harvested);
    }
    const cues = await this.readHeldSamples(track, harvested, held);
    return {
      found: cues.length > 0 ? new Map([[track.trackNumber, cues]]) : new Map(),
      covered: harvested.size,
      indexed: track?.samples?.length ?? 0,
      withdrawn: []
    };
  }

  /**
   * @param {object} track
   * @param {Set<number>} harvested
   * @param {import("./Container.js").HeldReader} held
   * @returns {Promise<{startSeconds: number, endSeconds: number, text: string, source: number}[]>}
   */
  async readHeldSamples(track, harvested, held) {
    const found = [];
    for (const sample of track?.samples ?? []) {
      if (harvested.has(sample.offset)) {
        continue;
      }
      const last = Math.min(this.fileSize - 1, sample.offset + sample.size - 1);
      if (!held.isHeld(sample.offset, last)) {
        continue;
      }
      let bytes;
      try {
        bytes = await held.read(sample.offset, last);
      } catch (error) {
        if (isUnavailable(error)) {
          continue;
        }
        throw error;
      }
      harvested.add(sample.offset);
      // The MP4 has framed this cue and is the one that unframes it.
      const text = Mp4Container.cueTextOf(bytes, track.codecId);
      if (text) {
        found.push({ startSeconds: sample.startSeconds, endSeconds: sample.endSeconds, text, source: sample.offset });
      }
    }
    return found;
  }

  async readTracks() {
    if (this.#tracks) return this.#tracks;
    const head = await this.readRange(0, Math.min(64 - 1, this.fileSize - 1));
    if (!isMp4(head)) return [];

    // Subtitle tracks from the subtitle reading of the one `moov`, video and
    // audio from a walk of the same buffer — the box is read once per file.
    // A read that has not arrived is not swallowed here: it is not an answer
    // about the file, and the caller keeps nothing for it.
    const held = await this.#moovBuffer();
    const subtitlePlan = held ? subtitlePlanFromMoov(held.moov) : null;
    const subtitleByDecl = new Map();
    if (subtitlePlan?.tracks) {
      for (const t of subtitlePlan.tracks) subtitleByDecl.set(t.declaredIndex, t);
    }

    // Minimal moov walk for video/audio: reuse isMp4 + findMoov logic by reading via existing helper
    // Instead of duplicating, parse tracks via a second full moov read that collects vide/soun.
    // We read moov box directly to extract video/audio tracks.
    const tracks = await this.#readVideoAudioTracks();
    // Append subtitle tracks from plan, converting to domain objects
    if (subtitlePlan?.tracks) {
      for (const s of subtitlePlan.tracks) {
        const isText = TEXT_FORMATS_MP4.has(s.format);
        const Cls = isText ? TextSubtitleTrack : ImageSubtitleTrack;
        tracks.push(new Cls({
          trackNumber: s.trackId,
          declaredIndex: s.declaredIndex,
          codecId: s.format,
          language: s.language,
          languageBcp47: "",
          languageSource: "language",
          name: "",
          isEnabled: true,
          isDefault: s.declaredIndex === 0,
          declaresDefault: false,
          codecPrivateB64: "",
          // The sample entry's own words, read below. Either
          // bit is enough: a file that sets only "all samples are forced" is
          // saying what a well-formed one says twice.
          isForced: s.someSamplesForced === true || s.allSamplesForced === true,
          isHearingImpaired: false,
          clusterPositions: [],
          samples: s.samples
        }));
      }
      // Count non-text subtitle handlers (subp/clcp/stpp) for declaredIndex correctness — they are already
      // accounted for in subtitlePlan's declaredIndex via SUBTITLE_HANDLERS, but we didn't create objects for
      // them above when they were stpp (non-text not in plan's tracks). The plan already excludes stpp from tracks
      // but increments declaredIndex, so alignment holds: we don't need extra placeholders.
    }
    const pendingAudio = tracks.filter(track => track.codecId === "mpeg_audio");
    if (pendingAudio.length) {
      this.fragmentState ??= {};
      await readMp4Fragments({ readRange: this.readRange, fileSize: this.fileSize,
        tracks: fragmentTracks(held, tracks), memory: this.packetMemory, state: this.fragmentState,
        firstTrackIds: pendingAudio.map(track => track.trackNumber) });
      for (const track of pendingAudio) {
        if (track.codecId !== "mpeg_audio") continue;
        throw new Error("MP4 MPEG audio has no addressed sample declaring its codec.");
      }
    }
    this.#tracks = tracks;
    return tracks;
  }

  /**
   * The `moov` box, read whole — the ONE reading of it every question here is
   * answered from.
   *
   * Held on the instance because every question this class answers is inside
   * it, and the box can be tens of megabytes off a torrent. Until 2026-10-01 it
   * was read by three functions besides this one, each with its own rule for a
   * read that failed.
   *
   * Three outcomes are kept: the box; null where the file has no `moov`; and
   * null with `moovRefused` set where the box is larger than this program reads
   * whole — a limit of ours, said as one, not an absence. A read whose bytes
   * have not arrived throws `BytesUnavailable` and keeps nothing.
   *
   * @returns {Promise<{ moov: Buffer, header: number } | null>}
   */
  async #moovBuffer() {
    if (this.moovHeld !== undefined) {
      return this.moovHeld;
    }
    const found = await findMoov(this.readRange, this.fileSize);
    if (!found) {
      this.moovHeld = null;
      return null;
    }
    if (found.size > MAX_MOOV_BYTES) {
      this.moovRefused = { size: found.size, limit: MAX_MOOV_BYTES };
      this.moovHeld = null;
      return null;
    }
    this.moovMemory ??= new RetainedBytes(this.packetMemory);
    const moov = await this.moovMemory.read(found.size,
      () => this.readRange(found.offset, found.offset + found.size - 1));
    this.moovHeld = { moov, header: found.headerBytes, offset: found.offset };
    return this.moovHeld;
  }

  /**
   * What the file states about the work, from the `moov` box this class
   * already holds for its tracks (see `mp4-work-tags.js`). The box is a read
   * playback makes anyway, so `mayFetch` has nothing to decide here.
   *
   * @param {(start: number, end: number) => boolean} _mayFetch
   * @returns {Promise<import("./work-tags.js").WorkTags>}
   */
  async readWorkTags(_mayFetch) {
    if (this.workTags) return this.workTags;
    const tags = emptyWorkTags();
    const held = await this.#moovBuffer();
    if (held) {
      const { work, cover } = workFromMoov(held.moov, held.header);
      Object.assign(tags, work);
      if (cover && cover.size > 0 && cover.size <= MAX_COVER_BYTES) tags.cover = { type: cover.type, size: cover.size };
    }
    tags.trackTitles = await this.trackTitlesForWork();
    this.workTags = tags;
    return tags;
  }

  /**
   * The cover the item list carries, its bytes checked to be the image its
   * type says. `null` where there is none or it is larger than {@link MAX_COVER_BYTES}.
   *
   * @param {(start: number, end: number) => boolean} _mayFetch
   * @returns {Promise<{ type: string, bytes: Buffer } | null>}
   */
  async readCover(_mayFetch) {
    const held = await this.#moovBuffer();
    const cover = held ? workFromMoov(held.moov, held.header).cover : null;
    if (!cover || cover.size === 0 || cover.size > MAX_COVER_BYTES) return null;
    const bytes = Buffer.from(held.moov.subarray(cover.at, cover.at + cover.size));
    const type = imageTypeOf(bytes);
    return type && COVER_TYPES.has(type) ? { type, bytes } : null;
  }

  /** Exact decode-order samples from the same moov used for all metadata. */
  async readPacketIndex() {
    if (this.packetIndex) return this.packetIndex;
    const held = await this.#moovBuffer();
    if (!held) throw new Error(this.moovRefused ? "MP4 metadata exceeds the configured read limit." : "MP4 has no sample tables.");
    const tracks = await this.readTracks();
    const fragmented = childOf(held.moov, held.header, held.moov.length, "mvex");
    let index;
    if (fragmented) {
      this.fragmentState ??= {};
      index = await readMp4Fragments({ readRange: this.readRange, fileSize: this.fileSize,
        tracks: fragmentTracks(held, tracks), memory: this.packetMemory, state: this.fragmentState });
      const timeline = tracks.find(track => track.type === "video") ?? tracks.find(track => track.type === "audio");
      const bounds = timeline && index.boundsOf(timeline.trackNumber);
      if (bounds) this.mediaInfo = { ...(await this.readMediaInfo()), startTimeSeconds: bounds.start,
        durationSeconds: bounds.end - bounds.start };
    } else index = packetIndexFromMoov(held, this.fileSize, tracks, this.packetMemory);
    this.packetIndex = index;
    return index;
  }

  /**
   * Duration from `mvhd` and the presentation offset from the first track's
   * edit list, per ISO/IEC 14496-12 §8.2.2 and §8.6.6.
   *
   * An edit entry whose `media_time` is -1 is an EMPTY edit: it presents
   * nothing for `segment_duration`, which shifts everything after it later by
   * that much. That shift is what a player reports as the file's start, and it
   * is the only way an MP4 states one — a file without such an edit begins at
   * zero, which is a declaration, not an absence.
   *
   * @returns {Promise<import("./Container.js").ContainerMediaInfo>}
   */
  async readMediaInfo() {
    if (this.mediaInfo) {
      return this.mediaInfo;
    }
    /** @type {import("./Container.js").ContainerMediaInfo} */
    const info = { format: this.formatName, durationSeconds: null, startTimeSeconds: null };
    const held = await this.#moovBuffer();
    // Kept only once the `moov` reading has an outcome: a read that had not
    // arrived used to leave an empty answer here for the life of the container.
    this.mediaInfo = info;
    if (!held) {
      return info;
    }
    const { moov, header } = held;
    const mvhd = childOf(moov, header, moov.length, "mvhd");
    let movieTimescale = 0;
    if (mvhd) {
      const version = moov[mvhd.dataOffset];
      // version 0: creation(4) modification(4) timescale(4) duration(4)
      // version 1: creation(8) modification(8) timescale(4) duration(8)
      const at = version === 1 ? mvhd.dataOffset + 20 : mvhd.dataOffset + 12;
      if (at + 8 <= moov.length) {
        movieTimescale = moov.readUInt32BE(at);
        const duration = version === 1 ? Number(moov.readBigUInt64BE(at + 4)) : moov.readUInt32BE(at + 4);
        if (movieTimescale > 0 && duration > 0) {
          info.durationSeconds = duration / movieTimescale;
        }
      }
    }
    info.startTimeSeconds = movieTimescale > 0
      ? Mp4Container.#emptyEditSeconds(moov, header, movieTimescale)
      : null;
    return info;
  }

  /**
   * The presentation shift of the first empty edit, in seconds; 0 when no track
   * declares one.
   *
   * @param {Buffer} moov
   * @param {number} header
   * @param {number} movieTimescale
   * @returns {number}
   */
  static #emptyEditSeconds(moov, header, movieTimescale) {
    let shift = 0;
    for (const trak of childrenOf(moov, header, moov.length, "trak")) {
      const edts = childOf(moov, trak.dataOffset, trak.end, "edts");
      const elst = edts && childOf(moov, edts.dataOffset, edts.end, "elst");
      if (!elst) {
        continue;
      }
      const version = moov[elst.dataOffset];
      const count = moov.readUInt32BE(elst.dataOffset + 4);
      if (count < 1) {
        continue;
      }
      const entry = elst.dataOffset + 8;
      const segmentDuration = version === 1
        ? Number(moov.readBigUInt64BE(entry))
        : moov.readUInt32BE(entry);
      const mediaTime = version === 1
        ? Number(moov.readBigInt64BE(entry + 8))
        : moov.readInt32BE(entry + 4);
      if (mediaTime === -1 && segmentDuration > 0) {
        shift = Math.max(shift, segmentDuration / movieTimescale);
      }
    }
    return shift;
  }

  async #readVideoAudioTracks() {
    const held = await this.#moovBuffer();
    if (!held) return [];
    const { moov, header: moovHeader } = held;

    const result = [];
    let videoIdx = -1;
    let audioIdx = -1;

    const moovContentStart = moovHeader;
    const moovEnd = moov.length;
    for (const trak of childrenOf(moov, moovContentStart, moovEnd, "trak")) {
      const mdia = childOf(moov, trak.dataOffset, trak.end, "mdia");
      if (!mdia) continue;
      const hdlr = childOf(moov, mdia.dataOffset, mdia.end, "hdlr");
      const handler = hdlr ? moov.toString("latin1", hdlr.dataOffset + 8, hdlr.dataOffset + 12) : "";
      const mdhd = childOf(moov, mdia.dataOffset, mdia.end, "mdhd");
      const tkhd = childOf(moov, trak.dataOffset, trak.end, "tkhd");
      let language = "";
      if (mdhd) {
        const ver = moov[mdhd.dataOffset];
        const langAt = ver === 1 ? mdhd.dataOffset + 32 : mdhd.dataOffset + 20;
        if (langAt + 2 <= mdhd.end) {
          const packed = moov.readUInt16BE(langAt);
          language = [10, 5, 0].map((s) => String.fromCharCode(((packed >> s) & 0x1f) + 0x60)).join("").replace(/[^a-z]/g, "");
        }
      }
      // elng overrides mdhd language per spec §8.4.6
      let languageBcp47 = "";
      const elng = childOf(moov, mdia.dataOffset, mdia.end, "elng");
      if (elng && elng.end - elng.dataOffset >= 4) {
        languageBcp47 = moov.toString("utf8", elng.dataOffset + 4, elng.end).replace(/\0+$/, "");
      }
      let trackId = 0;
      let isEnabled = true;
      let alternateGroup = 0;
      let width = null;
      let height = null;
      if (tkhd) {
        const ver = moov[tkhd.dataOffset];
        const flags = moov.readUIntBE(tkhd.dataOffset + 1, 3);
        isEnabled = (flags & 0x000001) !== 0;
        trackId = moov.readUInt32BE(ver === 1 ? tkhd.dataOffset + 20 : tkhd.dataOffset + 12);
        const groupAt = tkhd.dataOffset + (ver === 1 ? 46 : 34);
        if (groupAt + 2 <= tkhd.end) alternateGroup = moov.readUInt16BE(groupAt);
        // width/height are 16.16 fixed point at end of tkhd
        if (tkhd.end - tkhd.dataOffset >= (ver === 1 ? 96 : 84)) {
          const w = moov.readUInt32BE(ver === 1 ? tkhd.dataOffset + 88 : tkhd.dataOffset + 76);
          const h = moov.readUInt32BE(ver === 1 ? tkhd.dataOffset + 92 : tkhd.dataOffset + 80);
          width = w / 65536;
          height = h / 65536;
        }
      }
      const resolvedLang = languageBcp47 || language;
      if (handler === "vide") {
        videoIdx += 1;
        // stsd format for codecId
        let codecId = "";
        let codecPrivateB64 = "";
        const displayWidth = width;
        const displayHeight = height;
        const minf = childOf(moov, mdia.dataOffset, mdia.end, "minf");
        const stbl = minf && childOf(moov, minf.dataOffset, minf.end, "stbl");
        const stsd = stbl && childOf(moov, stbl.dataOffset, stbl.end, "stsd");
        if (stsd) {
          const first = readBox(moov, stsd.dataOffset + 8);
          if (first) {
            codecId = first.type;
            if (first.end - first.dataOffset >= 78) {
              width = moov.readUInt16BE(first.dataOffset + 24);
              height = moov.readUInt16BE(first.dataOffset + 26);
            }
            for (const name of ["avcC", "hvcC", "av1C"]) {
              const configuration = childOf(moov, first.dataOffset + 78, first.end, name);
              if (configuration) codecPrivateB64 = moov.subarray(configuration.dataOffset, configuration.end).toString("base64");
            }
          }
        }
        const configuration = codecPrivateB64 && ["avc1", "avc3"].includes(codecId)
          ? h264Configuration(Buffer.from(codecPrivateB64, "base64"))
          : codecPrivateB64 && ["hvc1", "hev1"].includes(codecId)
            ? hevcConfiguration(Buffer.from(codecPrivateB64, "base64")) : null;
        const track = new VideoTrack({
          trackNumber: trackId,
          declaredIndex: videoIdx,
          codecId,
          language: resolvedLang,
          languageBcp47,
          name: "",
          isEnabled,
          isDefault: true,
          declaresDefault: false,
          codecPrivateB64,
          alternateGroup,
          width: configuration?.width ?? width,
          height: configuration?.height ?? height,
          displayWidth,
          displayHeight,
          fps: configuration?.fps ?? videoSampleRate(moov, mdhd, stbl),
          bitDepth: configuration?.bitDepth ?? null
        });
        if (configuration) {
          track.codecConfiguration = configuration;
          track.reorderDepth = configuration.reorderDepth;
        }
        result.push(track);
      } else if (handler === "soun") {
        audioIdx += 1;
        let codecId = "";
        let sampleEntry = null;
        const minf = childOf(moov, mdia.dataOffset, mdia.end, "minf");
        const stbl = minf && childOf(moov, minf.dataOffset, minf.end, "stbl");
        const stsd = stbl && childOf(moov, stbl.dataOffset, stbl.end, "stsd");
        if (stsd) {
          const first = readBox(moov, stsd.dataOffset + 8);
          if (first) {
            sampleEntry = readAudioSampleEntry(moov, first);
            codecId = sampleEntry?.codecId ?? first.type;
            if (codecId === "mpeg_audio" && !childOf(moov, held.header, moov.length, "mvex")) {
              const chunks = childOf(moov, stbl.dataOffset, stbl.end, "stco") ?? childOf(moov, stbl.dataOffset, stbl.end, "co64");
              const sizes = childOf(moov, stbl.dataOffset, stbl.end, "stsz");
              if (!chunks || !sizes || !moov.readUInt32BE(chunks.dataOffset + 4) || !moov.readUInt32BE(sizes.dataOffset + 8)) {
                throw new Error("MP4 MPEG audio has no addressed first sample.");
              }
              const offset = chunks.type === "co64" ? Number(moov.readBigUInt64BE(chunks.dataOffset + 8)) : moov.readUInt32BE(chunks.dataOffset + 8);
              const size = moov.readUInt32BE(sizes.dataOffset + 4) || moov.readUInt32BE(sizes.dataOffset + 12);
              if (!Number.isSafeInteger(offset) || size < 4 || offset + size > this.fileSize) throw new Error("MP4 MPEG audio sample address is invalid.");
              const facts = mpegAudioFrame(await this.readRange(offset, offset + 3));
              codecId = facts.codecId;
              sampleEntry.channels = facts.channels;
              sampleEntry.sampleRate = facts.sampleRate;
            }
          }
        }
        result.push(new AudioTrack({
          trackNumber: trackId,
          declaredIndex: audioIdx,
          codecId,
          language: resolvedLang,
          languageBcp47,
          name: "",
          isEnabled,
          isDefault: true,
          declaresDefault: false,
          // The sample entry's decoder configuration in its Matroska declaration form.
          codecPrivateB64: sampleEntry?.decoderConfig ? sampleEntry.decoderConfig.toString("base64") : "",
          alternateGroup,
          isOriginal: false,
          isCommentary: false,
          isVisualImpaired: false,
          channels: sampleEntry?.channels ?? null,
          samplingFrequency: sampleEntry?.sampleRate ?? null,
          bitDepth: sampleEntry?.bitDepth ?? null,
          codecDelaySeconds: sampleEntry?.codecDelaySeconds ?? 0,
          seekPrerollSeconds: sampleEntry?.seekPrerollSeconds ?? 0
        }));
      }
    }
    return result;
  }

  /**
   * The text field of one cue as MP4 frames it.
   *
   * A `tx3g`/`text` sample is a 16-bit big-endian length followed by that many
   * bytes of UTF-8 (ISO/IEC 14496-12 §12.6.3 and Apple's text sample format); a
   * `wvtt` sample is a sequence of boxes whose `vttc`/`payl` holds the cue text
   * (§12.6.3.2). Neither carries the subtitle format's own markup, so the
   * markup step that follows has nothing to take off — it is applied all the
   * same, because which step applies is decided by the codec and not here.
   *
   * The byte reading itself is this module's,
   * alongside the sample-table walk that found the range.
   *
   * @param {Buffer} payload - The sample's own bytes.
   * @param {string} codecId - Sample entry type: `tx3g`, `text` or `wvtt`.
   * @returns {string}
   */
  static cueTextOf(payload, codecId) {
    return decodeSubtitleSample(payload, codecId);
  }

  async parseKeyframeIndex() {
    const held = await this.#moovBuffer();
    if (held && childOf(held.moov, held.header, held.moov.length, "mvex")) {
      const video = (await this.readTracks()).find(track => track.type === "video");
      return video ? { times: (await this.readPacketIndex()).keyframesOf(video.trackNumber), tolerance: 0 } : null;
    }
    const r = held ? keyframeTimesFromMoov(held.moov, held.header) : null;
    if (!r) return null;
    if (Array.isArray(r)) return { times: r, tolerance: 0 };
    return r;
  }
}

/** Average decoded-frame cadence from the declared sample timing table. */
function videoSampleRate(bytes, mdhd, stbl) {
  if (!mdhd || !stbl) return null;
  const scaleAt = mdhd.dataOffset + (bytes[mdhd.dataOffset] === 1 ? 20 : 12);
  if (scaleAt + 4 > mdhd.end) throw new Error("MP4 video timescale is truncated.");
  const scale = bytes.readUInt32BE(scaleAt);
  const stts = childOf(bytes, stbl.dataOffset, stbl.end, "stts");
  if (!stts) return null;
  if (stts.dataOffset + 8 > stts.end) throw new Error("MP4 video timing table is truncated.");
  const count = bytes.readUInt32BE(stts.dataOffset + 4);
  if (stts.dataOffset + 8 + count * 8 !== stts.end) throw new Error("MP4 video timing count differs from its table size.");
  let samples = 0, ticks = 0;
  for (let at = stts.dataOffset + 8; at < stts.end; at += 8) {
    const n = bytes.readUInt32BE(at), duration = bytes.readUInt32BE(at + 4);
    samples += n;
    ticks += n * duration;
    if (!Number.isSafeInteger(samples) || !Number.isSafeInteger(ticks)) throw new Error("MP4 video timing exceeds its integer range.");
  }
  return scale > 0 && samples > 0 && ticks > 0 ? samples * scale / ticks : null;
}

function fragmentTracks({ moov, header }, tracks) {
  const movie = childOf(moov, header, moov.length, "mvhd");
  const movieScale = movie && moov.readUInt32BE(movie.dataOffset + (moov[movie.dataOffset] === 1 ? 20 : 12));
  const mvex = childOf(moov, header, moov.length, "mvex");
  const defaults = new Map(childrenOf(moov, mvex.dataOffset, mvex.end, "trex").map(trex => {
    if (trex.dataOffset + 24 !== trex.end) throw new Error("MP4 fragment defaults are incomplete.");
    const at = trex.dataOffset;
    return [moov.readUInt32BE(at + 4), { description: moov.readUInt32BE(at + 8),
      duration: moov.readUInt32BE(at + 12), size: moov.readUInt32BE(at + 16), flags: moov.readUInt32BE(at + 20) }];
  }));
  return childrenOf(moov, header, moov.length, "trak").map(trak => {
    const tkhd = childOf(moov, trak.dataOffset, trak.end, "tkhd");
    const mdia = childOf(moov, trak.dataOffset, trak.end, "mdia");
    if (!tkhd || !mdia) throw new Error("MP4 fragment track declaration is absent.");
    const id = moov.readUInt32BE(tkhd.dataOffset + (moov[tkhd.dataOffset] === 1 ? 20 : 12));
    const track = tracks.find(track => track.trackNumber === id);
    const mdhd = childOf(moov, mdia.dataOffset, mdia.end, "mdhd");
    const scale = mdhd && moov.readUInt32BE(mdhd.dataOffset + (moov[mdhd.dataOffset] === 1 ? 20 : 12));
    if (!track || !scale || !defaults.has(id)) throw new Error("MP4 fragment track settings are incomplete.");
    let shift = 0;
    const edts = childOf(moov, trak.dataOffset, trak.end, "edts");
    const elst = edts && childOf(moov, edts.dataOffset, edts.end, "elst");
    if (elst) {
      const wide = moov[elst.dataOffset] === 1, count = moov.readUInt32BE(elst.dataOffset + 4);
      const width = wide ? 20 : 12;
      if (moov[elst.dataOffset] > 1 || elst.dataOffset + 8 + count * width !== elst.end) throw new Error("MP4 fragment edits are incomplete.");
      let mediaEdit = false;
      for (let entry = 0, at = elst.dataOffset + 8; entry < count; entry++, at += width) {
        const duration = wide ? Number(moov.readBigUInt64BE(at)) : moov.readUInt32BE(at);
        const time = wide ? Number(moov.readBigInt64BE(at + 8)) : moov.readInt32BE(at + 4);
        const rate = at + (wide ? 16 : 8);
        if (!Number.isSafeInteger(duration) || !Number.isSafeInteger(time) ||
            moov.readInt16BE(rate) !== 1 || moov.readInt16BE(rate + 2) !== 0 || mediaEdit) throw new Error("MP4 fragment edits require a different presentation mapping.");
        if (time === -1 && movieScale) shift += duration / movieScale;
        else if (time >= 0) { shift -= time / scale; mediaEdit = true; }
        else throw new Error("MP4 fragment edit has no valid presentation time.");
      }
    }
    return { id, track, scale, shift, ...defaults.get(id) };
  });
}

// ---------------------------------------------------------------------------
// The MP4's own reading of its subtitle sample table. Here because every rule
// in it is ISO/IEC 14496-12 speaking about this container, and the class is
// the only way in.
// ---------------------------------------------------------------------------
/**
 * @file The text subtitle tracks of an MP4, and where each cue's bytes are.
 *
 * The same rule as the Matroska side: nothing is extracted with ffmpeg and
 * nothing is fetched for its own sake. Here it is cheaper still. Matroska hides
 * its subtitle blocks inside clusters shared with the picture, so a cue costs
 * whatever cluster holds it; an MP4 states every sample's offset and length in
 * the sample table, so a cue costs its own bytes and nothing more — usually a
 * few dozen of them.
 *
 * The tables, from ISO/IEC 14496-12:
 *
 *   stsd — what the samples are (`tx3g` timed text, `wvtt` WebVTT, `stpp` TTML)
 *   stts — how long each sample lasts, run-length encoded (§8.6.1.2)
 *   stsz — how long each sample is, in bytes (§8.7.3)
 *   stsc — how samples are grouped into chunks (§8.7.4)
 *   stco / co64 — where each chunk begins in the file (§8.7.5)
 *
 * Together they give, for sample N: when it starts, how long it stays, and the
 * exact byte range holding it. That is everything needed to show a cue without
 * reading anything else.
 */

const PROBE_BYTES = 64;
const MAX_MOOV_BYTES = 32 * 1024 * 1024;

/** Handlers that mean "this track is text on screen". */
const TEXT_HANDLERS = new Set(["text", "sbtl", "subt"]);
/**
 * Every handler ffmpeg's mov demuxer turns into a SUBTITLE stream, whether or
 * not this file can read it — `subp` is a DVD subpicture and `clcp` closed
 * captions, both pictures or caption data rather than text. They are counted
 * because `declaredIndex` has to equal ffmpeg's `0:s:N`, and a track left out
 * of the count shifts every text track after it, which is the very defect
 * `declaredIndex` exists to remove.
 */
const SUBTITLE_HANDLERS = new Set([...TEXT_HANDLERS, "subp", "clcp"]);
/** Sample formats this can turn into cues. `stpp` (TTML) is XML and is not one. */
const TEXT_FORMATS = new Set(["tx3g", "text", "wvtt"]);





/**
 * Sample durations, expanded from the run-length table.
 *
 * @param {Buffer} moov
 * @param {{ dataOffset: number, end: number }} stts
 * @param {number} total - How many samples the size table declares.
 * @returns {number[]} Ticks each sample lasts.
 */
function packetIndexFromMoov({ moov, header, offset: moovOffset }, fileSize, declaredTracks, packetMemory) {
  const index = new PacketIndex({ packetMemory });
  try {
  const movie = childOf(moov, header, moov.length, "mvhd");
  const movieScaleAt = movie ? movie.dataOffset + (moov[movie.dataOffset] === 1 ? 20 : 12) : 0;
  const movieScale = movie ? moov.readUInt32BE(movieScaleAt) : 0;
  for (const trak of childrenOf(moov, header, moov.length, "trak")) {
    const tkhd = childOf(moov, trak.dataOffset, trak.end, "tkhd");
    const mdia = childOf(moov, trak.dataOffset, trak.end, "mdia");
    if (!tkhd || !mdia) throw new Error("MP4 track address is absent.");
    const id = moov.readUInt32BE(tkhd.dataOffset + (moov[tkhd.dataOffset] === 1 ? 20 : 12));
    const track = declaredTracks.find(one => one.trackNumber === id);
    if (!track || (!["video", "audio"].includes(track.type) &&
      !(track.type === "subtitle" && track.isTextBased()))) continue;
    const mdhd = childOf(moov, mdia.dataOffset, mdia.end, "mdhd");
    const scale = mdhd && moov.readUInt32BE(mdhd.dataOffset + (moov[mdhd.dataOffset] === 1 ? 20 : 12));
    if (!(scale > 0)) throw new Error("MP4 media timescale is invalid.");
    const minf = childOf(moov, mdia.dataOffset, mdia.end, "minf");
    const stbl = minf && childOf(moov, minf.dataOffset, minf.end, "stbl");
    if (!stbl) throw new Error("MP4 track sample table is absent.");
    const table = name => childOf(moov, stbl.dataOffset, stbl.end, name);
    const stsz = table("stsz"), stts = table("stts"), stsc = table("stsc"), stsd = table("stsd");
    const chunks = table("stco") ?? table("co64");
    if (!stsz || !stts || !stsc || !stsd || !chunks) throw new Error("MP4 track sample tables are incomplete.");
    const count = moov.readUInt32BE(stsz.dataOffset + 8);
    const uniform = moov.readUInt32BE(stsz.dataOffset + 4);
    if ((!uniform && stsz.dataOffset + 12 + count * 4 > stsz.end) ||
      (uniform && count * uniform > fileSize)) throw new Error("MP4 sample sizes exceed the file.");
    const sizeAt = sample => uniform || moov.readUInt32BE(stsz.dataOffset + 12 + sample * 4);
    const validateRuns = (box, width) => {
      const entries = moov.readUInt32BE(box.dataOffset + 4);
      if (box.dataOffset + 8 + entries * width > box.end) throw new Error("MP4 sample table is truncated.");
      return entries;
    };
    const timeEntries = validateRuns(stts, 8);
    let timedSamples = 0;
    for (let entry = 0; entry < timeEntries; entry++) {
      timedSamples += moov.readUInt32BE(stts.dataOffset + 8 + entry * 8);
    }
    if (timedSamples !== count) throw new Error("MP4 sample timing count differs from its size count.");
    const nextDuration = sampleRunReader(moov, stts);
    const ctts = table("ctts");
    if (ctts) {
      const entries = validateRuns(ctts, 8);
      let sample = 0;
      if (moov[ctts.dataOffset] > 1) throw new Error("MP4 composition table version is invalid.");
      for (let entry = 0; entry < entries; entry++) {
        const at = ctts.dataOffset + 8 + entry * 8;
        const run = moov.readUInt32BE(at);
        if (sample + run > count) throw new Error("MP4 composition count exceeds its size count.");
        sample += run;
      }
      if (sample !== count) throw new Error("MP4 composition count differs from its size count.");
    }
    const nextComposition = ctts ? sampleRunReader(moov, ctts, moov[ctts.dataOffset] === 1) : () => 0;
    const chunkWidth = chunks.type === "co64" ? 8 : 4;
    const chunkCount = validateRuns(chunks, chunkWidth);
    const chunkRuns = validateRuns(stsc, 12);
    let declaredCount = 0;
    let previousChunk = 0;
    for (let run = 0; run < chunkRuns; run++) {
      const at = stsc.dataOffset + 8 + run * 12;
      const first = moov.readUInt32BE(at), perChunk = moov.readUInt32BE(at + 4);
      const next = run + 1 < chunkRuns ? moov.readUInt32BE(at + 12) : chunkCount + 1;
      if (first <= previousChunk || (run === 0 && first !== 1) || next <= first || next > chunkCount + 1 || !perChunk) {
        throw new Error("MP4 sample-to-chunk run is invalid.");
      }
      declaredCount += (next - first) * perChunk;
      previousChunk = first;
    }
    if (declaredCount !== count) throw new Error("MP4 chunk sample count differs from its size count.");
    const nextAddress = sampleAddressReader(moov, stsc, chunks, chunkWidth, chunkRuns);
    const stss = table("stss");
    let syncEntries = 0;
    if (stss) {
      syncEntries = validateRuns(stss, 4);
      let previous = 0;
      for (let entry = 0; entry < syncEntries; entry++) {
        const sample = moov.readUInt32BE(stss.dataOffset + 8 + entry * 4);
        if (sample <= previous || sample > count) throw new Error("MP4 sync sample is outside the sample table or unordered.");
        previous = sample;
      }
    }
    let emptyShiftSeconds = 0;
    let mediaShiftTicks = 0;
    const edts = childOf(moov, trak.dataOffset, trak.end, "edts");
    const edits = edts && childOf(moov, edts.dataOffset, edts.end, "elst");
    if (edits) {
      const version = moov[edits.dataOffset], wide = version === 1;
      if (version > 1) throw new Error("MP4 edit list version is invalid.");
      const entries = validateRuns(edits, wide ? 20 : 12);
      let emptySeconds = 0, mediaEdit = false;
      for (let entry = 0; entry < entries; entry++) {
        const at = edits.dataOffset + 8 + entry * (wide ? 20 : 12);
        const duration = wide ? Number(moov.readBigUInt64BE(at)) : moov.readUInt32BE(at);
        const mediaTime = wide ? Number(moov.readBigInt64BE(at + 8)) : moov.readInt32BE(at + 4);
        const rateAt = at + (wide ? 16 : 8);
        if (moov.readInt16BE(rateAt) !== 1 || moov.readInt16BE(rateAt + 2) !== 0) throw new Error("MP4 non-unit edit rate requires a presentation mapping.");
        if (mediaTime === -1 && !mediaEdit && movieScale > 0) emptySeconds += duration / movieScale;
        else if (mediaTime >= 0 && !mediaEdit) { emptyShiftSeconds = emptySeconds; mediaShiftTicks = mediaTime; mediaEdit = true; }
        else throw new Error("MP4 repeated edits require a presentation mapping.");
      }
    }
    const audioPreroll = track.seekPrerollSeconds || (track.codecId === "Opus" ? 0.08 : 0);
    index.declareTrack(id, { type: track.type, codecId: track.codecId,
      codecRanges: track.type === "subtitle" ? [] : [[moovOffset + stsd.dataOffset, moovOffset + stsd.end - 1]],
      prerollSeconds: audioPreroll, reorderDepth: track.reorderDepth ?? 0 });
    index.reservePackets(id, count);
    let decodeTicks = 0, syncAt = 0;
    for (let sample = 0; sample < count; sample++) {
      const duration = nextDuration();
      const pts = (decodeTicks + nextComposition() - mediaShiftTicks) / scale + emptyShiftSeconds;
      const dts = (decodeTicks - mediaShiftTicks) / scale + emptyShiftSeconds;
      decodeTicks += duration;
      const size = sizeAt(sample), start = nextAddress(size);
      const keyframe = !stss || (syncAt < syncEntries && moov.readUInt32BE(stss.dataOffset + 8 + syncAt * 4) === sample + 1);
      if (stss && keyframe) syncAt++;
      if (size === 0) continue;
      if (!Number.isSafeInteger(start) || start < 0 || start + size > fileSize) throw new Error("MP4 sample address exceeds the file.");
      const discardPaddingSeconds = track.type === "audio" && !(track.codecDelaySeconds > 0)
        ? -Math.min(duration / scale, Math.max(0, emptyShiftSeconds - pts)) : 0;
      index.append(id, { pts, dts, duration: duration / scale, keyframe, ranges: [[start, start + size - 1]],
        ...(discardPaddingSeconds ? { discardPaddingSeconds } : {}) });
    }
    index.complete(id);
  }
  return index;
  } catch (error) {
    index.dispose();
    throw error;
  }
}

/** Read compressed timing runs without expanding a whole-track array. */
function sampleRunReader(bytes, table, signed = false) {
  let at = table.dataOffset + 8, remaining = 0, value = 0;
  return () => {
    while (!remaining) {
      if (at + 8 > table.end) throw new Error("MP4 sample timing run ended early.");
      remaining = bytes.readUInt32BE(at);
      value = signed ? bytes.readInt32BE(at + 4) : bytes.readUInt32BE(at + 4);
      at += 8;
    }
    remaining--;
    return value;
  };
}

/** Sample addresses follow chunk runs directly from the retained tables. */
function sampleAddressReader(bytes, stsc, chunks, width, runs) {
  let chunk = 1, run = 0, remaining = 0, address = 0;
  return size => {
    if (!remaining) {
      while (run + 1 < runs && bytes.readUInt32BE(stsc.dataOffset + 8 + (run + 1) * 12) <= chunk) run++;
      remaining = bytes.readUInt32BE(stsc.dataOffset + 12 + run * 12);
      const at = chunks.dataOffset + 8 + (chunk - 1) * width;
      address = width === 8 ? Number(bytes.readBigUInt64BE(at)) : bytes.readUInt32BE(at);
      chunk++;
    }
    const start = address;
    address += size;
    remaining--;
    return start;
  };
}

/**
 * @typedef {object} Mp4SubtitleSample
 * @property {number} startSeconds
 * @property {number} endSeconds
 * @property {number} offset - Where the sample's bytes are in the file.
 * @property {number} size
 */

/**
 * @typedef {object} Mp4SubtitleTrack
 * @property {number} trackId
 * @property {number} declaredIndex - Its position among ALL of the file's
 *   subtitle tracks, including the ones whose sample format this cannot turn
 *   into cues (`stpp` TTML). That is the number ffmpeg gives the same stream in
 *   `0:s:N`, which is the number the browser names; counting only the readable
 *   ones would shift every track after a TTML one.
 * @property {string} format - `tx3g`, `text` or `wvtt`.
 * @property {string} language - Three letters, as the file declares them.
 * @property {boolean} someSamplesForced - The sample entry says at least one
 *   cue carries a forced (`frcd`) atom.
 * @property {boolean} allSamplesForced - The sample entry says every cue is to
 *   be treated as forced, whether or not it carries that atom.
 * @property {Mp4SubtitleSample[]} samples - In time order.
 */

/**
 * The text subtitle tracks of an MP4, with every cue's time and byte range.
 *
 * @param {Buffer} moov - The whole `moov` box, its header included.
 * @returns {{ tracks: Mp4SubtitleTrack[] } | null}
 */
function subtitleSampleView(bytes, { stsz, stts, stsc, chunks, timescale }) {
  const count = bytes.readUInt32BE(stsz.dataOffset + 8), uniform = bytes.readUInt32BE(stsz.dataOffset + 4);
  const sizeAt = sample => uniform || bytes.readUInt32BE(stsz.dataOffset + 12 + sample * 4);
  if (!uniform && stsz.dataOffset + 12 + count * 4 > stsz.end) throw new Error("MP4 subtitle sample sizes are truncated.");
  const entries = (table, width) => {
    const value = bytes.readUInt32BE(table.dataOffset + 4);
    if (table.dataOffset + 8 + value * width > table.end) throw new Error("MP4 subtitle sample table is truncated.");
    return value;
  };
  const timeEntries = entries(stts, 8), runs = entries(stsc, 12), width = chunks.type === "co64" ? 8 : 4;
  const chunkCount = entries(chunks, width);
  let timed = 0, addressed = 0, previous = 0;
  for (let entry = 0; entry < timeEntries; entry++) timed += bytes.readUInt32BE(stts.dataOffset + 8 + entry * 8);
  for (let run = 0; run < runs; run++) {
    const at = stsc.dataOffset + 8 + run * 12;
    const first = bytes.readUInt32BE(at), perChunk = bytes.readUInt32BE(at + 4);
    const next = run + 1 < runs ? bytes.readUInt32BE(at + 12) : chunkCount + 1;
    if (first <= previous || (run === 0 && first !== 1) || next <= first || next > chunkCount + 1 || !perChunk) throw new Error("MP4 subtitle chunk run is invalid.");
    addressed += (next - first) * perChunk;
    previous = first;
  }
  if (timed !== count || addressed !== count) throw new Error("MP4 subtitle sample tables disagree on their count.");
  let length = uniform ? uniform > 2 ? count : 0 : 0;
  if (!uniform) for (let sample = 0; sample < count; sample++) if (sizeAt(sample) > 2) length++;
  const view = {
    length,
    *[Symbol.iterator]() {
      if (!length) return;
      const nextDuration = sampleRunReader(bytes, stts);
      const nextAddress = sampleAddressReader(bytes, stsc, chunks, width, runs);
      let ticks = 0;
      for (let sample = 0; sample < count; sample++) {
        const startSeconds = ticks / timescale;
        ticks += nextDuration();
        const size = sizeAt(sample), offset = nextAddress(size);
        if (size > 2) yield { startSeconds, endSeconds: ticks / timescale, offset, size };
      }
    },
    map(callback) { return Array.from(this, callback); },
    at(index) {
      if (index < 0) index += length;
      if (!Number.isSafeInteger(index) || index < 0 || index >= length) return undefined;
      let current = 0;
      for (const sample of this) if (current++ === index) return sample;
    }
  };
  return new Proxy(view, { get(target, property, receiver) {
    return typeof property === "string" && /^(0|[1-9]\d*)$/.test(property) ? target.at(Number(property)) : Reflect.get(target, property, receiver);
  } });
}

function subtitlePlanFromMoov(moov) {
  if (!moov || moov.length < HEADER_BYTES) {
    return null;
  }
  const moovBox = readBox(moov, 0);
  if (!moovBox) {
    return null;
  }

  /** @type {Mp4SubtitleTrack[]} */
  const tracks = [];
  // Counts every subtitle track the file has, whether or not this can read it,
  // so the number handed out matches ffmpeg's `0:s:N`. See `declaredIndex`.
  let declaredIndex = -1;
  for (const trak of childrenOf(moov, moovBox.dataOffset, moov.length, "trak")) {
    const mdia = childOf(moov, trak.dataOffset, trak.end, "mdia");
    if (!mdia) {
      continue;
    }
    const hdlr = childOf(moov, mdia.dataOffset, mdia.end, "hdlr");
    const handler = hdlr ? moov.toString("latin1", hdlr.dataOffset + 8, hdlr.dataOffset + 12) : "";
    if (!SUBTITLE_HANDLERS.has(handler)) {
      continue;
    }
    // Counted before the readability checks below, and before the handler is
    // narrowed to the text ones: this number is the track's place in the file,
    // not its place among the tracks this code can turn into cues.
    declaredIndex += 1;
    if (!TEXT_HANDLERS.has(handler)) {
      continue;
    }
    const mdhd = childOf(moov, mdia.dataOffset, mdia.end, "mdhd");
    if (!mdhd) {
      continue;
    }
    const version = moov[mdhd.dataOffset];
    const timescale = moov.readUInt32BE(version === 1 ? mdhd.dataOffset + 20 : mdhd.dataOffset + 12);
    if (!timescale) {
      continue;
    }
    // The language is five bits per letter, offset from 0x60, packed into two
    // bytes after the times (ISO/IEC 14496-12 §8.4.2.3).
    const languageAt = version === 1 ? mdhd.dataOffset + 32 : mdhd.dataOffset + 20;
    let language = "";
    if (languageAt + 2 <= mdhd.end) {
      const packed = moov.readUInt16BE(languageAt);
      language = [10, 5, 0]
        .map((shift) => String.fromCharCode(((packed >> shift) & 0x1f) + 0x60))
        .join("")
        .replace(/[^a-z]/g, "");
    }

    const tkhd = childOf(moov, trak.dataOffset, trak.end, "tkhd");
    const trackId = tkhd
      ? moov.readUInt32BE(moov[tkhd.dataOffset] === 1 ? tkhd.dataOffset + 20 : tkhd.dataOffset + 12)
      : tracks.length + 1;

    const minf = childOf(moov, mdia.dataOffset, mdia.end, "minf");
    const stbl = minf && childOf(moov, minf.dataOffset, minf.end, "stbl");
    if (!stbl) {
      continue;
    }
    const stsd = childOf(moov, stbl.dataOffset, stbl.end, "stsd");
    const first = stsd && readBox(moov, stsd.dataOffset + 8);
    const format = first ? first.type : "";
    if (!TEXT_FORMATS.has(format)) {
      continue;
    }
    // Whether the file itself says this track is forced — subtitles shown even
    // to a viewer who did not ask for subtitles, because the dialogue on screen
    // is in a language the soundtrack is not.
    //
    // Apple's QuickTime File Format, "Display flags" under Subtitle sample
    // description, defines the two bits read here: `0x40000000` "Some samples
    // are forced" ("at least one sample contains a forced (`frcd`) atom") and
    // `0x80000000` "All samples are forced" ("the subtitle media handler treats
    // all samples as forced subtitles, regardless of the presence or absence of
    // a `frcd` atom"), with the note that setting the second requires the first
    // — the pair together being `0xC0000000`. We honour that requirement rather
    // than trusting a writer to have met it: either bit alone is enough to call
    // the track forced, because a file that sets only `0x80000000` is saying
    // exactly what a well-formed one would say twice.
    //
    // The field sits at a fixed place in the sample entry. `dataOffset` is
    // already past the box header, and every sample entry opens with 6 reserved
    // bytes and a 2-byte data reference index (ISO/IEC 14496-12 §8.5.2.2), so
    // `displayFlags` is the 32 bits eight bytes in.
    let someSamplesForced = false;
    let allSamplesForced = false;
    if (format === "tx3g" && first && first.dataOffset + 8 + 4 <= first.end) {
      const displayFlags = moov.readUInt32BE(first.dataOffset + 8);
      someSamplesForced = (displayFlags & 0x40000000) !== 0;
      allSamplesForced = (displayFlags & 0x80000000) !== 0;
    }
    const stts = childOf(moov, stbl.dataOffset, stbl.end, "stts");
    const stsz = childOf(moov, stbl.dataOffset, stbl.end, "stsz");
    const stsc = childOf(moov, stbl.dataOffset, stbl.end, "stsc");
    const stco = childOf(moov, stbl.dataOffset, stbl.end, "stco");
    const co64 = childOf(moov, stbl.dataOffset, stbl.end, "co64");
    if (!stts || !stsz || !stsc || (!stco && !co64)) {
      continue;
    }

    const samples = subtitleSampleView(moov, { stsz, stts, stsc, chunks: stco ?? co64, timescale });
    tracks.push({
      trackId,
      declaredIndex,
      format,
      language,
      someSamplesForced,
      allSamplesForced,
      samples
    });
  }
  return { tracks };
}

/**
 * The text of one sample.
 *
 * `tx3g` is a two-byte length followed by UTF-8; anything after that is styling
 * boxes, which this deliberately drops. `wvtt` is a sequence of boxes, and the
 * text lives in the `payl` inside a `vttc`.
 *
 * @param {Buffer} bytes
 * @param {string} format
 * @returns {string}
 */
function decodeSubtitleSample(bytes, format) {
  if (format === "wvtt") {
    let at = 0;
    const parts = [];
    while (at + HEADER_BYTES <= bytes.length) {
      const box = readBox(bytes, at);
      if (!box) {
        break;
      }
      if (box.type === "vttc") {
        const payl = childOf(bytes, box.dataOffset, Math.min(bytes.length, box.end), "payl");
        if (payl) {
          parts.push(bytes.toString("utf8", payl.dataOffset, Math.min(bytes.length, payl.end)));
        }
      }
      at = box.end;
    }
    return parts.join("\n").trim();
  }
  if (bytes.length < 2) {
    return "";
  }
  const length = bytes.readUInt16BE(0);
  return bytes.toString("utf8", 2, Math.min(bytes.length, 2 + length)).trim();
}

// ---------------------------------------------------------------------------
// ISO/IEC 14496-12 speaking about MP4: stss, stts, ctts and the edit list.
// Here because the class is the only way in.
// ---------------------------------------------------------------------------
/**
 * @file Keyframe index for MP4/MOV, read without downloading the file.
 *
 * MP4 keeps its tables in a `moov` box: `stss` lists which samples are sync
 * samples (keyframes) by number, and `stts` gives each sample's duration, so
 * the two together turn "sample #N" into "second T". `moov` sits either at the
 * start (files written for streaming) or at the end (the common case for a
 * plain mux); box headers state their own size, so it is found by stepping over
 * top-level boxes rather than scanning bytes — a couple of 64-byte reads even
 * when `mdat` is gigabytes.
 *
 * Same purpose as the Matroska reader: on the video-COPY path the segment
 * boundaries ARE the source's keyframes, and inventing an even grid instead
 * makes players walk the whole file or present audio with no picture.
 */

// A 64-bit box size is signalled by a 32-bit size of 1, the real size following
// in the next 8 bytes.
// Enough to read any box header while walking the top level.
// Cap on the moov read. A feature-length file indexes to a few hundred KB;
// beyond this is not a normal index and not worth pulling over a torrent.

/**
 * Whether this looks like MP4/MOV — every real file opens with an `ftyp` box.
 *
 * @param {Buffer} head
 * @returns {boolean}
 */
function isMp4(head) {
  return head.length >= 12 && head.toString("latin1", 4, 8) === "ftyp";
}

/**
 * Read a box header at `offset`.
 *
 * @param {Buffer} buffer
 * @param {number} offset
 * @returns {{ type: string, size: number, headerBytes: number } | null}
 */
function readBoxHeader(buffer, offset) {
  if (offset + HEADER_BYTES > buffer.length) {
    return null;
  }
  const size32 = buffer.readUInt32BE(offset);
  const type = buffer.toString("latin1", offset + 4, offset + 8);
  if (size32 === LARGE_SIZE_MARKER) {
    if (offset + LARGE_HEADER_BYTES > buffer.length) {
      return null;
    }
    // High word is zero for any file we can practically handle.
    const high = buffer.readUInt32BE(offset + 8);
    const low = buffer.readUInt32BE(offset + 12);
    return { type, size: high * 4294967296 + low, headerBytes: LARGE_HEADER_BYTES };
  }
  return { type, size: size32, headerBytes: HEADER_BYTES };
}

/**
 * Walk the top-level boxes to find `moov`, reading only each box header.
 *
 * @param {(start: number, end: number) => Promise<Buffer | null>} readRange
 * @param {number} fileSize
 * @returns {Promise<{ offset: number, size: number, headerBytes: number } | null>}
 */
async function findMoov(readRange, fileSize) {
  let offset = 0;
  while (offset < fileSize) {
    const probe = await readRange(offset, Math.min(fileSize - 1, offset + PROBE_BYTES - 1));
    if (!probe || probe.length < HEADER_BYTES) {
      return null;
    }
    const header = readBoxHeader(probe, 0);
    // Size 0 means "extends to end of file" — legal only for the last box, and
    // never for one we would step over.
    if (!header || header.size <= 0) {
      return null;
    }
    if (header.type === "moov") {
      return { offset, size: header.size, headerBytes: header.headerBytes };
    }
    offset += header.size;
  }
  return null;
}

/**
 * Find the first box of `type` directly inside a range of an already-read buffer.
 *
 * @param {Buffer} buffer
 * @param {number} start
 * @param {number} end
 * @param {string} type
 * @returns {{ dataOffset: number, end: number } | null}
 */
function findBox(buffer, start, end, type) {
  let offset = start;
  while (offset + HEADER_BYTES <= end) {
    const header = readBoxHeader(buffer, offset);
    if (!header || header.size <= 0) {
      return null;
    }
    if (header.type === type) {
      return { dataOffset: offset + header.headerBytes, end: Math.min(end, offset + header.size) };
    }
    offset += header.size;
  }
  return null;
}

/**
 * All boxes of `type` directly inside a range.
 *
 * @param {Buffer} buffer
 * @param {number} start
 * @param {number} end
 * @param {string} type
 * @returns {{ dataOffset: number, end: number }[]}
 */
function findAllBoxes(buffer, start, end, type) {
  const found = [];
  let offset = start;
  while (offset + HEADER_BYTES <= end) {
    const header = readBoxHeader(buffer, offset);
    if (!header || header.size <= 0) {
      break;
    }
    if (header.type === type) {
      found.push({ dataOffset: offset + header.headerBytes, end: Math.min(end, offset + header.size) });
    }
    offset += header.size;
  }
  return found;
}

/**
 * Turn sample numbers into seconds using the time-to-sample table.
 *
 * `stts` is run-length encoded — pairs of (sample count, per-sample duration) —
 * so one walk yields every sample's start time without expanding the table.
 *
 * @param {Buffer} buffer
 * @param {{ dataOffset: number, end: number }} stts
 * @param {number} timescale - Ticks per second.
 * @param {Set<number>} wanted - Sample numbers (1-based).
 * @returns {number[]} Seconds, ascending.
 */
function resolveSampleTimes(buffer, stts, timescale, wanted, offsets = null, editShift = 0) {
  const entryCount = buffer.readUInt32BE(stts.dataOffset + 4);
  const times = [];
  let sampleNumber = 1;
  let ticks = 0;
  let cursor = stts.dataOffset + 8;
  for (let entry = 0; entry < entryCount && cursor + 8 <= stts.end; entry += 1) {
    const count = buffer.readUInt32BE(cursor);
    const delta = buffer.readUInt32BE(cursor + 4);
    for (let index = 0; index < count; index += 1) {
      if (wanted.has(sampleNumber)) {
        // `CT(n) = DT(n) + CTTS(n)` — ISO/IEC 14496-12 §8.6.1.3. The offset is
        // what turns decode order into the order frames are shown in, and it is
        // the timeline ffmpeg cuts on.
        times.push((ticks + (offsets?.get(sampleNumber) ?? 0) - editShift) / timescale);
      }
      ticks += delta;
      sampleNumber += 1;
    }
    cursor += 8;
  }
  return times;
}

/**
 * Composition offsets for the sample numbers asked for.
 *
 * `ctts` is run-length encoded like `stts`, and version 1 carries SIGNED
 * offsets — which is what the version exists for: a frame may be shown before
 * it is decoded. Reading them as unsigned turns a small negative offset into
 * roughly four billion ticks.
 *
 * @param {Buffer} buffer
 * @param {{ dataOffset: number, end: number }} ctts
 * @param {Set<number>} wanted - Sample numbers (1-based).
 * @returns {Map<number, number>} Sample number to offset in media ticks.
 */
function readCompositionOffsets(buffer, ctts, wanted) {
  const version = buffer[ctts.dataOffset];
  const entryCount = buffer.readUInt32BE(ctts.dataOffset + 4);
  const offsets = new Map();
  let sampleNumber = 1;
  let cursor = ctts.dataOffset + 8;
  for (let entry = 0; entry < entryCount && cursor + 8 <= ctts.end; entry += 1) {
    const count = buffer.readUInt32BE(cursor);
    const offset = version === 1 ? buffer.readInt32BE(cursor + 4) : buffer.readUInt32BE(cursor + 4);
    for (let index = 0; index < count; index += 1) {
      if (wanted.has(sampleNumber)) {
        offsets.set(sampleNumber, offset);
      }
      sampleNumber += 1;
    }
    cursor += 8;
  }
  return offsets;
}

/**
 * How far the edit list shifts this track's composition timeline, in media
 * ticks.
 *
 * ISO/IEC 14496-12 §8.6.6.3: `media_time` is the start of the edit within the
 * media, in the MEDIA timescale and in composition time, while
 * `segment_duration` is in the MOVIE timescale — two different units in one
 * structure, which is why only the first is read here. `media_time = -1` is an
 * empty edit: it inserts blank presentation time and starts no media, so the
 * first real edit is the one that matters.
 *
 * Measured 2026-08-19: every LostFilm MP4 that carries a composition offset
 * also carries an edit list cancelling it exactly, which is why decode times
 * have been right on those files. `Firefly.S01E03` has the offset and NO edit
 * list, and its times were 62.1 ms early on all 34 keyframes checked.
 *
 * @param {Buffer} buffer
 * @param {{ dataOffset: number, end: number }} elst
 * @returns {number} Ticks to subtract; zero when nothing is shifted.
 */
function readEditShift(buffer, elst) {
  const version = buffer[elst.dataOffset];
  const entryCount = buffer.readUInt32BE(elst.dataOffset + 4);
  const wide = version === 1;
  const entryBytes = wide ? 20 : 12;
  let cursor = elst.dataOffset + 8;
  for (let entry = 0; entry < entryCount && cursor + entryBytes <= elst.end; entry += 1) {
    const mediaTime = wide
      ? Number(buffer.readBigInt64BE(cursor + 8))
      : buffer.readInt32BE(cursor + 4);
    if (mediaTime >= 0) {
      return mediaTime;
    }
    cursor += entryBytes;
  }
  return 0;
}

/**
 * Whether this track's handler says it carries video.
 *
 * The standard identifies a track by its `hdlr`, and nothing else does. Picking
 * "the first track that happens to carry sync samples" worked only because the
 * seven releases measured all put video first; a file whose audio track carries
 * them, or one that leads with a cover-art video track, would be read from the
 * wrong place. That is the same defect that was fixed in the Matroska reader on
 * 2026-08-18, arrived at from the other side.
 *
 * @param {Buffer} buffer
 * @param {{ dataOffset: number, end: number }} mdia
 * @returns {boolean}
 */
function isVideoTrack(buffer, mdia) {
  const hdlr = findBox(buffer, mdia.dataOffset, mdia.end, "hdlr");
  if (!hdlr || hdlr.dataOffset + 12 > hdlr.end) {
    return false;
  }
  // FullBox header (4) then a reserved pre_defined (4), then the handler type.
  return buffer.toString("latin1", hdlr.dataOffset + 8, hdlr.dataOffset + 12) === "vide";
}

/**
 * Read the keyframe times of an MP4/MOV file from its `moov` box.
 *
 * @param {Buffer} moov - The whole `moov` box, its header included.
 * @param {number} headerBytes - The box header's length.
 * @returns {number[] | null} Ascending seconds, or null when the file
 *   carries no usable index (fragmented MP4, truncated or damaged `moov`).
 */
function keyframeTimesFromMoov(moov, headerBytes) {
  const moovBox = { headerBytes };
  if (!moov || moov.length < moovBox.headerBytes) {
    return null;
  }

  // Examine every track, and take the one whose HANDLER says it is video. A
  // track with no `stss` has every sample a keyframe, so it constrains nothing
  // and is skipped even when it is the video one.
  for (const trak of findAllBoxes(moov, moovBox.headerBytes, moov.length, "trak")) {
    const mdia = findBox(moov, trak.dataOffset, trak.end, "mdia");
    if (!mdia || !isVideoTrack(moov, mdia)) {
      continue;
    }
    const mdhd = findBox(moov, mdia.dataOffset, mdia.end, "mdhd");
    if (!mdhd) {
      continue;
    }
    // mdhd layout: version(1) + flags(3), then creation/modification times —
    // 32-bit each in version 0, 64-bit in version 1 — then the timescale.
    const version = moov[mdhd.dataOffset];
    const timescaleOffset = version === 1 ? mdhd.dataOffset + 20 : mdhd.dataOffset + 12;
    if (timescaleOffset + 4 > mdhd.end) {
      continue;
    }
    const timescale = moov.readUInt32BE(timescaleOffset);
    if (!timescale) {
      continue;
    }

    const minf = findBox(moov, mdia.dataOffset, mdia.end, "minf");
    const stbl = minf && findBox(moov, minf.dataOffset, minf.end, "stbl");
    if (!stbl) {
      continue;
    }
    const stss = findBox(moov, stbl.dataOffset, stbl.end, "stss");
    const stts = findBox(moov, stbl.dataOffset, stbl.end, "stts");
    if (!stss || !stts) {
      continue;
    }

    const syncCount = moov.readUInt32BE(stss.dataOffset + 4);
    const wanted = new Set();
    for (let index = 0; index < syncCount; index += 1) {
      const at = stss.dataOffset + 8 + index * 4;
      if (at + 4 > stss.end) {
        break;
      }
      wanted.add(moov.readUInt32BE(at));
    }
    if (wanted.size === 0) {
      continue;
    }

    // The two terms that turn decode times into the timeline ffmpeg cuts on.
    // Both are optional: a file without them is one whose decode and
    // composition orders already agree, and then nothing is added or taken.
    const ctts = findBox(moov, stbl.dataOffset, stbl.end, "ctts");
    const offsets = ctts ? readCompositionOffsets(moov, ctts, wanted) : null;
    const edts = findBox(moov, trak.dataOffset, trak.end, "edts");
    const elst = edts && findBox(moov, edts.dataOffset, edts.end, "elst");
    const editShift = elst ? readEditShift(moov, elst) : 0;

    const times = resolveSampleTimes(moov, stts, timescale, wanted, offsets, editShift);
    if (times.length > 0) {
      // A shift applied after the division would be in the wrong units: the
      // edit's `media_time` is in MEDIA ticks, like everything else here.
      // A negative time is not a position in the file. It happens when an edit
      // starts later than a keyframe the table lists, and those frames are not
      // presented at all.
      return times.filter((time) => time >= 0);
    }
  }
  return null;
}
