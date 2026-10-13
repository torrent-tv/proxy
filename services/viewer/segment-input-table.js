/**
 * @file Which source bytes each segment of an output reads, as the download
 * map's pass worked them out (torrent-tv/meta#178).
 *
 * A fact of the file and the output, kept apart from what the torrent is told:
 * the far part of a film is stated to the torrent as windows of a band
 * (`download-bands.js`), and the forecast still has to find every segment's own
 * bytes (`ViewerRequests` `#segmentsOf`). It used to read them off the zones
 * sent, which named every segment.
 */

export class SegmentInputTable {
  /** `sourceKey` → output → segment → file → its ranges. @type {Map<string, Map<string, Map<number, Map<number, { joined: Array<[number, number]>, ranges: Array<{ start: number, end: number }> }>>>>} */
  #bySource = new Map();

  /**
   * @param {string} sourceKey
   * @param {number} fileIndex
   * @param {string} outputKey
   * @param {number} index
   * @param {Array<[number, number]>} joined - Inclusive ranges.
   */
  set(sourceKey, fileIndex, outputKey, index, joined) {
    let outputs = this.#bySource.get(sourceKey);
    if (!outputs) this.#bySource.set(sourceKey, outputs = new Map());
    let segments = outputs.get(outputKey);
    if (!segments) outputs.set(outputKey, segments = new Map());
    let files = segments.get(index);
    if (!files) segments.set(index, files = new Map());
    // The same reading keeps its list: whoever compares inputs compares them by it.
    if (files.get(fileIndex)?.joined === joined) return;
    files.set(fileIndex, { joined, ranges: joined.map(([start, end]) => ({ start, end: end + 1 })) });
  }

  /**
   * The bytes one segment reads, by file, or null where none are known.
   *
   * @param {string} sourceKey
   * @param {string} outputKey
   * @param {number} index
   * @returns {Array<{ sourceId: string, ranges: Array<{ start: number, end: number }> }> | null}
   */
  inputsFor(sourceKey, outputKey, index) {
    const files = this.#bySource.get(sourceKey)?.get(outputKey)?.get(index);
    if (!files?.size) return null;
    return [...files].map(([fileIndex, { ranges }]) => ({ sourceId: `${sourceKey}:${fileIndex}`, ranges }));
  }

  /** @param {string} sourceKey */
  forget(sourceKey) {
    this.#bySource.delete(sourceKey);
  }
}
