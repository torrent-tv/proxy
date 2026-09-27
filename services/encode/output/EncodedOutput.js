/**
 * @file One output that exists on this proxy.
 *
 * What it holds are the facts born with the output and gone with it: its
 * identity and format (`spec`), the file it is made from, where that file is
 * cut, the container its pieces are in, the shape the encoder is given, and the
 * playlist the player is told. Two things it deliberately does NOT hold,
 * decided with the user 2026-09-16: what has been produced — the segment store
 * owns that — and which encoders are running — the encoding orchestrator owns
 * that. An output without a live record does not make its pieces invalid;
 * pieces are valid while they exist.
 *
 */

export class EncodedOutput {
  /**
   * @param {object} params
   * @param {string} params.id - The output's name, derived from its key.
   * @param {import("./OutputSpec.js").OutputSpec} params.spec
   * @param {object} params.file - The source file, one object per file.
   * @param {object} params.keyframes - That file's keyframe table, held rather
   *   than copied so a table read later still reaches it.
   * @param {object} params.timeline - Where that file is cut, shared by every
   *   output of it.
   * @param {object} params.segmentFormat - The container the pieces are in.
   * @param {import("./Output.js").Output} params.output - The format in the
   *   terms the encoder is given, and how its pieces land.
   * @param {boolean} params.useSyntheticPlaylist - The playlist is built from
   *   the probed duration rather than written by the encoder.
   * @param {string} params.playlistText
   * @param {number | undefined} params.variantHeight - The height a step is
   *   addressed by, when it is produced at exactly that size.
   */
  constructor({ id, spec, file, keyframes, timeline, segmentFormat, output, useSyntheticPlaylist, playlistText, variantHeight }) {
    this.id = id;
    this.spec = spec;
    this.file = file;
    this.keyframes = keyframes;
    this.timeline = timeline;
    this.segmentFormat = segmentFormat;
    this.output = output;
    this.useSyntheticPlaylist = useSyntheticPlaylist === true;
    this.playlistText = typeof playlistText === "string" ? playlistText : "";
    this.variantHeight = variantHeight;

  }

  /**
   * The address of this output's pieces. Derived, so it cannot say anything
   * the spec does not.
   *
   * @returns {string}
   */
  get outputKey() {
    return this.spec.toKey();
  }
}
