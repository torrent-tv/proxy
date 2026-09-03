/**
 * @file Text subtitle track — convertible to WebVTT.
 *
 * Matroska: S_TEXT/UTF8, S_TEXT/ASS, S_TEXT/SSA, S_TEXT/WEBVTT (RFC 9559)
 * MP4: tx3g, text, wvtt (stpp/TTML is NOT text for this pipeline — excluded)
 * External files: .srt .ass .ssa .vtt — modelled as TextSubtitleTrack with no container backing.
 */

import { SubtitleTrack } from "./SubtitleTrack.js";
import { markupKindOf, plainCueText } from "./subtitle-markup.js";

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

  /** Which markup this track's cue text carries — see `subtitle-markup.js`. */
  get markupKind() {
    return markupKindOf(this.textCodec);
  }

  /**
   * The visible text of one of this track's cues.
   *
   * @param {string} textField - The cue's text field, already out of its
   *   container's framing. This method knows the codec and not the container,
   *   which is why it cannot be handed a whole dialogue row.
   * @returns {string}
   */
  plainText(textField) {
    return plainCueText(textField, this.textCodec);
  }

  static isTextCodec(codecId) {
    return TEXT_CODECS_MATROSKA.has(codecId) || TEXT_FORMATS_MP4.has(codecId);
  }
}

export { TEXT_CODECS_MATROSKA, TEXT_FORMATS_MP4 };
