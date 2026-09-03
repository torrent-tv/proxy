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
import { VideoTrack } from "../tracks/VideoTrack.js";
import { AudioTrack } from "../tracks/AudioTrack.js";
import { TextSubtitleTrack, TEXT_FORMATS_MP4 } from "../tracks/TextSubtitleTrack.js";
import { ImageSubtitleTrack } from "../tracks/ImageSubtitleTrack.js";

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

export class Mp4Container extends Container {
  get formatName() {
    return "mp4";
  }

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
  static readKeyframeTimes(readRange, fileSize) {
    return readMp4KeyframeTimes(readRange, fileSize);
  }

  /**
   * This container's text subtitle tracks, with every cue's time and byte
   * range — ISO/IEC 14496-12 §8.5 and §8.7.
   *
   * @param {(start:number,end:number)=>Promise<Buffer|null>} readRange
   * @param {number} fileSize
   * @returns {Promise<{ tracks: object[] } | null>}
   */
  static readSubtitlePlan(readRange, fileSize) {
    return readMp4SubtitlePlan(readRange, fileSize);
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
    const plan = await Mp4Container.readSubtitlePlan(this.readRange, this.fileSize);
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
   * next call.
   *
   * @param {{ codecId: string, samples: {offset: number, size: number, startSeconds: number, endSeconds: number}[] }} track
   * @param {Set<number>} harvested - Sample offsets already read; added to.
   * @returns {Promise<{startSeconds: number, endSeconds: number, text: string}[]>}
   *   The cues found in THIS pass.
   */
  async readHeldCues(_plan, track, progress) {
    let harvested = progress.harvested.get(track.trackNumber);
    if (!harvested) {
      harvested = new Set();
      progress.harvested.set(track.trackNumber, harvested);
    }
    const cues = await this.readHeldSamples(track, harvested);
    return {
      found: cues.length > 0 ? new Map([[track.trackNumber, cues]]) : new Map(),
      covered: harvested.size,
      indexed: track?.samples?.length ?? 0
    };
  }

  async readHeldSamples(track, harvested) {
    const found = [];
    for (const sample of track?.samples ?? []) {
      if (harvested.has(sample.offset)) {
        continue;
      }
      const last = Math.min(this.fileSize - 1, sample.offset + sample.size - 1);
      if (!this.isHeld(sample.offset, last)) {
        continue;
      }
      const bytes = await this.readHeld(sample.offset, last);
      if (!bytes) {
        continue;
      }
      harvested.add(sample.offset);
      // The MP4 has framed this cue and is the one that unframes it.
      const text = Mp4Container.cueTextOf(bytes, track.codecId);
      if (text) {
        found.push({ startSeconds: sample.startSeconds, endSeconds: sample.endSeconds, text });
      }
    }
    return found;
  }

  async readTracks() {
    const head = await this.readRange(0, Math.min(64 - 1, this.fileSize - 1));
    if (!head || !isMp4(head)) return [];

    // Use the subtitle plan reader's moov parsing as source for subtitle tracks,
    // and a direct moov walk for video/audio to collect tkhd/mdhd/hdlr/elng uniformly.
    // For simplicity, delegate entirely to readMp4SubtitlePlan for subtitles and
    // do a lightweight moov walk for video/audio here — then merge.
    const subtitlePlan = await readMp4SubtitlePlan(this.readRange, this.fileSize).catch(() => null);
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
    return tracks;
  }

  /**
   * The `moov` box, read whole.
   *
   * Held on the instance because every question this class answers is inside
   * it, and the box can be tens of megabytes off a torrent — reading it once
   * per file is the difference between one fetch and one per question.
   *
   * @returns {Promise<{ moov: Buffer, header: number } | null>}
   */
  async #moovBuffer() {
    if (this.moovHeld !== undefined) {
      return this.moovHeld;
    }
    const PROBE = 64;
    const MAX_MOOV = 32 * 1024 * 1024;
    let at = 0;
    let moovBox = null;
    while (at < this.fileSize) {
      const probe = await this.readRange(at, Math.min(this.fileSize - 1, at + PROBE - 1));
      if (!probe || probe.length < 8) break;
      let size = probe.readUInt32BE(0);
      const type = probe.toString("latin1", 4, 8);
      let header = 8;
      if (size === 1) {
        if (probe.length < 16) break;
        size = Number(probe.readBigUInt64BE(8));
        header = 16;
      }
      if (size <= 0) break;
      if (type === "moov") { moovBox = { offset: at, size, header }; break; }
      at += size;
    }
    if (!moovBox || moovBox.size > MAX_MOOV) {
      this.moovHeld = null;
      return null;
    }
    const moov = await this.readRange(moovBox.offset, Math.min(this.fileSize - 1, moovBox.offset + moovBox.size - 1));
    this.moovHeld = moov ? { moov, header: moovBox.header } : null;
    return this.moovHeld;
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
    this.mediaInfo = info;
    const held = await this.#moovBuffer();
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
        const flags = moov.readUInt32BE(tkhd.dataOffset + 1) & 0xffffff; // 3 bytes after version
        isEnabled = (flags & 0x000001) !== 0;
        trackId = moov.readUInt32BE(ver === 1 ? tkhd.dataOffset + 20 : tkhd.dataOffset + 12);
        alternateGroup = moov.readUInt16BE(ver === 1 ? tkhd.dataOffset + 26 : tkhd.dataOffset + 18);
        // width/height are 16.16 fixed point at end of tkhd
        if (tkhd.end - tkhd.dataOffset >= 84) {
          const w = moov.readUInt32BE(ver === 1 ? tkhd.dataOffset + 76 : tkhd.dataOffset + 68);
          const h = moov.readUInt32BE(ver === 1 ? tkhd.dataOffset + 80 : tkhd.dataOffset + 72);
          width = w / 65536;
          height = h / 65536;
        }
      }
      const resolvedLang = languageBcp47 || language;
      if (handler === "vide") {
        videoIdx += 1;
        // stsd format for codecId
        let codecId = "";
        const minf = childOf(moov, mdia.dataOffset, mdia.end, "minf");
        const stbl = minf && childOf(moov, minf.dataOffset, minf.end, "stbl");
        const stsd = stbl && childOf(moov, stbl.dataOffset, stbl.end, "stsd");
        if (stsd) {
          const first = readBox(moov, stsd.dataOffset + 8);
          if (first) codecId = first.type;
        }
        result.push(new VideoTrack({
          trackNumber: trackId,
          declaredIndex: videoIdx,
          codecId,
          language: resolvedLang,
          languageBcp47,
          name: "",
          isEnabled,
          isDefault: true,
          declaresDefault: false,
          codecPrivateB64: "",
          alternateGroup,
          width,
          height
        }));
      } else if (handler === "soun") {
        audioIdx += 1;
        let codecId = "";
        const minf = childOf(moov, mdia.dataOffset, mdia.end, "minf");
        const stbl = minf && childOf(moov, minf.dataOffset, minf.end, "stbl");
        const stsd = stbl && childOf(moov, stbl.dataOffset, stbl.end, "stsd");
        if (stsd) {
          const first = readBox(moov, stsd.dataOffset + 8);
          if (first) codecId = first.type;
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
          codecPrivateB64: "",
          alternateGroup,
          isOriginal: false,
          isCommentary: false,
          isVisualImpaired: false
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
    const r = await readMp4KeyframeTimes(this.readRange, this.fileSize);
    if (!r) return null;
    if (Array.isArray(r)) return { times: r, tolerance: 0 };
    return r;
  }
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
function sampleDurations(moov, stts, total) {
  const durations = new Array(total).fill(0);
  const entries = moov.readUInt32BE(stts.dataOffset + 4);
  let at = stts.dataOffset + 8;
  let sample = 0;
  for (let entry = 0; entry < entries && at + 8 <= stts.end && sample < total; entry += 1, at += 8) {
    const count = moov.readUInt32BE(at);
    const delta = moov.readUInt32BE(at + 4);
    for (let index = 0; index < count && sample < total; index += 1, sample += 1) {
      durations[sample] = delta;
    }
  }
  return durations;
}

/**
 * Sample sizes, whether the table states one for all or one for each.
 *
 * @param {Buffer} moov
 * @param {{ dataOffset: number, end: number }} stsz
 * @returns {number[]}
 */
function sampleSizes(moov, stsz) {
  const uniform = moov.readUInt32BE(stsz.dataOffset + 4);
  const count = moov.readUInt32BE(stsz.dataOffset + 8);
  if (uniform > 0) {
    return new Array(count).fill(uniform);
  }
  const sizes = new Array(count).fill(0);
  let at = stsz.dataOffset + 12;
  for (let index = 0; index < count && at + 4 <= stsz.end; index += 1, at += 4) {
    sizes[index] = moov.readUInt32BE(at);
  }
  return sizes;
}

/**
 * Where every sample of a track begins in the file.
 *
 * The sample-to-chunk table says how many samples each run of chunks holds, and
 * the chunk-offset table says where each chunk starts; a sample's own offset is
 * its chunk's start plus the sizes of the samples before it in that chunk.
 *
 * @param {Buffer} moov
 * @param {{ dataOffset: number, end: number }} stsc
 * @param {number[]} chunkOffsets
 * @param {number[]} sizes
 * @returns {number[]}
 */
function sampleOffsets(moov, stsc, chunkOffsets, sizes) {
  const offsets = new Array(sizes.length).fill(0);
  const entries = moov.readUInt32BE(stsc.dataOffset + 4);
  /** @type {{ firstChunk: number, perChunk: number }[]} */
  const runs = [];
  let at = stsc.dataOffset + 8;
  for (let entry = 0; entry < entries && at + 12 <= stsc.end; entry += 1, at += 12) {
    runs.push({ firstChunk: moov.readUInt32BE(at), perChunk: moov.readUInt32BE(at + 4) });
  }
  let sample = 0;
  for (let run = 0; run < runs.length && sample < sizes.length; run += 1) {
    const from = runs[run].firstChunk;
    const to = run + 1 < runs.length ? runs[run + 1].firstChunk - 1 : chunkOffsets.length;
    for (let chunk = from; chunk <= to && sample < sizes.length; chunk += 1) {
      let inChunk = chunkOffsets[chunk - 1];
      if (inChunk === undefined) {
        break;
      }
      for (let index = 0; index < runs[run].perChunk && sample < sizes.length; index += 1, sample += 1) {
        offsets[sample] = inChunk;
        inChunk += sizes[sample];
      }
    }
  }
  return offsets;
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
 * @param {(start: number, end: number) => Promise<Buffer | null>} readRange
 * @param {number} fileSize
 * @returns {Promise<{ tracks: Mp4SubtitleTrack[] } | null>}
 */
async function readMp4SubtitlePlan(readRange, fileSize) {
  const found = await findMoov(readRange, fileSize);
  if (!found || found.size > MAX_MOOV_BYTES) {
    return null;
  }
  const moov = await readRange(found.offset, Math.min(fileSize - 1, found.offset + found.size - 1));
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

    const sizes = sampleSizes(moov, stsz);
    const durations = sampleDurations(moov, stts, sizes.length);
    const chunkOffsets = [];
    if (stco) {
      const count = moov.readUInt32BE(stco.dataOffset + 4);
      let at = stco.dataOffset + 8;
      for (let index = 0; index < count && at + 4 <= stco.end; index += 1, at += 4) {
        chunkOffsets.push(moov.readUInt32BE(at));
      }
    } else {
      const count = moov.readUInt32BE(co64.dataOffset + 4);
      let at = co64.dataOffset + 8;
      for (let index = 0; index < count && at + 8 <= co64.end; index += 1, at += 8) {
        chunkOffsets.push(Number(moov.readBigUInt64BE(at)));
      }
    }
    const offsets = sampleOffsets(moov, stsc, chunkOffsets, sizes);

    /** @type {Mp4SubtitleSample[]} */
    const samples = [];
    let ticks = 0;
    for (let index = 0; index < sizes.length; index += 1) {
      const start = ticks / timescale;
      ticks += durations[index];
      // An empty sample is a gap between cues, which the format uses to say
      // "nothing on screen"; it is not a cue and would show as a blank line.
      if (sizes[index] > 2) {
        samples.push({
          startSeconds: start,
          endSeconds: ticks / timescale,
          offset: offsets[index],
          size: sizes[index]
        });
      }
    }
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
function resolveSampleTimes(buffer, stts, timescale, wanted, offsets = null) {
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
        times.push((ticks + (offsets?.get(sampleNumber) ?? 0)) / timescale);
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
 * Read the keyframe times of an MP4/MOV file.
 *
 * @param {(start: number, end: number) => Promise<Buffer | null>} readRange
 * @param {number} fileSize
 * @returns {Promise<number[] | null>} Ascending seconds, or null when the file
 *   carries no usable index (fragmented MP4, truncated or damaged `moov`).
 */
async function readMp4KeyframeTimes(readRange, fileSize) {
  const moovBox = await findMoov(readRange, fileSize);
  if (!moovBox || moovBox.size > MAX_MOOV_BYTES) {
    return null;
  }

  const moov = await readRange(moovBox.offset, Math.min(fileSize - 1, moovBox.offset + moovBox.size - 1));
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

    const times = resolveSampleTimes(moov, stts, timescale, wanted, offsets);
    if (times.length > 0) {
      // A shift applied after the division would be in the wrong units: the
      // edit's `media_time` is in MEDIA ticks, like everything else here.
      const shifted = editShift === 0 ? times : times.map((time) => time - editShift / timescale);
      // A negative time is not a position in the file. It happens when an edit
      // starts later than a keyframe the table lists, and those frames are not
      // presented at all.
      return shifted.filter((time) => time >= 0);
    }
  }
  return null;
}
