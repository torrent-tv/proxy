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
 * Keyframe reading is delegated to matroska.js and byte-level EBML walking to
 * ebml-reader.js. Everything this container states about its own subtitles —
 * the Tracks walk, the Cues table, the cluster positions it names, and the
 * blocks inside a cluster — is read in this module: each of those is RFC 9559
 * speaking about Matroska, and the class is the only way in.
 */

import { Container } from "./Container.js";
import { isMatroska, readMatroskaKeyframeTimes } from "../container-index/matroska.js";
import { VideoTrack } from "../tracks/VideoTrack.js";
import { AudioTrack } from "../tracks/AudioTrack.js";
import { TextSubtitleTrack, TEXT_CODECS_MATROSKA } from "../tracks/TextSubtitleTrack.js";
import { ImageSubtitleTrack } from "../tracks/ImageSubtitleTrack.js";
import { ContainerTrack } from "../tracks/ContainerTrack.js";
import { findElement, iterateElements, readFloat, readUint, readVint } from "../container-index/ebml-reader.js";

const HEAD_BYTES = 64 * 1024;
/** Enough to read any cluster's own element header. */
const CLUSTER_HEADER_PROBE = 64;
/**
 * The largest cluster this will read whole. Real muxers write clusters of a few
 * megabytes; anything past this is not a cluster boundary we recognised and
 * reading it would be a large read for nothing.
 */
