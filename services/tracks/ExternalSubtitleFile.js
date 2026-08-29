/**
 * @file External subtitle file — not part of the media container, but shares TextSubtitleTrack API.
 *
 * A standalone .srt/.ass/.ssa/.vtt file beside the video in the same torrent.
 * Has no container flags; language comes from filename suffix or franc detection.
 */

export class ExternalSubtitleFile {
  /**
   * @param {object} params
   * @param {string} params.fileName
   * @param {number} params.fileIndex - Torrent file index.
   * @param {string} params.extension - ".srt" etc. lowercased.
   * @param {string} params.language - Hint from filename or "".
   */
  constructor({ fileName, fileIndex, extension, language = "" }) {
    this.fileName = fileName;
    this.fileIndex = fileIndex;
    this.extension = extension;
    this.language = language;
    this.type = "external-subtitle";
  }

  isTextBased() {
    return true;
  }
}
