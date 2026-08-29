/**
 * @file Text subtitle track — convertible to WebVTT.
 *
 * Matroska: S_TEXT/UTF8, S_TEXT/ASS, S_TEXT/SSA, S_TEXT/WEBVTT (RFC 9559)
 * MP4: tx3g, text, wvtt (stpp/TTML is NOT text for this pipeline — excluded)
 * External files: .srt .ass .ssa .vtt — modelled as TextSubtitleTrack with no container backing.
 */

import { SubtitleTrack } from "./SubtitleTrack.js";

const TEXT_CODECS_MATROSKA = new Set(["S_TEXT/UTF8", "S_TEXT/ASS", "S_TEXT/SSA", "S_TEXT/WEBVTT"]);
const TEXT_FORMATS_MP4 = new Set(["tx3g", "text", "wvtt"]);

export class TextSubtitleTrack extends SubtitleTrack {
  constructor(params) {
    super(params);
    this.textCodec = params.codecId ?? "";
  }

  isTextBased() {
    return true;
  }

  static isTextCodec(codecId) {
    return TEXT_CODECS_MATROSKA.has(codecId) || TEXT_FORMATS_MP4.has(codecId);
  }
}

export { TEXT_CODECS_MATROSKA, TEXT_FORMATS_MP4 };
