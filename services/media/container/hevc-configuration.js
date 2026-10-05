import { Bits } from "./h264-configuration.js";

/** HEVC SPS ordering limits are declared for every temporal sublayer (H.265 7.3.2.2). */
export function hevcConfiguration(hvcc) {
  if (!Buffer.isBuffer(hvcc) || hvcc.length < 23 || hvcc[0] !== 1) throw new Error("HEVC decoder configuration is invalid.");
  const sequences = [];
  let at = 23;
  for (let array = 0; array < hvcc[22]; array++) {
    if (at + 3 > hvcc.length) throw new Error("HEVC parameter-set array is truncated.");
    const type = hvcc[at++] & 63;
    const count = hvcc.readUInt16BE(at); at += 2;
    for (let index = 0; index < count; index++) {
      if (at + 2 > hvcc.length) throw new Error("HEVC parameter-set length is truncated.");
      const size = hvcc.readUInt16BE(at); at += 2;
      if (size < 2 || at + size > hvcc.length) throw new Error("HEVC parameter set exceeds its configuration.");
      const unit = hvcc.subarray(at, at + size); at += size;
      if (((unit[0] >> 1) & 63) !== type) throw new Error("HEVC parameter-set array type does not match its NAL unit.");
      if (type === 33) sequences.push(hevcSequence(unit));
    }
  }
  if (!sequences.length || at !== hvcc.length) throw new Error("HEVC configuration has no SPS or has trailing bytes.");
  const first = sequences[0];
  if (sequences.some(sequence => sequence.width !== first.width || sequence.height !== first.height || sequence.bitDepth !== first.bitDepth)) {
    throw new Error("HEVC SPS changes require packet-specific decoder configuration.");
  }
  return { ...first, reorderDepth: Math.max(...sequences.map(sequence => sequence.reorderDepth)), nalLengthBytes: (hvcc[21] & 3) + 1 };
}

export function hevcSequence(nal) {
  if ((nal[0] & 128) || ((nal[0] >> 1) & 63) !== 33 || !(nal[1] & 7)) throw new Error("HEVC SPS NAL header is invalid.");
  if ((nal[0] & 1) || (nal[1] >> 3)) throw new Error("HEVC multilayer SPS requires layer-specific configuration.");
  const bytes = [];
  for (let at = 2, zeroes = 0; at < nal.length; at++) {
    const byte = nal[at];
    if (zeroes >= 2 && byte === 3) {
      if (at + 1 >= nal.length || nal[at + 1] > 3) throw new Error("HEVC escape byte is invalid.");
      zeroes = 0; continue;
    }
    bytes.push(byte); zeroes = byte === 0 ? zeroes + 1 : 0;
  }
  const bits = new Bits(Buffer.from(bytes), "HEVC");
  bits.uint(4);
  const layers = bits.uint(3);
  if (layers > 6) throw new Error("HEVC temporal sublayer count is invalid.");
  bits.uint(1);
  skip(bits, 96);
  const profiles = [], levels = [];
  for (let layer = 0; layer < layers; layer++) { profiles.push(bits.uint(1)); levels.push(bits.uint(1)); }
  if (layers) skip(bits, (8 - layers) * 2);
  for (let layer = 0; layer < layers; layer++) {
    if (profiles[layer]) skip(bits, 88);
    if (levels[layer]) skip(bits, 8);
  }
  const sequenceId = bits.ue(), chroma = bits.ue();
  if (sequenceId > 15 || chroma > 3) throw new Error("HEVC SPS identity or chroma format is invalid.");
  const separate = chroma === 3 ? bits.uint(1) : 0;
  const codedWidth = bits.ue(), codedHeight = bits.ue();
  let left = 0, right = 0, top = 0, bottom = 0;
  if (bits.uint(1)) { left = bits.ue(); right = bits.ue(); top = bits.ue(); bottom = bits.ue(); }
  const luma = bits.ue(), chromaDepth = bits.ue();
  if (luma > 8 || chromaDepth > 8) throw new Error("HEVC sample bit depth is invalid.");
  const orderBits = bits.ue() + 4;
  if (orderBits > 16) throw new Error("HEVC picture-order width is invalid.");
  const orderingPresent = bits.uint(1);
  let reorderDepth = 0, buffering = 0;
  for (let layer = orderingPresent ? 0 : layers; layer <= layers; layer++) {
    const capacity = bits.ue() + 1, reorder = bits.ue(); bits.ue();
    if (capacity > 16 || reorder >= capacity || capacity < buffering || reorder < reorderDepth) throw new Error("HEVC reorder-buffer declaration is invalid.");
    buffering = capacity; reorderDepth = reorder;
  }
  const chromaArray = separate ? 0 : chroma;
  const width = codedWidth - (left + right) * ([1, 2].includes(chromaArray) ? 2 : 1);
  const height = codedHeight - (top + bottom) * (chromaArray === 1 ? 2 : 1);
  if (!(width > 0) || !(height > 0)) throw new Error("HEVC conformance window removes the entire picture.");
  return { width, height, bitDepth: luma + 8, chromaBitDepth: chromaDepth + 8, chromaFormat: chroma, separateColourPlane: separate === 1, reorderDepth, orderBits,
    ...sequenceTiming(bits, orderBits) };
}

