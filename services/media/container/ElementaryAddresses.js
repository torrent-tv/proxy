/**
 * Where the bytes of one elementary stream came from, and the PES stamps that arrived with them. A transport
 * stream is walked once and its packets discarded; this keeps just enough to give every access unit or audio
 * frame the exact source ranges of its bytes and the last stamp at or before its first byte.
 */
export class ElementaryAddresses {
  #mappings = [];
  #stamps = [];
  #incomplete;

  /** @param {string} incomplete - The error message when some byte of a range has no source address. */
  constructor(incomplete) {
    this.#incomplete = incomplete;
  }

  /** Bytes `from` up to `from + length` of the elementary stream sit at `sourceStart` of the file. */
  map(from, length, sourceStart) {
    this.#mappings.push({ from, to: from + length, sourceStart });
  }

  /** A stamp that arrived with the byte at elementary position `position`. */
  stamp(position, pts, dts = pts) {
    this.#stamps.push({ position, pts, dts });
  }

  /** @returns {{ position: number, pts: number, dts: number } | null} the last stamp at or before `position`, consumed with the ones before it */
  stampAt(position) {
    let latest = null;
    while (this.#stamps[0]?.position <= position) latest = this.#stamps.shift();
    return latest;
  }

  /** @returns {Array<[number, number]>} the inclusive source ranges of elementary bytes `from` up to `to` */
  ranges(from, to) {
    const ranges = this.#mappings.filter(mapping => mapping.from < to && mapping.to > from).map(mapping => [
      mapping.sourceStart + Math.max(from, mapping.from) - mapping.from,
      mapping.sourceStart + Math.min(to, mapping.to) - mapping.from - 1]);
    if (ranges.reduce((sum, [a, b]) => sum + b - a + 1, 0) !== to - from) throw new Error(this.#incomplete);
    return ranges;
  }

  /** Forget the addresses of every byte before `end`: nothing will ask for them again. */
  release(end) {
    this.#mappings = this.#mappings.filter(mapping => mapping.to > end);
  }
}
