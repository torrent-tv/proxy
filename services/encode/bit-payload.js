/** Normalize an admitted byte-sized payload that starts between source bytes. */
export function bitPayloadSlices(slices, bitOffset, bitLength) {
  const total = slices.reduce((sum, slice) => sum + slice.length, 0);
  if (!Number.isSafeInteger(bitOffset) || bitOffset < 0 || !Number.isSafeInteger(bitLength) ||
      bitLength <= 0 || bitLength % 8 !== 0 || bitOffset + bitLength > total * 8) throw new Error("Admitted packet bit payload is incomplete.");
  const first = Math.floor(bitOffset / 8), length = bitLength / 8, shift = bitOffset & 7;
  if (!shift) {
    let offset = 0;
    const result = [];
    for (const slice of slices) {
      if (offset < first + length && offset + slice.length > first) result.push(slice.subarray(Math.max(0, first - offset), Math.min(slice.length, first + length - offset)));
      offset += slice.length;
    }
    return result;
  }
  const result = Buffer.alloc(length);
  let sliceIndex = 0, base = 0;
  const byteAt = position => {
    while (base + slices[sliceIndex].length <= position) { base += slices[sliceIndex].length; sliceIndex++; }
    return slices[sliceIndex][position - base];
  };
  let before = byteAt(first);
  for (let offset = 0; offset < length; offset++) {
    const after = byteAt(first + offset + 1);
    result[offset] = ((before << shift) | (after >> (8 - shift))) & 255;
    before = after;
  }
  return [result];
}