function skip(bits, count) { for (let left = count; left > 0; left -= 32) bits.uint(Math.min(32, left)); }

function sequenceTiming(bits, orderBits) {
  for (let field = 0; field < 6; field++) bits.ue();
  if (bits.uint(1) && bits.uint(1)) {
    for (let size = 0; size < 4; size++) for (let matrix = 0; matrix < 6; matrix += size === 3 ? 3 : 1) {
      if (!bits.uint(1)) bits.ue();
      else {
        if (size > 1) bits.se();
        for (let coefficient = 0; coefficient < Math.min(64, 2 ** (4 + 2 * size)); coefficient++) bits.se();
      }
    }
  }
  bits.uint(1); bits.uint(1);
  if (bits.uint(1)) { bits.uint(8); bits.ue(); bits.ue(); bits.uint(1); }
  const sets = bits.ue();
  if (sets > 64) throw new Error("HEVC short-term reference count is invalid.");
  const previous = [];
  for (let set = 0; set < sets; set++) {
    const deltas = [];
    if (set > 0 && bits.uint(1)) {
      const sign = bits.uint(1), delta = (bits.ue() + 1) * (sign ? -1 : 1);
      for (const before of [...previous[set - 1], 0]) {
        const used = bits.uint(1), retained = used || bits.uint(1);
        if (retained && before + delta !== 0) deltas.push(before + delta);
      }
    } else {
      const negative = bits.ue(), positive = bits.ue();
      if (negative + positive > 16) throw new Error("HEVC reference picture set exceeds its buffer.");
      let value = 0;
      for (let pic = 0; pic < negative; pic++) { value -= bits.ue() + 1; bits.uint(1); deltas.push(value); }
      value = 0;
      for (let pic = 0; pic < positive; pic++) { value += bits.ue() + 1; bits.uint(1); deltas.push(value); }
    }
    if (deltas.length > 16) throw new Error("HEVC predicted reference set exceeds its buffer.");
    previous.push([...deltas.filter(delta => delta < 0).sort((a, b) => b - a),
      ...deltas.filter(delta => delta > 0).sort((a, b) => a - b)]);
  }
  if (bits.uint(1)) {
    const count = bits.ue();
    if (count > 32) throw new Error("HEVC long-term reference count is invalid.");
    for (let pic = 0; pic < count; pic++) { bits.uint(orderBits); bits.uint(1); }
  }
  bits.uint(1); bits.uint(1);
  if (!bits.uint(1)) return {};
  if (bits.uint(1) && bits.uint(8) === 255) { bits.uint(16); bits.uint(16); }
  if (bits.uint(1)) bits.uint(1);
  if (bits.uint(1)) { bits.uint(4); if (bits.uint(1)) skip(bits, 24); }
  if (bits.uint(1)) { bits.ue(); bits.ue(); }
  bits.uint(1);
  const fieldSequence = bits.uint(1), frameFieldInfo = bits.uint(1);
  if (bits.uint(1)) for (let side = 0; side < 4; side++) bits.ue();
  if (!bits.uint(1)) return { fieldSequence: fieldSequence === 1, frameFieldInfo: frameFieldInfo === 1 };
  const units = bits.uint(32), scale = bits.uint(32);
  const proportional = bits.uint(1), ticks = proportional ? bits.ue() + 1 : 1;
  if (!(units > 0) || !(scale > 0)) throw new Error("HEVC timing declaration is invalid.");
  return { timingTickSeconds: units / scale, fps: scale / (units * ticks),
    fieldSequence: fieldSequence === 1, frameFieldInfo: frameFieldInfo === 1,
    pocProportional: proportional === 1, ticksPerPicture: ticks };
}

/** Construct hvcC from complete in-band parameter sets without keeping picture bytes. */
export function hevcConfigurationFromUnits(vps, sps, pps) {
  const facts = hevcSequence(sps);
  const raw = [];
  for (let at = 2, zeroes = 0; at < sps.length; at++) {
    const byte = sps[at];
    if (zeroes >= 2 && byte === 3) { zeroes = 0; continue; }
    raw.push(byte); zeroes = byte === 0 ? zeroes + 1 : 0;
  }
  const header = Buffer.alloc(23);
  header[0] = 1;
  Buffer.from(raw).copy(header, 1, 1, 13);
  header[13] = 0xf0; header[15] = 0xfc;
  header[16] = 0xfc | facts.chromaFormat;
  header[17] = 0xf8 | (facts.bitDepth - 8); header[18] = 0xf8 | (facts.chromaBitDepth - 8);
  header[21] = ((((raw[0] >> 1) & 7) + 1) << 3) | ((raw[0] & 1) << 2) | 3;
  header[22] = 3;
  const arrays = [vps, sps, pps].map((unit, index) => {
    if (!Buffer.isBuffer(unit) || unit.length < 2 || unit.length > 65535 || ((unit[0] >> 1) & 63) !== index + 32) {
      throw new Error("HEVC parameter-set declaration is invalid.");
    }
    return Buffer.concat([Buffer.from([0x80 | (index + 32), 0, 1, unit.length >> 8, unit.length & 255]), unit]);
  });
  const bytes = Buffer.concat([header, ...arrays]);
  return { ...facts, codecPrivateB64: bytes.toString("base64"), packetFraming: "annex-b" };
}
