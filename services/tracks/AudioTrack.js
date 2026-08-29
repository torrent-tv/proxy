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

  /** Human label helper — commentary and descriptive audio must not look like main track. */
  audioRoleLabel() {
    if (this.isCommentary) return "commentary";
    if (this.isVisualImpaired) return "descriptive";
    if (this.isOriginal) return "original";
    return "";
  }
}
