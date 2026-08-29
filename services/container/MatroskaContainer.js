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
import { findElement, iterateElements, readUint } from "../container-index/ebml-reader.js";

const HEAD_BYTES = 64 * 1024;
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
          case ID_FLAG_DEFAULT: isDefault = readUint(head, f.dataOffset, f.size) === 1; declaresDefault = true; break;
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

  async readKeyframeIndex() {
    const times = await readMatroskaKeyframeTimes(this.readRange, this.fileSize);
    if (!times) return null;
    if (Array.isArray(times)) return { times, tolerance: 0 };
    return times;
  }
}
