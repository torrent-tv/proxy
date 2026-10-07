/** H.264 SPS facts required to bound decode reordering and describe frames. */
export function h264Configuration(avcc) {
  if (!Buffer.isBuffer(avcc) || avcc.length < 7 || avcc[0] !== 1) throw new Error("AVC decoder configuration is invalid.");
  if ((avcc[4] & 3) === 2) throw new Error("AVC NAL length size is reserved.");
  const count = avcc[5] & 31;
  if (!count) throw new Error("AVC configuration declares no SPS.");
  let at = 6;
  const sequences = [];
  for (let index = 0; index < count; index++) {
    if (at + 2 > avcc.length) throw new Error("AVC SPS length is truncated.");
    const size = avcc.readUInt16BE(at); at += 2;
    if (!size || at + size > avcc.length) throw new Error("AVC SPS exceeds its configuration.");
    sequences.push(readSps(avcc.subarray(at, at + size))); at += size;
  }
  const first = sequences[0];
  if (sequences.some(sequence => sequence.width !== first.width || sequence.height !== first.height || sequence.bitDepth !== first.bitDepth)) {
    throw new Error("AVC SPS changes require packet-specific decoder configuration.");
  }
  return { ...first, reorderDepth: Math.max(...sequences.map(sequence => sequence.reorderDepth)), nalLengthBytes: (avcc[4] & 3) + 1 };
}

function readSps(nal, includeOrder = false) {
  if ((nal[0] & 31) !== 7 || nal[0] & 128) throw new Error("AVC configuration entry is not an SPS.");
  const bits = new Bits(unescapeNal(nal));
  const profile = bits.uint(8), constraints = bits.uint(8), level = bits.uint(8);
  bits.ue();
  let chroma = 1, separate = 0, depth = 8;
  if ([44, 83, 86, 100, 110, 118, 122, 128, 134, 135, 138, 139, 244].includes(profile)) {
    chroma = bits.ue();
    if (chroma > 3) throw new Error("AVC chroma format is invalid.");
    if (chroma === 3) separate = bits.uint(1);
    depth += bits.ue();
    const chromaDepth = 8 + bits.ue();
    if (depth > 14 || chromaDepth > 14) throw new Error("AVC bit depth is invalid.");
    bits.uint(1);
    if (bits.uint(1)) {
      for (let index = 0; index < (chroma === 3 ? 12 : 8); index++) {
        if (!bits.uint(1)) continue;
        let last = 8, next = 8;
        for (let sample = 0; sample < (index < 6 ? 16 : 64); sample++) {
          if (next) next = (last + bits.se() + 256) % 256;
          last = next || last;
        }
      }
    }
  }
  const frameNumberBits = bits.ue() + 4;
  const order = bits.ue();
  let pocBits = null;
  let orderCycle = null;
  if (order === 0) pocBits = bits.ue() + 4;
  else if (order === 1) {
    const deltaAlwaysZero = bits.uint(1) === 1, nonReferenceOffset = bits.se(), bottomOffset = bits.se();
    const cycle = bits.ue();
    if (cycle > 255) throw new Error("AVC POC cycle is invalid.");
    const referenceOffsets = [];
    for (let index = 0; index < cycle; index++) referenceOffsets.push(bits.se());
    orderCycle = { deltaAlwaysZero, nonReferenceOffset, bottomOffset, referenceOffsets };
  } else if (order !== 2) throw new Error("AVC picture order count type is invalid.");
  const references = bits.ue();
  if (references > 16) throw new Error("AVC reference frame count is invalid.");
  bits.uint(1);
  const columns = bits.ue() + 1, rows = bits.ue() + 1;
  const frameOnly = bits.uint(1);
  const pictureMacroblocks = columns * rows * (2 - frameOnly);
  if (!Number.isSafeInteger(pictureMacroblocks) || pictureMacroblocks > 696320) {
    throw new Error("AVC picture exceeds the supported decode buffer bound.");
  }
  if (!frameOnly) bits.uint(1);
  bits.uint(1);
  let left = 0, right = 0, top = 0, bottom = 0;
  if (bits.uint(1)) { left = bits.ue(); right = bits.ue(); top = bits.ue(); bottom = bits.ue(); }
  let fps = null, reorderDepth = null, timingTickSeconds = null, picStructPresent = false, seiDelayBits = 0;
  if (bits.uint(1)) {
    if (bits.uint(1)) { if (bits.uint(8) === 255) { bits.uint(16); bits.uint(16); } }
    if (bits.uint(1)) bits.uint(1);
    if (bits.uint(1)) { bits.uint(3); bits.uint(1); if (bits.uint(1)) { bits.uint(8); bits.uint(8); bits.uint(8); } }
    if (bits.uint(1)) { bits.ue(); bits.ue(); }
    if (bits.uint(1)) {
      const tick = bits.uint(32), scale = bits.uint(32), fixed = bits.uint(1);
      if (!tick || !scale) throw new Error("AVC timing declaration is invalid.");
      timingTickSeconds = tick / scale;
      if (fixed) fps = scale / (2 * tick);
    }
    const nalHrd = bits.uint(1);
    const nalDelay = nalHrd ? hrd(bits) : 0;
    const vclHrd = bits.uint(1);
    const vclDelay = vclHrd ? hrd(bits) : 0;
    seiDelayBits = nalHrd ? nalDelay : vclDelay;
    if (nalHrd || vclHrd) bits.uint(1);
    picStructPresent = bits.uint(1) === 1;
    if (bits.uint(1)) {
      bits.uint(1); bits.ue(); bits.ue(); bits.ue(); bits.ue();
      reorderDepth = bits.ue();
      const buffering = bits.ue();
      if (reorderDepth > buffering || buffering > 16) throw new Error("AVC reorder buffer declaration is invalid.");
    }
  }
  if (reorderDepth === null) {
    const dpb = new Map([[10, 396], [11, 900], [12, 2376], [13, 2376], [20, 2376], [21, 4752], [22, 8100],
      [30, 8100], [31, 18000], [32, 20480], [40, 32768], [41, 32768], [42, 34816], [50, 110400],
      [51, 184320], [52, 184320], [60, 696320], [61, 696320], [62, 696320]]).get(level);
    if (!dpb) throw new Error("AVC level has no declared decode buffer bound.");
    const constrained = constraints & 16 && [44, 86, 100, 110, 122, 244].includes(profile);
    reorderDepth = constrained ? 0 : Math.min(16, Math.floor(dpb / pictureMacroblocks));
  }
  const arrayType = separate ? 0 : chroma;
  const cropX = arrayType === 1 || arrayType === 2 ? 2 : 1;
  const cropY = (arrayType === 1 ? 2 : 1) * (2 - frameOnly);
  const width = columns * 16 - (left + right) * cropX;
  const height = rows * 16 * (2 - frameOnly) - (top + bottom) * cropY;
  if (!(width > 0 && height > 0)) throw new Error("AVC crop exceeds its picture dimensions.");
  return { width, height, fps, bitDepth: depth, reorderDepth, frameOnly: frameOnly === 1, timingTickSeconds, picStructPresent, seiDelayBits,
    ...(includeOrder ? { pictureOrder: { type: order, frameNumberBits, pocBits, separateColourPlane: Boolean(separate),
      ...(orderCycle ?? {}) } } : {}) };
}

