/**
 * @file Base Container — abstract per RFC 9559 / ISO 14496-12.
 *
 * A Container knows how to read its own format's track table and index.
 * Concrete containers (MatroskaContainer, Mp4Container, AviContainer) implement
 * spec-specific parsing. All byte access goes through `readRange(start,end)` so
 * the class works over torrent piece windows.
 *
 * Spec refs:
 *  - Matroska RFC 9559 §5: EBML, Segment, SeekHead, Tracks, Cues, Clusters
 *  - MP4 ISO/IEC 14496-12 §8: ftyp, moov, trak, tkhd, mdhd, hdlr, elng, stbl
 *  - AVI RIFF §: LIST hdrl, idx1
 */

export class Container {
  /**
   * @param {object} params
   * @param {(start:number,end:number)=>Promise<Buffer|null>} params.readRange
   * @param {number} params.fileSize
   * @param {string} [params.label]
   */
  constructor({ readRange, fileSize, label = "" }) {
    this.readRange = readRange;
    this.fileSize = fileSize;
    this.label = label;
  }

  /** @returns {string} Human name: "matroska" | "mp4" | "avi" | "unknown" */
  get formatName() {
    return "unknown";
  }

  /** Whether `head` (first bytes) looks like this container. */
  static detect(_head) {
    return false;
  }

  /**
   * All tracks declared by the container, in container order.
   * Includes disabled tracks (isEnabled=false) to preserve declaredIndex alignment with ffmpeg.
   * @returns {Promise<import("../tracks/index.js").ContainerTrack[]>}
   */
  async readTracks() {
    throw new Error("readTracks not implemented");
  }

  /**
   * Keyframe times for the video track, ascending seconds. Null when index absent (MPEG-TS, fragmented MP4, truncated).
   * @returns {Promise<{times:number[],tolerance:number}|null>}
   */
  async readKeyframeIndex() {
    return null;
  }

  /**
   * Subtitle-specific: where cues live (Matroska cluster positions or MP4 sample ranges).
   * Returned via track objects' clusterPositions/samples, so base has no extra method — tracks carry it.
   */

  /**
   * The TEXT FIELD of one subtitle cue, taken out of this container's framing.
   *
   * How a cue's bytes are wrapped is stated by the container's own
   * specification, so each subclass answers for itself: Matroska reorders an ASS
   * dialogue row, drops its two timing fields and prepends a read order
   * (`matroska.org/technical/subtitles.html`); an MP4 prefixes a `tx3g` sample
   * with its length (ISO/IEC 14496-12 §12.6); a subtitle FILE states its own
   * field order in `[Events]`. None of that is a fact about the subtitle format,
   * and the format's own markup — `{\pos(…)}`, `\N` — is not a fact about the
   * container. The second half is `tracks/subtitle-markup.js`; this is the
   * first, and the two are applied in that order.
   *
   * Static because de-framing reads no instance state: a caller that has bytes
   * and knows the format needs no container built over the whole file. The
   * instance form below exists so a caller that DOES hold a container gets the
   * right answer without naming the subclass.
   *
   * @param {Buffer} _payload - The cue's bytes as the container stores them.
   * @param {string} _codecId - CodecID / sample entry type / file extension.
   * @returns {string} The text field, markup still in place.
   */
  static cueTextOf(_payload, _codecId) {
    throw new Error("cueTextOf not implemented");
  }

  /**
   * @param {Buffer} payload
   * @param {string} codecId
   * @returns {string}
   */
  cueTextOf(payload, codecId) {
    return /** @type {typeof Container} */ (this.constructor).cueTextOf(payload, codecId);
  }
}
