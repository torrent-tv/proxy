/**
 * @file Image subtitle track — PGS / VobSub / subp / clcp. Not convertible to WebVTT.
 *
 * Matroska: S_HDMV/PGS, S_VOBSUB, S_IMAGE/BMP etc.
 * MP4: stpp is TTML (XML, excluded from Text), subp (VobSub), clcp (closed captions)
 * Kept in the model only to preserve declaredIndex alignment with ffmpeg 0:s:N.
 */

import { SubtitleTrack } from "./SubtitleTrack.js";

export class ImageSubtitleTrack extends SubtitleTrack {
  constructor(params) {
    super(params);
  }

  isTextBased() {
    return false;
  }
}
