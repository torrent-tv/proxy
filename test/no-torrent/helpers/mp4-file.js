/**
 * @file The MP4 byte builders every check shares: `box`, `fullBox`, `u32`.
 *
 * They are the oracle for the container readers and the segment writers, so
 * they import nothing of the proxy and write the bytes by hand.
 */

/**
 * A box: a four-byte size that counts its own header, the four-character type
 * (latin1, so `©nam` is one byte), then the payload parts joined.
 *
 * @param {string} type
 * @param {...(Buffer | Uint8Array | string)} parts
 * @returns {Buffer}
 */
export function box(type, ...parts) {
  const payload = Buffer.concat(parts.map((part) => (typeof part === "string" ? Buffer.from(part) : Buffer.from(part))));
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8, 0);
  header.write(type, 4, 4, "latin1");
  return Buffer.concat([header, payload]);
}

/**
 * A box whose payload starts with a version byte and three bytes of flags (zero).
 *
 * @param {string} type
 * @param {Buffer} payload
 * @param {{ version?: number }} [options]
 * @returns {Buffer}
 */
export function fullBox(type, payload, { version = 0 } = {}) {
  return box(type, Buffer.from([version, 0, 0, 0]), payload);
}

/**
 * Each value as four big-endian bytes, in order (a negative value keeps its unsigned form).
 *
 * @param {...number} values
 * @returns {Buffer}
 */
export function u32(...values) {
  const out = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => out.writeUInt32BE(value >>> 0, index * 4));
  return out;
}
