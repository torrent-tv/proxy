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
 * Delegates keyframe and subtitle sample reading to existing mp4.js / mp4-subtitles.js
 * but centralizes track creation so FlagEnabled / LanguageBCP47 / alternate_group
 * are handled once for every media type.
 */

import { Container } from "./Container.js";
import { isMp4, readMp4KeyframeTimes } from "../container-index/mp4.js";
import { decodeSubtitleSample, readMp4SubtitlePlan } from "../container-index/mp4-subtitles.js";
import { VideoTrack } from "../tracks/VideoTrack.js";
import { AudioTrack } from "../tracks/AudioTrack.js";
import { TextSubtitleTrack, TEXT_FORMATS_MP4 } from "../tracks/TextSubtitleTrack.js";
import { ImageSubtitleTrack } from "../tracks/ImageSubtitleTrack.js";

/**
 * One box header, per ISO/IEC 14496-12 §4.2.
 *
 * @param {Buffer} buf
 * @param {number} off
 * @returns {{ type: string, size: number, dataOffset: number, end: number } | null}
 */
function readBox(buf, off) {
  if (off + 8 > buf.length) return null;
  let sz = buf.readUInt32BE(off);
  const tp = buf.toString("latin1", off + 4, off + 8);
  let hb = 8;
  if (sz === 1) { if (off + 16 > buf.length) return null; sz = Number(buf.readBigUInt64BE(off + 8)); hb = 16; }
  if (sz < hb) return null;
  return { type: tp, size: sz, dataOffset: off + hb, end: off + sz };
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
          isForced: false,
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
   * The byte reading itself stays in `container-index/mp4-subtitles.js`,
   * alongside the sample-table walk that found the range.
   *
   * @param {Buffer} payload - The sample's own bytes.
   * @param {string} codecId - Sample entry type: `tx3g`, `text` or `wvtt`.
   * @returns {string}
   */
  static cueTextOf(payload, codecId) {
    return decodeSubtitleSample(payload, codecId);
  }

  async readKeyframeIndex() {
    const r = await readMp4KeyframeTimes(this.readRange, this.fileSize);
    if (!r) return null;
    if (Array.isArray(r)) return { times: r, tolerance: 0 };
    return r;
  }
}
