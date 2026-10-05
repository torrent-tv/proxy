/** PES optional headers from ISO/IEC 13818-1; PTS is a 33-bit 90 kHz counter. */
export function pesPayload(bytes) {
  let offset = 0, pts = null, dts = null;
  if ((bytes[0] & 0xc0) === 0x80) {
    if (bytes.length < 3 || 3 + bytes[2] > bytes.length) throw new Error("MPEG PES optional header is truncated.");
    const flags = (bytes[1] >> 6) & 3;
    if (flags === 1) throw new Error("MPEG PES timestamp flags are invalid.");
    if (flags >= 2) {
      if (bytes[2] < (flags === 3 ? 10 : 5)) throw new Error("MPEG PES timestamp is truncated.");
      pts = pesTime(bytes.subarray(3, 8), flags);
      dts = flags === 3 ? pesTime(bytes.subarray(8, 13), 1) : pts;
    }
    offset = 3 + bytes[2];
  } else {
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if ((bytes[offset] & 0xc0) === 0x40) offset += 2;
    const flags = bytes[offset] >> 4;
    if (flags === 2 || flags === 3) {
      const count = flags === 3 ? 10 : 5;
      if (offset + count > bytes.length) throw new Error("MPEG-1 PES timestamp is truncated.");
      pts = pesTime(bytes.subarray(offset, offset + 5), flags);
      dts = flags === 3 ? pesTime(bytes.subarray(offset + 5, offset + 10), 1) : pts;
      offset += count;
    } else if (bytes[offset] === 0x0f) offset++;
    else throw new Error("MPEG-1 PES optional header is invalid.");
  }
  return { offset, pts, dts };
}

function pesTime(bytes, prefix) {
  if (bytes.length !== 5 || !(bytes[0] & bytes[2] & bytes[4] & 1)) throw new Error("MPEG PES timestamp markers are invalid.");
  if ((bytes[0] >> 4) !== prefix) throw new Error("MPEG PES timestamp prefix is invalid.");
  return ((bytes[0] & 14) * 2 ** 29 + bytes[1] * 2 ** 22 + (bytes[2] >> 1) * 2 ** 15 + bytes[3] * 2 ** 7 + (bytes[4] >> 1)) / 90000;
}
