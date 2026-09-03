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

import { ContainerTrack } from "./ContainerTrack.js";

/**
 * Codec identifiers as containers write them, against the name ffmpeg prints.
 *
 * Needed because the browser decides whether it can play a soundtrack from that
 * name, and for a sidecar file there is no ffmpeg banner to read it from — the
 * track came from the container's own table, where Matroska writes `A_AC3` and
 * MP4 writes `ac-3` for the thing ffmpeg calls `ac3`. Only what a soundtrack can
 * actually be is listed; an identifier not here is reported as it was written,
 * which the browser treats as one it does not know and therefore transcodes.
 */
const CODEC_NAMES = new Map([
  ["A_AAC", "aac"],
  ["A_AC3", "ac3"],
  ["A_EAC3", "eac3"],
  ["A_DTS", "dts"],
  ["A_FLAC", "flac"],
  ["A_OPUS", "opus"],
  ["A_VORBIS", "vorbis"],
  ["A_TRUEHD", "truehd"],
  ["A_MPEG/L3", "mp3"],
  ["A_MPEG/L2", "mp2"],
  ["A_ALAC", "alac"],
  ["mp4a", "aac"],
  ["ac-3", "ac3"],
  ["ec-3", "eac3"],
  ["alac", "alac"],
  ["opus", "opus"],
  ["Opus", "opus"],
  ["fLaC", "flac"],
  ["flac", "flac"]
]);

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
   */
  constructor(params) {
    super({ ...params, type: "audio" });
    this.isOriginal = params.isOriginal === true;
    this.isCommentary = params.isCommentary === true;
    this.isVisualImpaired = params.isVisualImpaired === true;
    this.channels = Number.isFinite(params.channels) ? params.channels : null;
    this.samplingFrequency = Number.isFinite(params.samplingFrequency) ? params.samplingFrequency : null;
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
      const known = CODEC_NAMES.get(codecId);
      if (known) {
        return known;
      }
      // Matroska allows a suffix — `A_AAC/MPEG4/LC`, `A_PCM/INT/LIT` — so the
      // family is what the first two segments say.
      const family = codecId.split("/").slice(0, 2).join("/");
      const byFamily = CODEC_NAMES.get(family) ?? CODEC_NAMES.get(codecId.split("/")[0]);
      if (byFamily) {
        return byFamily;
      }
      if (codecId.startsWith("A_PCM")) {
        return "pcm";
      }
      return codecId.toLowerCase();
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
