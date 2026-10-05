const RATES = [null, 24000 / 1001, 24, 25, 30000 / 1001, 30, 50, 60000 / 1001, 60];

/** Read sequence declarations from a bounded elementary-stream prefix. */
export function mpegVideoConfiguration(bytes) {
  const sequence = bytes.indexOf(Buffer.from([0, 0, 1, 0xb3]));
  if (sequence < 0) return null;
  const bits = reader(bytes.subarray(sequence + 4));
  let width = bits(12), height = bits(12);
  const aspect = bits(4), rate = bits(4);
  if (!width || !height || !aspect || !RATES[rate]) throw new Error("MPEG video sequence dimensions or rate are invalid.");
  bits(18);
  if (bits(1) !== 1) throw new Error("MPEG video sequence marker is invalid.");
  bits(10); bits(1);
  if (bits(1)) for (let index = 0; index < 64; index++) {
    if (bits(8) === 0) throw new Error("MPEG video quantization matrix is invalid.");
  }
  if (bits(1)) for (let index = 0; index < 64; index++) {
    if (bits(8) === 0) throw new Error("MPEG video quantization matrix is invalid.");
  }
  let fps = RATES[rate], codecId = "mpeg1video", progressiveSequence = true;
  for (let at = sequence + 12; at + 4 < bytes.length; at++) {
    if (bytes[at] !== 0 || bytes[at + 1] !== 0 || bytes[at + 2] !== 1) continue;
    if (bytes[at + 3] === 0 || bytes[at + 3] === 0xb8) break;
    if (bytes[at + 3] !== 0xb5 || bytes[at + 4] >> 4 !== 1) continue;
    const extension = reader(bytes.subarray(at + 4));
    extension(4); extension(8); progressiveSequence = extension(1) === 1;
    if (extension(2) === 0) throw new Error("MPEG video chroma format is invalid.");
    width += extension(2) * 4096;
    height += extension(2) * 4096;
    extension(12);
    if (extension(1) !== 1) throw new Error("MPEG video extension marker is invalid.");
    extension(8); extension(1);
    fps *= (extension(2) + 1) / (extension(5) + 1);
    codecId = "mpeg2video";
    break;
  }
  return { width, height, fps, codecId, bitDepth: 8, progressiveSequence };
}

function reader(bytes) {
  let offset = 0;
  return count => {
    if (offset + count > bytes.length * 8) throw new Error("MPEG video sequence header is truncated.");
    let value = 0;
    for (let index = 0; index < count; index++, offset++) {
      value = value * 2 + ((bytes[offset >> 3] >> (7 - (offset & 7))) & 1);
    }
    return value;
  };
}
