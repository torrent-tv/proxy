/**
 * @file Minimal EBML reader — the encoding Matroska/WebM are built from.
 *
 * Only what a keyframe index needs: walk elements, read unsigned integers,
 * descend into containers. Deliberately not a general EBML implementation.
 *
 * Why not the `ebml` npm package (MIT, otherwise fine): its decoder is a
 * *stream* decoder — it must be fed the file from byte zero. We read two small
 * ranges out of a multi-gigabyte torrent-backed file and never the whole thing,
 * so a parser that starts mid-file is exactly what we need and exactly what it
 * cannot do (verified 2026-08-02: feeding it the Cues range throws
 * "Unrepresentable length"). The element encoding itself is small enough to
 * implement directly, so we do — the shape follows the Matroska specification
 * and the same logic those libraries implement.
 */

/**
 * A variable-length integer, as EBML encodes both element ids and sizes.
 *
 * The first set bit of the leading byte marks the width: `1xxxxxxx` is one
 * byte, `01xxxxxx` two, and so on up to eight. For a SIZE the marker bit is
 * removed and the remainder is the value; for an ID the bytes are kept intact,
 * because the id *is* those bytes (that is how `0x1C53BB6B` identifies Cues).
 *
 * @param {Buffer} buffer
 * @param {number} offset
 * @param {boolean} keepMarker - True for ids, false for sizes.
 * @returns {{ value: number, length: number } | null} Null when truncated or malformed.
 */
export function readVint(buffer, offset, keepMarker) {
  if (offset >= buffer.length) {
    return null;
  }
  const first = buffer[offset];
  if (first === 0) {
    return null; // No marker bit in the first byte: not a valid vint start.
  }
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && (first & mask) === 0) {
    length += 1;
    mask >>= 1;
  }
  if (length > 8 || offset + length > buffer.length) {
    return null;
  }
  let value = keepMarker ? first : first & (mask - 1);
  for (let index = 1; index < length; index += 1) {
    // Values beyond 2^53 cannot be represented exactly; sizes and positions in
    // real files stay far below that, so plain arithmetic is safe here.
    value = value * 256 + buffer[offset + index];
  }
  return { value, length };
}

/**
 * Iterate the elements directly inside `buffer`, without descending.
 *
 * Yields each element's id, the offset of its payload and its size. An element
 * whose payload runs past the end of the buffer is still yielded (its header is
 * intact and the caller may only need the id), but iteration stops after it.
 *
 * @param {Buffer} buffer
 * @param {number} [start=0]
 * @param {number} [end=buffer.length]
 * @yields {{ id: number, dataOffset: number, size: number }}
 */
export function* iterateElements(buffer, start = 0, end = buffer.length) {
  let offset = start;
  while (offset < end) {
    const id = readVint(buffer, offset, true);
    if (!id) {
      return;
    }
    const size = readVint(buffer, offset + id.length, false);
    if (!size) {
      return;
    }
    const dataOffset = offset + id.length + size.length;
    yield { id: id.value, dataOffset, size: size.value };
    if (dataOffset + size.value > end) {
      return; // Truncated payload — nothing dependable follows it.
    }
    offset = dataOffset + size.value;
  }
}

/**
 * Read an EBML unsigned integer payload (big-endian, variable width).
 *
 * @param {Buffer} buffer
 * @param {number} offset
 * @param {number} size
 * @returns {number}
 */
export function readUint(buffer, offset, size) {
  let value = 0;
  for (let index = 0; index < size; index += 1) {
    value = value * 256 + buffer[offset + index];
  }
  return value;
}

/**
 * Depth-first search for the first element with `id`, descending only into the
 * container ids listed in `descendInto`.
 *
 * @param {Buffer} buffer
 * @param {number} id - Element id to find.
 * @param {number[]} descendInto - Container ids worth entering.
 * @param {number} [start=0]
 * @param {number} [end=buffer.length]
 * @returns {{ dataOffset: number, size: number } | null}
 */
export function findElement(buffer, id, descendInto, start = 0, end = buffer.length) {
  for (const element of iterateElements(buffer, start, end)) {
    if (element.id === id) {
      return { dataOffset: element.dataOffset, size: element.size };
    }
    if (descendInto.includes(element.id)) {
      const limit = Math.min(end, element.dataOffset + element.size);
      const found = findElement(buffer, id, descendInto, element.dataOffset, limit);
      if (found) {
        return found;
      }
    }
  }
  return null;
}
