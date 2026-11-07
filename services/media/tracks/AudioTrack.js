/**
 * @file Audio track — extends ContainerTrack with audio-specific flags.
 *
 * Matroska RFC 9559 §5.1.4.1:
 *  - FlagOriginal 0x55AE (default 0) — track is original language.
 *  - FlagCommentary 0x55AF — commentary track.
 *  - FlagVisualImpaired 0x55AC — audio description for visually impaired.
 *  - FlagTextDescriptions 0x55AD, FlagHearingImpaired etc. may also appear
 *    but the three above drive the audio menu (research/container-spec-conformance).
 * MP4 ISO/IEC 14496-12: tkhd alternate_group groups alternate audio tracks.
 */

import { codecParametersOf, peakKbpsOf } from "./audio-bound.js";
import { audioCodecName } from "./codec-names.js";
import { ContainerTrack } from "./ContainerTrack.js";

/**
 * Extensions of raw elementary streams, against the codec they carry.
 *
 * A bare `.ac3` has no track table to read, and its extension is the only thing
 * that states its codec — which for an elementary stream is exactly what the
 * extension means.
 */
const CODEC_BY_EXTENSION = new Map([
  [".aac", "aac"],
  [".ac3", "ac3"],
  [".eac3", "eac3"],
  [".dts", "dts"],
  [".dtshd", "dts"],
  [".flac", "flac"],
  [".mp3", "mp3"],
  [".mp2", "mp2"],
  [".opus", "opus"],
  [".ogg", "vorbis"],
  [".oga", "vorbis"],
  [".wav", "pcm"],
  [".thd", "truehd"],
  [".mlp", "truehd"],
  [".m4a", "aac"]
]);

export class AudioTrack extends ContainerTrack {
  /**
   * @param {object} params - See ContainerTrack plus:
   * @param {boolean} params.isOriginal - FlagOriginal
   * @param {boolean} params.isCommentary - FlagCommentary
   * @param {boolean} params.isVisualImpaired - FlagVisualImpaired / descriptive audio
   * @param {number | null} params.channels
   * @param {number | null} params.samplingFrequency
   * @param {number | null} [params.bitrateKbps] - The rate the file states for
   *   this track, in kbit/s: an average, not a bound.
   */
  constructor(params) {
    super({ ...params, type: "audio" });
    this.isOriginal = params.isOriginal === true;
    this.isCommentary = params.isCommentary === true;
    this.isVisualImpaired = params.isVisualImpaired === true;
    this.channels = Number.isFinite(params.channels) ? params.channels : null;
    this.samplingFrequency = Number.isFinite(params.samplingFrequency) ? params.samplingFrequency : null;
    this.bitrateKbps = Number.isFinite(params.bitrateKbps) && params.bitrateKbps > 0 ? params.bitrateKbps : null;
    this.bitDepth = Number.isSafeInteger(params.bitDepth) && params.bitDepth > 0 ? params.bitDepth : null;
    this.codecDelaySeconds = Number.isFinite(params.codecDelaySeconds) && params.codecDelaySeconds >= 0 ? params.codecDelaySeconds : 0;
    // What the codec is configured as, and the most that configuration allows
    // the track to carry — a statement of the file, read with the rest of the
    // track table (`audio-bound.js`). Own properties rather than getters, so a
    // copy of the track made field by field keeps them.
    this.codecParameters = codecParametersOf({
      codec: AudioTrack.codecNameOf(params),
      codecPrivateB64: params.codecPrivateB64,
      channels: this.channels,
      samplingFrequency: this.samplingFrequency
    });
    this.peakKbps = peakKbpsOf(this.codecParameters);
    if (this.codecParameters?.frameLength > 0 && this.codecParameters.sampleRate > 0) {
      this.defaultDurationSeconds = this.codecParameters.frameLength / this.codecParameters.sampleRate;
      this.seekPrerollSeconds = this.defaultDurationSeconds;
    }
    if (Number.isFinite(params.seekPrerollSeconds) && params.seekPrerollSeconds > 0) {
      this.seekPrerollSeconds = Math.max(this.seekPrerollSeconds ?? 0, params.seekPrerollSeconds);
    }
  }

  /**
   * The ffmpeg-side codec name for one track, from whatever the reading gave.
   *
   * @param {{ codec?: string, codecId?: string }} track
   * @param {string} [extension] - The sidecar file's extension, when the track
   *   came from a file with no readable table.
   * @returns {string}
   */
  static codecNameOf(track, extension = "") {
    const fromBanner = typeof track?.codec === "string" ? track.codec.trim() : "";
    if (fromBanner.length > 0) {
      return fromBanner.toLowerCase();
    }
    const codecId = typeof track?.codecId === "string" ? track.codecId.trim() : "";
    if (codecId.length > 0) {
      return audioCodecName(codecId);
    }
    return CODEC_BY_EXTENSION.get(extension) ?? "";
  }

  /** Human label helper — commentary and descriptive audio must not look like main track. */
  audioRoleLabel() {
    if (this.isCommentary) return "commentary";
    if (this.isVisualImpaired) return "descriptive";
    if (this.isOriginal) return "original";
    return "";
  }
}
