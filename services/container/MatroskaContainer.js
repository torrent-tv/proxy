/**
 * @file Matroska/WebM container — RFC 9559.
 *
 * Reads Tracks in one pass for all media types (video, audio, subtitle).
 * Implements spec-accurate flag handling:
 *  - FlagEnabled 0xB9 default 1, zero-length element = default (not disabled)
 *  - FlagDefault 0x88 default 1, declaresDefault tracks whether element was written
 *  - FlagForced 0x55AA only for subtitles, FlagHearingImpaired 0x55AB, FlagVisualImpaired 0x55AC,
 *    FlagTextDescriptions 0x55AD, FlagOriginal 0x55AE, FlagCommentary 0x55AF
 *  - Language 0x22B59C default "eng", LanguageBCP47 0x22B59D MUST — when present, Language ignored
 *  - CodecID 0x86, CodecPrivate 0x63A2, Name 0x536E, TrackType 0x83 (1 video, 2 audio, 17 subtitle)
 *
 * Delegates low-level Cues/cluster and keyframe work to existing readers
 * (ebml-reader, matroska.js, matroska-subtitles.js) but centralizes the single Tracks walk.
 */

import { Container } from "./Container.js";
import { isMatroska, readMatroskaKeyframeTimes } from "../container-index/matroska.js";
import { readSubtitlePlan } from "../container-index/matroska-subtitles.js";
import { VideoTrack } from "../tracks/VideoTrack.js";
import { AudioTrack } from "../tracks/AudioTrack.js";
import { TextSubtitleTrack, TEXT_CODECS_MATROSKA } from "../tracks/TextSubtitleTrack.js";
import { ImageSubtitleTrack } from "../tracks/ImageSubtitleTrack.js";
import { ContainerTrack } from "../tracks/ContainerTrack.js";
import { findElement, iterateElements, readFloat, readUint } from "../container-index/ebml-reader.js";

const HEAD_BYTES = 64 * 1024;
const ID_SEGMENT = 0x18538067;
const ID_SEEK_HEAD = 0x114d9b74;
const ID_SEEK = 0x4dbb;
const ID_SEEK_ID = 0x53ab;
const ID_SEEK_POSITION = 0x53ac;
const ID_INFO = 0x1549a966;
const ID_TIMESTAMP_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;
const ID_CLUSTER = 0x1f43b675;
const ID_TIMESTAMP = 0xe7;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK_GROUP = 0xa0;
/** RFC 9559 §5.1.2.1: nanoseconds per tick when Info omits TimestampScale. */
const DEFAULT_TIMESTAMP_SCALE = 1_000_000;
/**
 * How much to read at a cluster whose position came from the SeekHead. A
 * cluster's Timestamp is the first child every muxer writes, so this only has
 * to cover the element header and that one field.
 */
const CLUSTER_PROBE_BYTES = 4 * 1024;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_NUMBER = 0xd7;
const ID_TRACK_TYPE = 0x83;
const ID_FLAG_ENABLED = 0xb9;
const ID_FLAG_DEFAULT = 0x88;
const ID_FLAG_FORCED = 0x55aa;
const ID_FLAG_HEARING = 0x55ab;
const ID_FLAG_VISUAL = 0x55ac;
const ID_FLAG_TEXT_DESCR = 0x55ad;
const ID_FLAG_ORIGINAL = 0x55ae;
const ID_FLAG_COMMENTARY = 0x55af;
const ID_CODEC_ID = 0x86;
const ID_CODEC_PRIVATE = 0x63a2;
const ID_LANGUAGE = 0x22b59c;
const ID_LANGUAGE_BCP47 = 0x22b59d;
const ID_NAME = 0x536e;
const ID_VIDEO = 0xe0;
const ID_AUDIO = 0xe1;
const ID_PIXEL_WIDTH = 0xb0;
const ID_PIXEL_HEIGHT = 0xba;
const ID_DISPLAY_WIDTH = 0x54b0;
const ID_DISPLAY_HEIGHT = 0x54ba;
const ID_SAMPLING_FREQUENCY = 0xb5;
const ID_CHANNELS = 0x9f;
/**
 * ReadOrder, Layer, Style, Name, MarginL, MarginR, MarginV, Effect — the eight
 * fields Matroska writes before the text of an SSA/ASS event. See
 * {@link MatroskaContainer.cueTextOf} for the quotation this comes from.
 */
const ASS_FIELDS_BEFORE_TEXT = 8;