const MAX_CLUSTER_BYTES = 32 * 1024 * 1024;

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
   * This container's subtitle tracks, its Cues table and the cluster positions
   * they name — RFC 9559 §5.1.4 and §5.1.3.
   *
   * @param {(start:number,end:number)=>Promise<Buffer|null>} readRange
   * @param {number} fileSize
   * @returns {Promise<object|null>}
   */
  static readSubtitlePlan(readRange, fileSize) {
    return readSubtitlePlan(readRange, fileSize);
  }

  /**
   * The same reading, over the file this container was built on.
   *
   * The static form exists for a caller that has bytes and no container; this
   * is the one to use otherwise, because the reader is already here.
   *
   * @returns {Promise<object|null>}
   */
  readSubtitlePlan() {
    return MatroskaContainer.readSubtitlePlan(this.readRange, this.fileSize);
  }

  /**
   * The blocks one track has inside a cluster, with their times.
   *
   * The payload is handed back as BYTES: what those bytes mean is
   * {@link MatroskaContainer.cueTextOf}'s answer, and this method's subject is
   * only where a block sits and how long it lasts.
   *
   * @param {Buffer} bytes - The cluster, from its own element header onward.
   * @param {number} trackNumber
   * @param {number} secondsPerTick
   * @returns {{ startSeconds: number, endSeconds: number | null, payload: Buffer }[]}
   */
  static blocksInCluster(bytes, trackNumber, secondsPerTick) {
    return harvestCluster(bytes, trackNumber, secondsPerTick);
  }

  /**
   * The blocks one track has inside a cluster whose bounds are already known —
   * RFC 9559 §5.1.3.4 (SimpleBlock) and §5.1.3.5 (BlockGroup).
   *
   * The same reading as {@link MatroskaContainer.blocksInCluster}, entered where
   * the caller has already parsed the cluster's own header.
   *
   * @param {Buffer} buffer
   * @param {{ dataOffset: number, size: number }} cluster
   * @param {number} trackNumber
   * @param {number} secondsPerTick
   * @returns {{ startSeconds: number, durationSeconds: number | null, payload: Buffer }[]}
   */
  static blocksOfTrack(buffer, cluster, trackNumber, secondsPerTick) {
    return blocksOfTrack(buffer, cluster, trackNumber, secondsPerTick);
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


  /**
   * Walk the clusters this file's Cues table names and give up the blocks in
   * every one that is READABLE now, for every track at once.
   *
   * One walk for the whole file, not one per track: a Matroska cluster carries
   * the blocks of every track that has anything to say over its span, so the
   * bytes that answer one track answer them all. Reading them once per track
   * meant the same cluster was fetched and parsed as many times as the film has
   * subtitle tracks — measured 2026-08-20 on a film with five: five requests
   * every fifteen seconds, each costing 0.2-5.2 s, for a few kilobytes of cues.
   *
   * Nothing is fetched. `isHeld` decides whether a cluster can be read at all,
   * and one that is not here yet is left for the next call — turning subtitles
   * on must not pull bytes the viewer is not waiting for.
   *
   * @param {object} plan - From {@link MatroskaContainer.readSubtitlePlan}.
   * @param {Set<number>} walked - Cluster positions already read; added to.
   * @returns {Promise<Map<number, {startSeconds: number, endSeconds: number|null, text: string}[]>>}
   *   Track number to the cues found in THIS pass.
   */
  async walkHeldClusters(plan, walked) {
    /** @type {Map<number, object[]>} */
    const found = new Map();
    // The union of the tracks' cluster lists: each track's list comes from its
    // own Cues entries, so they overlap but do not coincide.
    const positions = new Set();
    for (const candidate of plan?.tracks ?? []) {
      for (const position of candidate.clusterPositions ?? []) {
        positions.add(position);
      }
    }
    for (const position of [...positions].sort((left, right) => left - right)) {
      if (walked.has(position)) {
        continue;
      }
      // The header first: it says how long the cluster is, and a cluster whose
      // bytes are not all here is left for the next time round.
      const probeEnd = Math.min(this.fileSize - 1, position + CLUSTER_HEADER_PROBE - 1);
      if (!this.isHeld(position, probeEnd)) {
        continue;
      }
      const probe = await this.readHeld(position, probeEnd);
      const header = probe && [...iterateElements(probe, 0, probe.length)][0];
      if (!header || header.size <= 0 || header.size > MAX_CLUSTER_BYTES) {
        walked.add(position); // not a cluster this can read; do not look again
        continue;
      }
      const last = Math.min(this.fileSize - 1, position + header.dataOffset + header.size - 1);
      if (!this.isHeld(position, last)) {
        continue;
      }
      const bytes = await this.readHeld(position, last);
      if (!bytes) {
        continue;
      }
      walked.add(position);
      for (const candidate of plan.tracks) {
        const blocks = MatroskaContainer.blocksInCluster(bytes, candidate.trackNumber, plan.secondsPerTick);
        if (blocks.length === 0) {
          continue;
        }
        const into = found.get(candidate.trackNumber) ?? [];
        for (const block of blocks) {
          // The block's bytes become text HERE, where the container that framed
          // them is known. A cue kept framed and unframed later cannot be
          // unframed at all: nothing downstream knows which container it came
          // out of, and guessing from the field count is what showed the
          // dialogue row's own fields to the viewer.
          into.push({
            startSeconds: block.startSeconds,
            endSeconds: block.endSeconds,
            text: MatroskaContainer.cueTextOf(block.payload, candidate.codecId)
          });
        }
        found.set(candidate.trackNumber, into);
      }
    }
    return found;
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

// ---------------------------------------------------------------------------
// Matroska's own reading of its subtitle tracks and its clusters. It lives in
// this module because every line of it is a statement of RFC 9559 about how
// this container stores a subtitle, and the class is the only way in.
// ---------------------------------------------------------------------------

const ID_BLOCK = 0xa1;
const ID_BLOCK_DURATION = 0x9b;

/** Bits 1-2 of the flags byte say how a block is laced, or that it is not. */
const LACING_MASK = 0x06;
const LACING_NONE = 0x00;
const LACING_XIPH = 0x02;
const LACING_FIXED = 0x04;
const LACING_EBML = 0x06;

/**
 * @typedef {object} SubtitleBlock
 * @property {number} startSeconds - When the cue appears.
 * @property {number | null} durationSeconds - How long it stays, or null when
 *   the block carried no duration (a SimpleBlock; the caller decides).
 * @property {Buffer} payload - The block's own bytes, still in the codec's form.
 */

/**
 * Read one block's header.
 *
 * @param {Buffer} buffer
 * @param {number} start - First byte of the block's payload.
 * @param {number} end - One past its last byte.
 * @returns {{ trackNumber: number, relativeTicks: number, flags: number, dataOffset: number } | null}
 */
function readBlockHeader(buffer, start, end) {
  const track = readVint(buffer, start, false);
  if (!track || track.value === null) {
    return null;
  }
  const timestampAt = start + track.length;
  // Signed, and it can be negative: a block may belong slightly before the
  // cluster it is stored in.
  if (timestampAt + 3 > end) {
    return null;
  }
  return {
    trackNumber: Number(track.value),
    relativeTicks: buffer.readInt16BE(timestampAt),
    flags: buffer[timestampAt + 2],
    dataOffset: timestampAt + 3
  };
}

/**
 * Where a laced block's first frame begins.
 *
 * Subtitles are rarely laced, but a block that IS laced starts with a frame
 * count and a table of sizes, and reading the payload without stepping over
 * them yields the table as though it were text.
 *
 * @param {Buffer} buffer
 * @param {number} dataOffset - First byte after the block header.
 * @param {number} end
 * @param {number} flags
 * @returns {number | null} The offset of the first frame, or null when the
 *   lacing cannot be read.
 */
function firstFrameOffset(buffer, dataOffset, end, flags) {
  const lacing = flags & LACING_MASK;
  if (lacing === LACING_NONE) {
    return dataOffset;
  }
  if (dataOffset >= end) {
    return null;
  }
  const frames = buffer[dataOffset] + 1;
  let at = dataOffset + 1;
  if (lacing === LACING_FIXED) {
    return at;
  }
  if (lacing === LACING_XIPH) {
    // Each size but the last is a run of 0xFF bytes ending in a smaller one.
    for (let frame = 0; frame < frames - 1; frame += 1) {
      while (at < end && buffer[at] === 0xff) {
        at += 1;
      }
      at += 1;
    }
    return at <= end ? at : null;
  }
  if (lacing === LACING_EBML) {
    // The first size is a plain variable-length integer, the rest are signed
    // differences from it; either way each is one such integer to step over.
    for (let frame = 0; frame < frames - 1; frame += 1) {
      const size = readVint(buffer, at, false);
      if (!size) {
        return null;
      }
      at += size.length;
    }
    return at <= end ? at : null;
  }
  return null;
}

/**
 * Every block of one track inside one cluster.
 *
 * @param {Buffer} buffer - Bytes holding the cluster's payload.
 * @param {{ dataOffset: number, size: number }} cluster - Where that payload is.
 * @param {number} trackNumber - The track to keep.
 * @param {number} secondsPerTick - From the segment's timestamp scale.
 * @returns {SubtitleBlock[]}
 */
function blocksOfTrack(buffer, cluster, trackNumber, secondsPerTick) {
  const end = Math.min(buffer.length, cluster.dataOffset + cluster.size);
  /** @type {SubtitleBlock[]} */
  const blocks = [];
  let clusterTicks = null;

  const take = (blockStart, blockEnd, durationTicks) => {
    const header = readBlockHeader(buffer, blockStart, blockEnd);
    if (!header || header.trackNumber !== trackNumber || clusterTicks === null) {
      return;
    }
    const payloadAt = firstFrameOffset(buffer, header.dataOffset, blockEnd, header.flags);
    if (payloadAt === null || payloadAt >= blockEnd) {
      return;
    }
    blocks.push({
      startSeconds: (clusterTicks + header.relativeTicks) * secondsPerTick,
      durationSeconds: durationTicks === null ? null : durationTicks * secondsPerTick,
      payload: buffer.subarray(payloadAt, blockEnd)
    });
  };

  for (const element of iterateElements(buffer, cluster.dataOffset, end)) {
    const elementEnd = Math.min(end, element.dataOffset + element.size);
    if (element.id === ID_TIMESTAMP) {
      clusterTicks = readUint(buffer, element.dataOffset, element.size);
      continue;
    }
    if (element.id === ID_SIMPLE_BLOCK) {
      take(element.dataOffset, elementEnd, null);
      continue;
    }
    if (element.id !== ID_BLOCK_GROUP) {
      continue;
    }
    // A group holds the block and, for a subtitle, the duration that says when
    // the cue leaves the screen. Both are read before either is used, because
    // the duration may be written after the block.
    let blockStart = null;
    let blockEnd = null;
    let durationTicks = null;
    for (const field of iterateElements(buffer, element.dataOffset, elementEnd)) {
      const fieldEnd = Math.min(elementEnd, field.dataOffset + field.size);
      if (field.id === ID_BLOCK) {
        blockStart = field.dataOffset;
        blockEnd = fieldEnd;
      } else if (field.id === ID_BLOCK_DURATION) {
        durationTicks = readUint(buffer, field.dataOffset, field.size);
      }
    }
    if (blockStart !== null) {
      take(blockStart, blockEnd, durationTicks);
    }
  }
  return blocks;
}


/**
 * The rest of what a TrackEntry says about itself, RFC 9559 §5.1.4.1. Read
 * because the file states them and a releaser's own wording in `Name` is the
 * only thing we had before: "fors" and "SDH" in a menu were whatever text
 * someone happened to type.
 *
 * `FlagEnabled` defaults to 1 and means "the track is usable"; a track that
 * says 0 is counted but not offered. `FlagForced` applies only to subtitles and
 * defaults to 0. `FlagHearingImpaired` is set "if and only if the track is
 * suitable for users with hearing impairments". `FlagVisualImpaired`,
 * `FlagOriginal` and `FlagCommentary` bear on the AUDIO choice and are read
 * with that work, not here — see roadmap item 55.
 */
const ID_FLAG_HEARING_IMPAIRED = 0x55ab;
/**
 * The language as RFC 5646 writes it. The specification is a MUST: "If this
 * element is used, then any Language elements used in the same TrackEntry MUST
 * be ignored" — so where both are present, this one is the answer and the
 * three-letter code is not.
 */
const ID_CUES = 0x1c53bb6b;
const ID_CUE_POINT = 0xbb;
const ID_CUE_TRACK_POSITIONS = 0xb7;
const ID_CUE_TRACK = 0xf7;
const ID_CUE_CLUSTER_POSITION = 0xf1;

/** TrackType 17 is subtitles; 1 is video and 2 audio. */
const TRACK_TYPE_SUBTITLE = 17;
/** How much of the file start to read: the same window the keyframe reader uses. */
/** Cap on the Cues read; a long film indexes to tens of KB. */
const MAX_CUES_BYTES = 8 * 1024 * 1024;

/**
 * The codecs whose blocks are text this proxy can turn into WebVTT.
 *
 * `S_TEXT/UTF8` is a plain line of text and needs nothing. `S_TEXT/ASS` and
 * `S_TEXT/SSA` carry a dialogue row whose fields have to be stripped, and their
 * header lives in CodecPrivate — supported, with the stripping done where the
 * cue is turned into WebVTT. `S_HDMV/PGS` and `S_VOBSUB` are pictures, not
 * text, and are deliberately absent: offering them would promise something this
 * path cannot deliver.
 */
const TEXT_CODECS = new Set(["S_TEXT/UTF8", "S_TEXT/ASS", "S_TEXT/SSA"]);

/**
 * @typedef {object} SubtitleTrackPlan
 * @property {number} trackNumber - As the blocks name it.
 * @property {number} declaredIndex - Its position among ALL of the file's
 *   subtitle tracks, picture-based ones included — which is the number ffmpeg
 *   gives the same stream in `0:s:N`, and therefore the only number the browser
 *   ever names. Text tracks alone are not a numbering: a file whose PGS track
 *   comes first would have every text track one lower here than in the browser.
 * @property {string} codecId
 * @property {string} language - The language the file declares: its RFC 5646
 *   tag where it writes one, and the three-letter code otherwise. The
 *   specification requires that order — where `LanguageBCP47` is present, the
 *   `Language` element MUST be ignored.
 * @property {string} languageBcp47 - The RFC 5646 tag alone, or "".
 * @property {string} name - What the file calls the track, if anything.
 * @property {boolean} isDefault
 * @property {boolean} isForced - `FlagForced`: the track carries what a viewer
 *   needs even when they asked for no subtitles — signs, and dialogue in
 *   another language. It does NOT carry the film's own dialogue.
 * @property {boolean} isHearingImpaired - `FlagHearingImpaired`: suitable for
 *   viewers who cannot hear, so it carries non-speech sound as well as speech.
 * @property {string} codecPrivate - The ASS/SSA header, base64, or "".
 * @property {number[]} clusterPositions - File offsets of clusters whose cue
 *   points name this track, ascending. Empty when the file indexes only its
 *   picture, and then the caller has to walk clusters as they arrive instead.
 */


/**
 * Everything about a file's text subtitle tracks that can be learned without
 * reading the film.
 *
 * @param {(start: number, end: number) => Promise<Buffer | null>} readRange
 * @param {number} fileSize
 * @returns {Promise<{ tracks: SubtitleTrackPlan[], declared: object[], secondsPerTick: number, segmentDataOffset: number } | null>}
 */
async function readSubtitlePlan(readRange, fileSize) {
  const head = await readRange(0, Math.min(HEAD_BYTES, Math.max(0, fileSize - 1)));
  if (!head || head.length < 4 || head.readUInt32BE(0) !== 0x1a45dfa3) {
    return null;
  }
  const segment = findElement(head, ID_SEGMENT, []);
  if (!segment) {
    return null;
  }
  const base = segment.dataOffset;

  const info = findElement(head, ID_INFO, [], base);
  let scale = DEFAULT_TIMESTAMP_SCALE;
  if (info) {
    const declared = findElement(head, ID_TIMESTAMP_SCALE, [], info.dataOffset, info.dataOffset + info.size);
    if (declared) {
      const value = readUint(head, declared.dataOffset, declared.size);
      if (value > 0) {
        scale = value;
      }
    }
  }

  const tracksElement = findElement(head, ID_TRACKS, [], base);
  if (!tracksElement) {
    return null;
  }
  const tracksEnd = Math.min(head.length, tracksElement.dataOffset + tracksElement.size);
  /** @type {SubtitleTrackPlan[]} */
  const tracks = [];
  /**
   * Every subtitle track the file declares, in the order the Tracks element
   * names them, text or picture. This is not for extraction — `tracks` is —
   * but for lining ffmpeg's `0:s:N` numbering up against the container, which
   * only holds while nothing is missing from the middle of the list.
   *
   * @type {Array<{ trackNumber: number, codecId: string, language: string, name: string, isDefault: boolean, declaresDefault: boolean }>}
   */
  const declared = [];
  for (const entry of iterateElements(head, tracksElement.dataOffset, tracksEnd)) {
    if (entry.id !== ID_TRACK_ENTRY) {
      continue;
    }
    const entryEnd = Math.min(tracksEnd, entry.dataOffset + entry.size);
    let trackNumber = null;
    let type = null;
    let codecId = "";
    let language = "";
    let name = "";
    let codecPrivate = "";
    // Matroska's `FlagDefault` DEFAULTS TO 1, so a file whose muxer wrote it on
    // no track is indistinguishable, once the default has been applied, from
    // one that wrote it on every track — which is how ffmpeg's banner prints it
    // and why the banner cannot answer this. Both are kept: what the flag
    // amounts to, and whether the file said anything at all.
    let isDefault = true;
    let declaresDefault = false;
    // Defaults straight from RFC 9559: a track is usable and not forced unless
    // the file says otherwise, and the impaired flags are absent until claimed.
    let isEnabled = true;
    let isForced = false;
    let isHearingImpaired = false;
    let languageBcp47 = "";
    for (const field of iterateElements(head, entry.dataOffset, entryEnd)) {
      if (field.id === ID_TRACK_NUMBER) {
        trackNumber = readUint(head, field.dataOffset, field.size);
      } else if (field.id === ID_TRACK_TYPE) {
        type = readUint(head, field.dataOffset, field.size);
      } else if (field.id === ID_CODEC_ID) {
        codecId = readString(head, field);
      } else if (field.id === ID_LANGUAGE) {
        language = readString(head, field);
      } else if (field.id === ID_LANGUAGE_BCP47) {
        languageBcp47 = readString(head, field);
      } else if (field.id === ID_NAME) {
        name = readString(head, field);
      } else if (field.id === ID_FLAG_DEFAULT) {
        isDefault = readUint(head, field.dataOffset, field.size) === 1;
        declaresDefault = true;
      } else if (field.id === ID_FLAG_ENABLED) {
        // An element written with zero length carries its default, which for
        // this one is 1 — so an empty element must not read as "unusable", and
        // neither must a value outside the declared 0-1 range. Only an explicit
        // zero takes a track away.
        isEnabled = field.size === 0 || readUint(head, field.dataOffset, field.size) !== 0;
      } else if (field.id === ID_FLAG_FORCED) {
        isForced = field.size > 0 && readUint(head, field.dataOffset, field.size) !== 0;
      } else if (field.id === ID_FLAG_HEARING_IMPAIRED) {
        isHearingImpaired = field.size > 0 && readUint(head, field.dataOffset, field.size) !== 0;
      } else if (field.id === ID_CODEC_PRIVATE) {
        codecPrivate = head.toString("base64", field.dataOffset, field.dataOffset + field.size);
      }
    }
    if (type !== TRACK_TYPE_SUBTITLE || trackNumber === null) {
      continue;
    }
    // A track the file marks unusable is still COUNTED. FlagEnabled says "the
    // track is usable", and a player should not offer it — but ffmpeg does not
    // drop it: `matroskadec.c` parses `MATROSKA_ID_TRACKFLAGENABLED` as
    // `EBML_NONE`, reading the element and keeping nothing, so the stream is
    // created and numbered like any other. Leaving it out of this list would
    // therefore shift `declaredIndex` off ffmpeg's `0:s:N` for every track
    // after it, which is the numbering defect this file was fixed for a day
    // earlier. It is counted here and refused where it is offered instead.
    //
    // `language` here stays the three-letter code, because this list exists to
    // be lined up against ffmpeg's banner, which prints that code. The RFC 5646
    // tag rides beside it for whoever displays the track.
    declared.push({
      trackNumber,
      codecId,
      language,
      languageBcp47,
      name,
      isDefault,
      declaresDefault,
      isEnabled,
      isForced,
      isHearingImpaired
    });
    if (!TEXT_CODECS.has(codecId) || !isEnabled) {
      continue;
    }
    tracks.push({
      trackNumber,
      declaredIndex: declared.length - 1,
      codecId,
      // This list is ours and is not compared with ffmpeg's, so it carries the
      // language the file states most precisely: where RFC 5646 is written, the
      // three-letter code MUST be ignored.
      language: languageBcp47 || language,
      languageBcp47,
      name,
      isDefault,
      isForced,
      isHearingImpaired,
      codecPrivate,
      clusterPositions: []
    });
  }
  if (tracks.length === 0) {
    return { tracks, declared, secondsPerTick: scale / 1e9, segmentDataOffset: base };
  }

  // Where the clusters holding those tracks are. A file that indexes only its
  // picture leaves these empty, which is not a failure: the caller then reads
  // the clusters the viewer's own playback brings in.
  const seekHead = findElement(head, ID_SEEK_HEAD, [], base);
  let cuesRelative;
  if (seekHead) {
    const seekEnd = Math.min(head.length, seekHead.dataOffset + seekHead.size);
    for (const seek of iterateElements(head, seekHead.dataOffset, seekEnd)) {
      if (seek.id !== ID_SEEK) {
        continue;
      }
      let target = null;
      let position = null;
      for (const field of iterateElements(head, seek.dataOffset, Math.min(seekEnd, seek.dataOffset + seek.size))) {
        if (field.id === ID_SEEK_ID) {
          target = readUint(head, field.dataOffset, field.size);
        } else if (field.id === ID_SEEK_POSITION) {
          position = readUint(head, field.dataOffset, field.size);
        }
      }
      if (target === ID_CUES && position !== null) {
        cuesRelative = position;
      }
    }
  }
  if (cuesRelative !== undefined) {
    const cuesAt = base + cuesRelative;
    if (cuesAt > 0 && cuesAt < fileSize) {
      const chunk = await readRange(cuesAt, Math.min(fileSize - 1, cuesAt + MAX_CUES_BYTES));
      const element = chunk && [...iterateElements(chunk, 0, chunk.length)][0];
      if (element && element.id === ID_CUES) {
        const body = chunk.subarray(element.dataOffset, Math.min(chunk.length, element.dataOffset + element.size));
        const byTrack = new Map(tracks.map((track) => [track.trackNumber, new Set()]));
        for (const point of iterateElements(body, 0, body.length)) {
          if (point.id !== ID_CUE_POINT) {
            continue;
          }
          const pointEnd = Math.min(body.length, point.dataOffset + point.size);
          for (const field of iterateElements(body, point.dataOffset, pointEnd)) {
            if (field.id !== ID_CUE_TRACK_POSITIONS) {
              continue;
            }
            let cueTrack = null;
            let position = null;
            for (const inner of iterateElements(body, field.dataOffset, Math.min(pointEnd, field.dataOffset + field.size))) {
              if (inner.id === ID_CUE_TRACK) {
                cueTrack = readUint(body, inner.dataOffset, inner.size);
              } else if (inner.id === ID_CUE_CLUSTER_POSITION) {
                position = readUint(body, inner.dataOffset, inner.size);
              }
            }
            if (position !== null && byTrack.has(cueTrack)) {
              byTrack.get(cueTrack).add(base + position);
            }
          }
        }
        for (const track of tracks) {
          track.clusterPositions = [...byTrack.get(track.trackNumber)].sort((left, right) => left - right);
        }
      }
    }
  }
  return { tracks, declared, secondsPerTick: scale / 1e9, segmentDataOffset: base };
}

/**
 * The cues of one track inside one cluster.
 *
 * @param {Buffer} bytes - The cluster, from its own element header onward.
 * @param {number} trackNumber
 * @param {number} secondsPerTick
 * @returns {{ startSeconds: number, endSeconds: number | null, text: string }[]}
 */
function harvestCluster(bytes, trackNumber, secondsPerTick) {
  const header = [...iterateElements(bytes, 0, bytes.length)][0];
  if (!header) {
    return [];
  }
  const blocks = blocksOfTrack(
    bytes,
    { dataOffset: header.dataOffset, size: header.size },
    trackNumber,
    secondsPerTick
  );
  // The payload is handed on as BYTES. What those bytes mean — which of them
  // are the text and which are the eight fields Matroska puts before it — is
  // stated by the container's specification and answered by
  // `MatroskaContainer.cueTextOf`, not here: this function's subject is where a
  // block sits and how long it lasts.
  return blocks.map((block) => ({
    startSeconds: block.startSeconds,
    endSeconds: block.durationSeconds === null ? null : block.startSeconds + block.durationSeconds,
    payload: block.payload
  }));
}
