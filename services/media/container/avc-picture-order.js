import { Bits, unescapeNal } from "./h264-configuration.js";

/** AVC frame picture-order counts, retaining reference and frame-number wraps. */
export class AvcPictureOrder {
  #params;
  #msb = 0;
  #lsb = 0;
  #frameNumber = 0;
  #frameOffset = 0;
  constructor(params) { this.#params = params; }
  read(nal) {
    const params = this.#params;
    if (![0, 1, 2].includes(params.type) || params.separateColourPlane || params.frameNumberBits > 16 ||
        (params.type === 0 && params.pocBits > 16) ||
        (params.type === 1 && !Array.isArray(params.referenceOffsets))) {
      throw new Error("AVC missing timestamps require supported frame picture-order declarations.");
    }
    const bits = new Bits(unescapeNal(nal));
    bits.ue(); bits.ue(); bits.ue();
    const frameNumber = bits.uint(params.frameNumberBits);
    const idr = (nal[0] & 31) === 5;
    if (idr) { bits.ue(); this.#msb = 0; this.#lsb = 0; this.#frameNumber = 0; this.#frameOffset = 0; }
    if (params.type !== 0) {
      if (!idr && frameNumber < this.#frameNumber) this.#frameOffset += 2 ** params.frameNumberBits;
      this.#frameNumber = frameNumber;
      const reference = (nal[0] & 0x60) !== 0;
      const absolute = this.#frameOffset + frameNumber;
      if (params.type === 2) return { count: idr ? 0 : 2 * absolute - (reference ? 0 : 1), idr };
      const cycle = params.referenceOffsets;
      const frame = cycle.length ? Math.max(0, absolute - (reference ? 0 : 1)) : 0;
      let expected = 0;
      if (frame > 0) {
        expected = Math.floor((frame - 1) / cycle.length) * cycle.reduce((sum, value) => sum + value, 0);
        for (let index = 0; index <= (frame - 1) % cycle.length; index++) expected += cycle[index];
      }
      if (!reference) expected += params.nonReferenceOffset;
      const top = expected + (params.deltaAlwaysZero ? 0 : bits.se());
      const bottom = top + params.bottomOffset +
        (!params.deltaAlwaysZero && params.bottomFieldOrderPresent ? bits.se() : 0);
      return { count: Math.min(top, bottom), idr };
    }
    const lsb = bits.uint(params.pocBits), cycle = 2 ** params.pocBits;
    let msb = this.#msb;
    if (lsb < this.#lsb && this.#lsb - lsb >= cycle / 2) msb += cycle;
    else if (lsb > this.#lsb && lsb - this.#lsb > cycle / 2) msb -= cycle;
    const bottom = params.bottomFieldOrderPresent ? bits.se() : 0;
    if (nal[0] & 0x60) { this.#msb = msb; this.#lsb = lsb; }
    return { count: Math.min(msb + lsb, msb + lsb + bottom), idr };
  }
}
