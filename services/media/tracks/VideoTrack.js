/**
 * @file Video track — extends ContainerTrack with video-specific container fields.
 *
 * Matroska RFC 9559: TrackEntry/Video (PixelWidth/Height, DisplayWidth/Height)
 * MP4 ISO/IEC 14496-12: tkhd width/height, mdhd timescale, stsd sample entry
 *   (avc1/hev1/etc.), stss/stts for keyframes, colr for HDR.
 * No FlagForced / FlagHearingImpaired — those are subtitle-only per spec.
 */

import { ContainerTrack } from "./ContainerTrack.js";

export class VideoTrack extends ContainerTrack {
  /**
   * @param {object} params - See ContainerTrack plus:
   * @param {number | null} params.width - Coded width (PixelWidth / tkhd width).
   * @param {number | null} params.height - Coded height.
   * @param {number | null} params.displayWidth
   * @param {number | null} params.displayHeight
   * @param {number | null} params.fps - From container when available (otherwise from ffmpeg banner elsewhere).
   * @param {boolean} params.isHdr - From container colr / ffmpeg detection later.
   * @param {number | null} params.bitDepth
   */
  constructor(params) {
    super({ ...params, type: "video" });
    this.width = Number.isFinite(params.width) ? params.width : null;
    this.height = Number.isFinite(params.height) ? params.height : null;
    this.displayWidth = Number.isFinite(params.displayWidth) ? params.displayWidth : null;
    this.displayHeight = Number.isFinite(params.displayHeight) ? params.displayHeight : null;
    this.fps = Number.isFinite(params.fps) ? params.fps : null;
    this.isHdr = params.isHdr === true;
    this.bitDepth = Number.isFinite(params.bitDepth) ? params.bitDepth : null;
  }
}
