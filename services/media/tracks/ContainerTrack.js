/**
 * @file Base container track — what the container declares about one track.
 *
 * Spec sources:
 *  - Matroska RFC 9559 §5.1.4.1 TrackEntry: TrackNumber(0xD7), TrackType(0x83),
 *    FlagEnabled(0xB9, default 1), FlagDefault(0x88, default 1),
 *    Language(0x22B59C, default "eng"), LanguageBCP47(0x22B59D, MUST ignore
 *    Language when present), Name(0x536E), CodecID(0x86), CodecPrivate(0x63A2).
 *  - MP4 ISO/IEC 14496-12 §8.3.2 tkhd (track_ID, flags track_enabled 0x000001,
 *    alternate_group), §8.4.2 mdhd (language, timescale), §8.4.5 hdlr
 *    (handler_type), §8.4.6 elng (extended language).
 *
 * Only fields that exist for EVERY track type live here. Type-specific flags
 * (FlagForced, FlagHearingImpaired, FlagVisualImpaired, FlagOriginal,
 * FlagCommentary) belong to subclasses — RFC 9559 states FlagForced "Applies
 * only to subtitles", so VideoTrack must not carry it.
 */

export class ContainerTrack {
  /**
   * @param {object} params
   * @param {number} params.trackNumber - Matroska TrackNumber or MP4 track_ID.
   * @param {number} params.declaredIndex - Position among ALL subtitle/audio/video tracks as container orders them; equals ffmpeg 0:s:N / 0:a:N for that type. Stable across image/text filtering.
   * @param {string} params.type - "video" | "audio" | "subtitle" | "other"
   * @param {string} params.codecId - Matroska CodecID or MP4 sample entry type (e.g. "S_TEXT/UTF8", "avc1", "mp4a").
   * @param {string} params.language - Three-letter code or packed mdhd code; empty when absent. For Matroska, when LanguageBCP47 is present this is the BCP47 value ignored per MUST — caller stores both, but `language` here is the resolved one.
   * @param {string} params.languageBcp47 - RFC 5646 tag from LanguageBCP47 / elng, or "".
   * @param {string} params.name - Track Name / title, or "".
   * @param {boolean} params.isEnabled - FlagEnabled / tkhd track_enabled. Default true per both specs. Matroska zero-length element means default, not disabled.
   * @param {boolean} params.isDefault - FlagDefault / tkhd? For MP4, derived from handler default? For Matroska, after applying default 1.
   * @param {boolean} params.declaresDefault - Whether FlagDefault was explicitly written (Matroska) or inferred. Needed because ffmpeg banner cannot distinguish "every track marked" from "no track marked".
   * @param {string} [params.codecPrivateB64] - Base64 of CodecPrivate (ASS header etc.), or "".
   * @param {number} [params.alternateGroup] - MP4 alternate_group (0 = no group).
   */
  constructor({
    trackNumber,
    declaredIndex,
    type,
    codecId,
    language,
    languageBcp47,
    name,
    isEnabled,
    isDefault,
    declaresDefault,
    codecPrivateB64 = "",
    alternateGroup = 0
  }) {
    this.trackNumber = trackNumber;
    this.declaredIndex = declaredIndex;
    this.type = type;
    this.codecId = codecId ?? "";
    this.language = language ?? "";
    this.languageBcp47 = languageBcp47 ?? "";
    this.name = name ?? "";
    this.isEnabled = isEnabled !== false;
    this.isDefault = isDefault === true;
    this.declaresDefault = declaresDefault === true;
    this.codecPrivateB64 = codecPrivateB64 ?? "";
    this.alternateGroup = Number.isFinite(alternateGroup) ? alternateGroup : 0;
  }

  /** Whether this track should be offered in UI menus. Base rule: disabled tracks hidden but still counted for declaredIndex. */
  isOfferable() {
    return this.isEnabled;
  }

  /** RFC 5646 tag wins over three-letter code when present. */
  resolvedLanguage() {
    return this.languageBcp47 || this.language;
  }
}