function readString(buf, el) {
  return buf.toString("utf8", el.dataOffset, el.dataOffset + el.size).replace(/\0+$/, "");
}

export class MatroskaContainer extends Container {
  get formatName() {
    return "matroska";
  }

  static detect(head) {
    return isMatroska(head);
  }

  /**
   * Duration and the start of this file's own timeline, per RFC 9559 §5.1.2.
   *
   * Duration is stated in `Info` as a FLOAT in ticks, so it needs the file's
   * `TimestampScale` to become seconds. The start of the timeline is not stated
   * anywhere — Matroska has no such element — so it is the timestamp of the
   * first Cluster, which is what the first frame is placed against.
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
    const head = await this.readRange(0, Math.min(HEAD_BYTES - 1, this.fileSize - 1));
    if (!head || !isMatroska(head)) {
      return info;
    }
    const segment = findElement(head, ID_SEGMENT, []);
    if (!segment) {
      return info;
    }
    const scale = MatroskaContainer.#timestampScaleOf(head, segment.dataOffset);
    const infoElement = findElement(head, ID_INFO, [], segment.dataOffset);
    if (infoElement) {
      const infoEnd = Math.min(head.length, infoElement.dataOffset + infoElement.size);
      for (const field of iterateElements(head, infoElement.dataOffset, infoEnd)) {
        if (field.id !== ID_DURATION) {
          continue;
        }
        const ticks = readFloat(head, field.dataOffset, field.size);
        if (ticks !== null && ticks > 0) {
          info.durationSeconds = (ticks * scale) / 1e9;
        }
        break;
      }
    }
    info.startTimeSeconds = await this.#firstClusterSeconds(head, segment.dataOffset, scale);
    return info;
  }

  /**
   * `TimestampScale` from Info, or the specification's default.
   *
   * @param {Buffer} head
   * @param {number} segmentDataOffset
   * @returns {number} Nanoseconds per tick.
   */
  static #timestampScaleOf(head, segmentDataOffset) {
    const infoElement = findElement(head, ID_INFO, [], segmentDataOffset);
    if (!infoElement) {
      return DEFAULT_TIMESTAMP_SCALE;
    }
    const infoEnd = Math.min(head.length, infoElement.dataOffset + infoElement.size);
    for (const field of iterateElements(head, infoElement.dataOffset, infoEnd)) {
      if (field.id === ID_TIMESTAMP_SCALE) {
        const scale = readUint(head, field.dataOffset, field.size);
        return scale > 0 ? scale : DEFAULT_TIMESTAMP_SCALE;
      }
    }
    return DEFAULT_TIMESTAMP_SCALE;
  }

  /**
   * The timestamp of the first Cluster, in seconds.
   *
   * Tried in the head window first, because a muxer writes the first cluster
   * straight after Tracks and both usually fit; a file whose Tracks element is
   * large enough to push it out is answered from the SeekHead instead, with one
   * short read at the position it names.
   *
   * @param {Buffer} head
   * @param {number} segmentDataOffset
   * @param {number} scale - Nanoseconds per tick.
   * @returns {Promise<number | null>} Null when no cluster could be read.
   */
  async #firstClusterSeconds(head, segmentDataOffset, scale) {
    /**
     * @param {Buffer} buffer
     * @param {number} dataOffset
     * @param {number} end
     * @returns {number | null}
     */
    const timestampIn = (buffer, dataOffset, end) => {
      for (const field of iterateElements(buffer, dataOffset, end)) {
        if (field.id === ID_TIMESTAMP) {
          const ticks = readUint(buffer, field.dataOffset, field.size);
          return Number.isFinite(ticks) ? (ticks * scale) / 1e9 : null;
        }
        // Timestamp is written before any frame. Stopping at the first one keeps
        // this from walking a cluster's whole payload, which is megabytes and
        // usually not in the buffer at all.
        if (field.id === ID_SIMPLE_BLOCK || field.id === ID_BLOCK_GROUP) {
          return null;
        }
      }
      return null;
    };

    for (const element of iterateElements(head, segmentDataOffset, head.length)) {
      if (element.id !== ID_CLUSTER) {
        continue;
      }
      return timestampIn(head, element.dataOffset, Math.min(head.length, element.dataOffset + element.size));
    }

    const position = MatroskaContainer.#seekPositionOf(head, segmentDataOffset, ID_CLUSTER);
    if (position === null) {
      return null;
    }
    const at = segmentDataOffset + position;
    if (at >= this.fileSize) {
      return null;
    }
    const chunk = await this.readRange(at, Math.min(this.fileSize - 1, at + CLUSTER_PROBE_BYTES - 1));
    if (!chunk) {
      return null;
    }
    for (const element of iterateElements(chunk, 0, chunk.length)) {
      if (element.id !== ID_CLUSTER) {
        continue;
      }
      return timestampIn(chunk, element.dataOffset, Math.min(chunk.length, element.dataOffset + element.size));
    }
    return null;
  }

  /**
   * Where the SeekHead says an element lives, relative to the Segment's payload.
   *
   * @param {Buffer} head
   * @param {number} segmentDataOffset
   * @param {number} wantedId
   * @returns {number | null}
   */
  static #seekPositionOf(head, segmentDataOffset, wantedId) {
    const seekHead = findElement(head, ID_SEEK_HEAD, [], segmentDataOffset);
    if (!seekHead) {
      return null;
    }
    const seekHeadEnd = Math.min(head.length, seekHead.dataOffset + seekHead.size);
    for (const seek of iterateElements(head, seekHead.dataOffset, seekHeadEnd)) {
      if (seek.id !== ID_SEEK) {
        continue;
      }
      const seekEnd = Math.min(seekHeadEnd, seek.dataOffset + seek.size);
      let targetId = null;
      let position = null;
      for (const field of iterateElements(head, seek.dataOffset, seekEnd)) {
        if (field.id === ID_SEEK_ID) {
          targetId = readUint(head, field.dataOffset, field.size);
        } else if (field.id === ID_SEEK_POSITION) {
          position = readUint(head, field.dataOffset, field.size);
        }
      }
      if (targetId === wantedId && position !== null) {
        return position;
      }
    }
    return null;
  }

  async readTracks() {
    const head = await this.readRange(0, Math.min(HEAD_BYTES - 1, this.fileSize - 1));
    if (!head || !isMatroska(head)) return [];

    // Delegate to subtitle plan reader for subtitle tracks (already handles Flags spec-correct),
    // but we need video/audio tracks too. Do a dedicated Tracks walk here for all types,
    // then merge subtitle detail (clusterPositions, declaresDefault etc.) from the plan.
    const seg = findElement(head, 0x18538067, []);
    if (!seg) return [];
    const tracksEl = findElement(head, ID_TRACKS, [], seg.dataOffset);
    if (!tracksEl) return [];

    const tracksEnd = Math.min(head.length, tracksEl.dataOffset + tracksEl.size);
    /** @type {import("../tracks/index.js").ContainerTrack[]} */
    const result = [];
    // Subtitle declaredIndex is position among subtitle tracks, not global — track per-type counters.
    let subtitleDeclaredIndex = -1;
    let audioDeclaredIndex = -1;
    let videoDeclaredIndex = -1;

    // For subtitle flag enrichment, read the existing plan (it already does Cues walk)
    let subtitlePlan = null;
    try {
      const shim = async (s, e) => this.readRange(s, Math.min(e, this.fileSize - 1));
      subtitlePlan = await readSubtitlePlan(shim, this.fileSize);
    } catch {
      subtitlePlan = null;
    }
    const declaredByNumber = new Map();
    const planTracksByNumber = new Map();
    if (subtitlePlan?.declared) {
      for (const d of subtitlePlan.declared) declaredByNumber.set(d.trackNumber, d);
    }
    if (subtitlePlan?.tracks) {
      for (const t of subtitlePlan.tracks) planTracksByNumber.set(t.trackNumber, t);
    }

    for (const entry of iterateElements(head, tracksEl.dataOffset, tracksEnd)) {
      if (entry.id !== ID_TRACK_ENTRY) continue;
      const entryEnd = Math.min(tracksEnd, entry.dataOffset + entry.size);
      let trackNumber = null;
      let typeNum = null;
      let codecId = "";
      let language = "";
      let languageBcp47 = "";
      let name = "";
      let codecPrivateB64 = "";
      let isEnabled = true;
      let isDefault = true;
      let declaresDefault = false;
      let isForced = false;
      let isHearing = false;
      let isVisual = false;
      let isOriginal = false;
      let isCommentary = false;
      let pixelWidth = null;
      let pixelHeight = null;
      let displayWidth = null;
      let displayHeight = null;
      let samplingFreq = null;
      let channels = null;

      for (const f of iterateElements(head, entry.dataOffset, entryEnd)) {
        switch (f.id) {
          case ID_TRACK_NUMBER: trackNumber = readUint(head, f.dataOffset, f.size); break;
          case ID_TRACK_TYPE: typeNum = readUint(head, f.dataOffset, f.size); break;
          case ID_CODEC_ID: codecId = readString(head, f); break;
          case ID_CODEC_PRIVATE: codecPrivateB64 = head.toString("base64", f.dataOffset, f.dataOffset + f.size); break;
          case ID_LANGUAGE: language = readString(head, f); break;
          case ID_LANGUAGE_BCP47: languageBcp47 = readString(head, f); break;
          case ID_NAME: name = readString(head, f); break;
          case ID_FLAG_ENABLED: isEnabled = f.size === 0 || readUint(head, f.dataOffset, f.size) !== 0; break;
          case ID_FLAG_DEFAULT: isDefault = f.size === 0 || readUint(head, f.dataOffset, f.size) === 1; declaresDefault = true; break;
          case ID_FLAG_FORCED: isForced = f.size > 0 && readUint(head, f.dataOffset, f.size) !== 0; break;
          case ID_FLAG_HEARING: isHearing = f.size > 0 && readUint(head, f.dataOffset, f.size) !== 0; break;
          case ID_FLAG_VISUAL: isVisual = f.size > 0 && readUint(head, f.dataOffset, f.size) !== 0; break;
          case ID_FLAG_TEXT_DESCR: break;
          case ID_FLAG_ORIGINAL: isOriginal = f.size > 0 && readUint(head, f.dataOffset, f.size) !== 0; break;
          case ID_FLAG_COMMENTARY: isCommentary = f.size > 0 && readUint(head, f.dataOffset, f.size) !== 0; break;
          default: break;
        }
        // Video/Audio sub-elements are nested, not at entry level — read separately below.
      }
      if (trackNumber === null) continue;

      // Parse Video/Audio sub-elements if present
      const videoEl = findElement(head, ID_VIDEO, [], entry.dataOffset, entryEnd);
      if (videoEl) {
        for (const vf of iterateElements(head, videoEl.dataOffset, Math.min(entryEnd, videoEl.dataOffset + videoEl.size))) {
          if (vf.id === ID_PIXEL_WIDTH) pixelWidth = readUint(head, vf.dataOffset, vf.size);
          else if (vf.id === ID_PIXEL_HEIGHT) pixelHeight = readUint(head, vf.dataOffset, vf.size);
          else if (vf.id === ID_DISPLAY_WIDTH) displayWidth = readUint(head, vf.dataOffset, vf.size);
          else if (vf.id === ID_DISPLAY_HEIGHT) displayHeight = readUint(head, vf.dataOffset, vf.size);
        }
      }
      const audioEl = findElement(head, ID_AUDIO, [], entry.dataOffset, entryEnd);
      if (audioEl) {
        for (const af of iterateElements(head, audioEl.dataOffset, Math.min(entryEnd, audioEl.dataOffset + audioEl.size))) {
          if (af.id === ID_SAMPLING_FREQUENCY) {
            // SamplingFrequency is float64
            if (af.size === 8) samplingFreq = head.readDoubleBE(af.dataOffset);
            else samplingFreq = readUint(head, af.dataOffset, af.size);
          } else if (af.id === ID_CHANNELS) channels = readUint(head, af.dataOffset, af.size);
        }
      }

      // RFC 9559 LanguageBCP47 MUST — when present, Language ignored
      const resolvedLang = languageBcp47 || language;
      const bcpTag = languageBcp47;

      if (typeNum === 1) {
        videoDeclaredIndex += 1;
        result.push(new VideoTrack({
          trackNumber,
          declaredIndex: videoDeclaredIndex,
          codecId,
          language: resolvedLang,
          languageBcp47: bcpTag,
          name,
          isEnabled,
          isDefault,
          declaresDefault,
          codecPrivateB64,
          width: pixelWidth,
          height: pixelHeight,
          displayWidth,
          displayHeight
        }));
      } else if (typeNum === 2) {
        audioDeclaredIndex += 1;
        result.push(new AudioTrack({
          trackNumber,
          declaredIndex: audioDeclaredIndex,
          codecId,
          language: resolvedLang,
          languageBcp47: bcpTag,
          name,
          isEnabled,
          isDefault,
          declaresDefault,
          codecPrivateB64,
          isOriginal,
          isCommentary,
          isVisualImpaired: isVisual,
          channels,
          samplingFrequency: samplingFreq
        }));
      } else if (typeNum === 17) {
        subtitleDeclaredIndex += 1;
        // Only Forced/Hearing belong to subtitles; Original/Commentary must not leak.
        const declared = declaredByNumber.get(trackNumber);
        const planTrack = planTracksByNumber.get(trackNumber);
        // Prefer plan's flags when available (already spec-correct), else use parsed.
        const finalForced = planTrack ? !!planTrack.isForced : isForced;
        const finalHearing = planTrack ? !!planTrack.isHearingImpaired : isHearing;
        const finalEnabled = declared ? declared.isEnabled !== false : isEnabled;
        const finalDefault = declared ? !!declared.isDefault : isDefault;
        const finalDeclares = declared ? !!declared.declaresDefault : declaresDefault;
        const clusterPositions = planTrack ? planTrack.clusterPositions ?? [] : [];
        const isText = TEXT_CODECS_MATROSKA.has(codecId);
        // disabled image/text tracks still counted (declaredIndex above) — offerable flag controls visibility
        if (isText && finalEnabled) {
          result.push(new TextSubtitleTrack({
            trackNumber,
            declaredIndex: subtitleDeclaredIndex,
            codecId,
            language: resolvedLang,
            languageBcp47: bcpTag,
            name,
            isEnabled: finalEnabled,
            isDefault: finalDefault,
            declaresDefault: finalDeclares,
            codecPrivateB64,
            isForced: finalForced,
            isHearingImpaired: finalHearing,
            clusterPositions
          }));
        } else {
          // Image or disabled — keep declaredIndex, not offerable if disabled
          const Target = isText ? TextSubtitleTrack : ImageSubtitleTrack;
          result.push(new Target({
            trackNumber,
            declaredIndex: subtitleDeclaredIndex,
            codecId,
            language: resolvedLang,
            languageBcp47: bcpTag,
            name,
            isEnabled: finalEnabled,
            isDefault: finalDefault,
            declaresDefault: finalDeclares,
            codecPrivateB64,
            isForced: finalForced,
            isHearingImpaired: finalHearing,
            clusterPositions: isText ? clusterPositions : []
          }));
        }
      } else {
        // Other TrackType (complex, logo, buttons, control) — keep as generic, not video
        result.push(new ContainerTrack({
          trackNumber,
          declaredIndex: -1,
          type: "other",
          codecId,
          language: resolvedLang,
          languageBcp47: bcpTag,
          name,
          isEnabled,
          isDefault,
          declaresDefault,
          codecPrivateB64
        }));
      }
    }
    return result;
  }

  /**
   * The text field of one cue as Matroska frames it.
   *
   * Two rules, both from `matroska.org/technical/subtitles.html`, "Now, how are
   * they stored in Matroska?":
   *
   * 1. "All text is converted to UTF-8", so the block is decoded as UTF-8 and
   *    no other encoding is guessed at. A subtitle FILE is a different matter —
   *    there the bytes may be Windows-1251 and `decodeSubtitleBytes` sniffs for
   *    it — but a muxer had to convert before writing the block.
   * 2. "Events are stored in the Block in this order: ReadOrder, Layer, Style,
   *    Name, MarginL, MarginR, MarginV, Effect, Text", and "Start & End field
   *    are used to set TimeStamp and the BlockDuration element". So eight fields
   *    stand before the text, the two timing fields of the file's own row are
   *    NOT among them, and a read order takes their place at the front. The text
   *    itself may hold commas, so everything from the ninth field on is joined
   *    back together.
   *
   * `S_TEXT/UTF8` and `S_TEXT/WEBVTT` have no such framing: the block holds the
   * cue text and nothing else. (A WebVTT cue's settings, identifier and
   * preceding comments live in a BlockAddition, which this proxy does not read;
   * losing them costs positioning, not words.)
   *
   * @param {Buffer} payload - The block's own bytes.
   * @param {string} codecId - Matroska CodecID of the track the block belongs to.
   * @returns {string}
   */
  static cueTextOf(payload, codecId) {
    const text = Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload ?? "");
    if (codecId !== "S_TEXT/ASS" && codecId !== "S_TEXT/SSA") {
      return text;
    }
    const fields = text.split(",");
    return fields.length > ASS_FIELDS_BEFORE_TEXT ? fields.slice(ASS_FIELDS_BEFORE_TEXT).join(",") : "";
  }

  async readKeyframeIndex() {
    const times = await readMatroskaKeyframeTimes(this.readRange, this.fileSize);
    if (!times) return null;
    if (Array.isArray(times)) return { times, tolerance: 0 };
    return times;
  }
}
