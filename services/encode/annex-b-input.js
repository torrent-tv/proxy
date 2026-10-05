/** Convert borrowed Annex B payload slices to Matroska AVC length framing. */
export function avcPacketSlices(slices) {
  if (!Array.isArray(slices) || slices.some(slice => !Buffer.isBuffer(slice))) throw new TypeError("AVC packet slices must be buffers.");
  const units = [];
  let position = 0, zeroes = 0, start = null;
  for (const slice of slices) {
    for (const byte of slice) {
      if (byte === 1 && zeroes >= 2) {
        const end = position - zeroes;
        if (start !== null) {
          if (end <= start) throw new Error("AVC Annex B contains an empty NAL unit.");
          units.push([start, end]);
        } else if (end !== 0) throw new Error("AVC Annex B precedes its first start code with data.");
        start = position + 1;
      }
      zeroes = byte === 0 ? zeroes + 1 : 0;
      position++;
    }
  }
  if (start === null || position - zeroes <= start) throw new Error("AVC Annex B has no complete NAL unit.");
  units.push([start, position - zeroes]);
  const result = [];
  for (const [from, to] of units) {
    const length = to - from;
    if (length > 0xffffffff) throw new Error("AVC NAL unit exceeds its length declaration.");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(length);
    result.push(header);
    let offset = 0;
    for (const slice of slices) {
      if (offset < to && offset + slice.length > from) result.push(slice.subarray(Math.max(0, from - offset), Math.min(slice.length, to - offset)));
      offset += slice.length;
      if (offset >= to) break;
    }
  }
  return result;
}
