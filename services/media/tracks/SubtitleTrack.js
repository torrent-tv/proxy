/**
 * @file Subtitle track — extends ContainerTrack with subtitle-only flags.
 *
 * Matroska RFC 9559:
 *  - FlagForced 0x55AA default 0, applies ONLY to subtitles.
 *  - FlagHearingImpaired 0x55AB, FlagVisualImpaired 0x55AC (SDH etc.)
 *  - FlagTextDescriptions 0x55AD also subtitle-related.
 *  - FlagEnabled 0xB9 still handled in base (disabled tracks counted but not offered).
 * MP4 ISO 14496-12 + Apple tx3g extension:
 *  - handler sbtl/subt/text/wvtt vs subp/clcp (image)
 *  - tx3g displayFlags forced bits 0x40000000 / 0x80000000 (unconfirmed primary source, carried as raw flags)
 */

import { ContainerTrack } from "./ContainerTrack.js";

export class SubtitleTrack extends ContainerTrack {
  /**
   * @param {object} params - See ContainerTrack plus:
   * @param {boolean} params.isForced - FlagForced (matroska) or tx3g forced display flag.
   * @param {boolean} params.isHearingImpaired - FlagHearingImpaired
   * @param {boolean} params.isVisualImpaired - FlagVisualImpaired
   * @param {number[]} params.clusterPositions - Matroska: file offsets of clusters whose CuePoints name this track (for push). Empty when indexless.
   * @param {Array<{offset:number,size:number,startSeconds:number,endSeconds:number}>} params.samples - MP4: per-cue byte ranges from sample tables.
   */
  constructor(params) {
    super({ ...params, type: "subtitle" });
    this.isForced = params.isForced === true;
    this.isHearingImpaired = params.isHearingImpaired === true;
    this.isVisualImpaired = params.isVisualImpaired === true;
    this.clusterPositions = Array.isArray(params.clusterPositions) ? params.clusterPositions : [];
    this.samples = Array.isArray(params.samples) ? params.samples : [];
  }

  /** Whether this track can be converted to WebVTT in current pipeline. Overridden by subclasses. */
  isTextBased() {
    return false;
  }
}