export function avcOrderParameters(sps, pps) {
  const facts = readSps(sps, true);
  const bits = new Bits(unescapeNal(pps));
  bits.ue(); bits.ue(); bits.uint(1);
  return { ...facts.pictureOrder, bottomFieldOrderPresent: bits.uint(1) === 1 };
}

/**
 * Remove every emulation prevention byte: a 0x03 after two zero bytes, whatever follows it. H.264 §7.4.1
 * forbids 0x000003 before a byte above 0x03, but encoders write it (LostFilm's LostCoder) and decoders drop
 * it (ffmpeg's ff_h2645_extract_rbsp), so refusing it refuses files every player plays.
 */
export function unescapeNal(nal) {
  const bytes = [];
  for (let at = 1, zeroes = 0; at < nal.length; at++) {
    const byte = nal[at];
    if (zeroes >= 2 && byte === 3) { zeroes = 0; continue; }
    bytes.push(byte);
    zeroes = byte === 0 ? zeroes + 1 : 0;
  }
  return Buffer.from(bytes);
}

/** Build the decoder declaration from the complete in-band SPS and PPS units. */
export function avcConfigurationFromUnits(sps, pps) {
  if (!Buffer.isBuffer(sps) || !Buffer.isBuffer(pps) || sps.length < 4 || !pps.length ||
    sps.length > 65535 || pps.length > 65535 || (pps[0] & 31) !== 8) throw new Error("AVC parameter-set lengths are invalid.");
  const header = Buffer.from([1, sps[1], sps[2], sps[3], 0xff, 0xe1, sps.length >> 8, sps.length & 255]);
  const tail = Buffer.from([1, pps.length >> 8, pps.length & 255]);
  const bytes = Buffer.concat([header, sps, tail, pps]);
  return { ...h264Configuration(bytes), codecPrivateB64: bytes.toString("base64"), packetFraming: "annex-b" };
}

function hrd(bits) {
  const count = bits.ue() + 1;
  if (count > 32) throw new Error("AVC HRD entry count is invalid.");
  bits.uint(4); bits.uint(4);
  for (let index = 0; index < count; index++) { bits.ue(); bits.ue(); bits.uint(1); }
  bits.uint(5);
  const removal = bits.uint(5) + 1, output = bits.uint(5) + 1;
  bits.uint(5);
  return removal + output;
}

export class Bits {
  constructor(bytes, label = "AVC") { this.bytes = bytes; this.at = 0; this.label = label; }
  uint(count) {
    if (count < 0 || count > 32 || this.at + count > this.bytes.length * 8) throw new Error(`${this.label} SPS bits are truncated.`);
    let value = 0;
    for (let index = 0; index < count; index++, this.at++) value = value * 2 + ((this.bytes[this.at >> 3] >> (7 - (this.at & 7))) & 1);
    return value;
  }
  ue() {
    let zeroes = 0;
    while (!this.uint(1)) if (++zeroes > 31) throw new Error(`${this.label} Exp-Golomb value is invalid.`);
    return 2 ** zeroes - 1 + this.uint(zeroes);
  }
  se() { const code = this.ue(); return code & 1 ? (code + 1) / 2 : -code / 2; }
}
