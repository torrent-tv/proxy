import { Bits } from "./h264-configuration.js";

/** HEVC first-slice picture order, using the previous reference TemporalId 0 picture. */
export class HevcPictureOrder {
  #sequence;
  #picture;
  #lsb = 0;
  #msb = 0;
  #first = true;

  constructor(sequence, pps) {
    if (!Number.isSafeInteger(sequence.orderBits) || sequence.orderBits < 4 || sequence.orderBits > 16 ||
      pps.length < 3 || ((pps[0] >> 1) & 63) !== 34 || (pps[0] & 129) || (pps[1] >> 3) || !(pps[1] & 7)) {
      throw new Error("HEVC picture-order declarations are invalid.");
    }
    this.#sequence = sequence;
    const bits = new Bits(rbsp(pps), "HEVC");
    const id = bits.ue(), sequenceId = bits.ue();
    if (id > 63 || sequenceId > 15) throw new Error("HEVC PPS identity is invalid.");
    const dependentSlices = bits.uint(1), outputFlag = bits.uint(1), extraBits = bits.uint(3);
    this.#picture = { id, dependentSlices, outputFlag, extraBits };
  }

  read(nal) {
    const type = (nal[0] >> 1) & 63, temporalId = (nal[1] & 7) - 1;
    if (type > 31 || temporalId < 0 || (nal[0] & 129) || (nal[1] >> 3)) throw new Error("HEVC slice identity is invalid.");
    const bits = new Bits(rbsp(nal), "HEVC");
    if (!bits.uint(1)) throw new Error("HEVC picture order requires its first slice.");
    const irap = type >= 16 && type <= 23;
    if (irap) bits.uint(1);
    if (bits.ue() !== this.#picture.id) throw new Error("HEVC slice names an undeclared PPS.");
    bits.uint(this.#picture.extraBits);
    if (bits.ue() > 2) throw new Error("HEVC slice type is invalid.");
    if (this.#picture.outputFlag) bits.uint(1);
    if (this.#sequence.separateColourPlane) bits.uint(2);
    const idr = type === 19 || type === 20;
    const lsb = idr ? 0 : bits.uint(this.#sequence.orderBits), cycle = 2 ** this.#sequence.orderBits;
    const reset = idr || (type >= 16 && type <= 18) || (irap && this.#first);
    let msb = reset ? 0 : this.#msb;
    if (!reset) {
      if (lsb < this.#lsb && this.#lsb - lsb >= cycle / 2) msb += cycle;
      else if (lsb > this.#lsb && lsb - this.#lsb > cycle / 2) msb -= cycle;
    }
    if (temporalId === 0 && ![0, 2, 4, 6, 7, 8, 9].includes(type)) {
      this.#lsb = lsb;
      this.#msb = msb;
    }
    this.#first = false;
    return { count: msb + lsb, reset };
  }
}

function rbsp(nal) {
  const bytes = [];
  for (let at = 2, zeroes = 0; at < nal.length; at++) {
    const byte = nal[at];
    if (zeroes >= 2 && byte === 3) {
      if (at + 1 >= nal.length || nal[at + 1] > 3) throw new Error("HEVC escape byte is invalid.");
      zeroes = 0;
      continue;
    }
    bytes.push(byte);
    zeroes = byte === 0 ? zeroes + 1 : 0;
  }
  return Buffer.from(bytes);
}
