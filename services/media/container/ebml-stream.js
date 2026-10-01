/**
 * @file EBML elements read where they lie, a portion at a time.
 *
 * `ebml-reader.js` parses a buffer the caller already holds. That is enough for
 * a head window, and it is not enough for the elements that matter here: a Cues
 * table whose size is the file's business, a Tracks element pushed out of the
 * head by a large CodecPrivate, a cluster of a high-bitrate film. Reading any
 * of them "in one go" needs a bound, and a bound is a statement about this
 * program dressed up as a statement about the file — an element over it was
 * reported as absent.
 *
 * This reads element HEADERS one at a time and element DATA only when asked,
 * through a window no larger than one portion. The portion is handed in by
 * whoever knows the medium (a torrent's piece length) and is never chosen here.
 * Skipping an element costs one header read; an element whose data is wanted
 * and is larger than a portion is refused by name, with its size.
 *
 * Grammar only, like `ebml-reader.js`: nothing here knows Matroska's ids.
 */

import { readVint } from "./ebml-reader.js";

/** An element id is at most four bytes and a size at most eight (RFC 8794 §4). */
export const MAX_HEADER_BYTES = 12;

/**
 * Whether a size field says "unknown" — every value bit set (RFC 8794 §6.2).
 *
 * @param {{ value: number, length: number }} size
 * @returns {boolean}
 */
export function sizeIsUnknown(size) {
  return size.value === 2 ** (7 * size.length) - 1;
}

/**
 * @typedef {object} ElementHeader
 * @property {number} id
 * @property {number} at - Where the element begins, its id included.
 * @property {number} dataOffset - Where its data begins.
 * @property {number | null} size - Null when the size is unknown.
 * @property {number | null} end - One past the last data byte, null when unknown.
 */

export class ElementReader {
  /** @type {(start: number, end: number) => Promise<Buffer>} */
  #read;

  /** @type {number} */
  #fileSize;

  /** @type {number} */
  #portion;

  /** @type {boolean} */
  #prefetch;

  /** @type {(start: number) => number} */
  #readableUntil;

  /** @type {Buffer | null} */
  #window = null;

  /** @type {number} */
  #windowAt = 0;

  /**
   * @param {object} params
   * @param {(start: number, end: number) => Promise<Buffer>} params.read - Answers
   *   with every byte of the range or throws (`strictReader`).
   * @param {number} params.fileSize
   * @param {number} [params.portionBytes] - The largest read this makes. Absent,
   *   an element is read in one go, which is right for a file on a local disk.
   * @param {boolean} [params.prefetch] - Read a whole portion on a miss. Right
   *   when every byte of a span will be looked at (a cluster being walked);
   *   wrong when only a few headers will (the elements of a Segment, where a
   *   fetching read of a portion per header would pull megabytes for nothing).
   * @param {(start: number) => number} [params.readableUntil] - One past the
   *   last byte that can be read from `start` in one go. A read of what is
   *   downloaded must not run a prefetch past the end of the downloaded run,
   *   or a cluster that is whole would fail for the bytes after it.
   */
  constructor({ read, fileSize, portionBytes = Number.POSITIVE_INFINITY, prefetch = false, readableUntil }) {
    this.#read = read;
    this.#fileSize = fileSize;
    this.#readableUntil = typeof readableUntil === "function" ? readableUntil : () => fileSize;
    this.#portion = Number.isFinite(portionBytes) && portionBytes > 0 ? portionBytes : Number.POSITIVE_INFINITY;
    this.#prefetch = prefetch;
  }

  /** @returns {number} */
  get portionBytes() {
    return this.#portion;
  }

  /**
   * `length` bytes from `start`, or fewer where the file ends first.
   *
   * @param {number} start
   * @param {number} length
   * @returns {Promise<Buffer>}
   */
  async bytes(start, length) {
    const end = Math.min(this.#fileSize, start + length);
    if (end <= start) {
      return Buffer.alloc(0);
    }
    const window = this.#window;
    if (window && start >= this.#windowAt && end <= this.#windowAt + window.length) {
      return window.subarray(start - this.#windowAt, end - this.#windowAt);
    }
    const reach = Math.min(this.#fileSize, Math.max(end, this.#readableUntil(start)));
    const span = this.#prefetch ? Math.max(end - start, Math.min(this.#portion, reach - start)) : end - start;
    const got = await this.#read(start, start + span - 1);
    this.#window = got;
    this.#windowAt = start;
    return got.subarray(0, end - start);
  }

  /**
   * The element whose header begins at `at`.
   *
   * @param {number} at
   * @param {number} limit - One past the last byte the element may occupy.
   * @returns {Promise<ElementHeader | null>} Null when the bytes there are not
   *   an element header — a malformed vint, or no room for one.
   */
  async header(at, limit) {
    const room = Math.min(limit, this.#fileSize) - at;
    if (room <= 1) {
      return null;
    }
    const bytes = await this.bytes(at, Math.min(MAX_HEADER_BYTES, room));
    const id = readVint(bytes, 0, true);
    if (!id) {
      return null;
    }
    const size = readVint(bytes, id.length, false);
    if (!size) {
      return null;
    }
    const dataOffset = at + id.length + size.length;
    if (sizeIsUnknown(size)) {
      return { id: id.value, at, dataOffset, size: null, end: null };
    }
    return { id: id.value, at, dataOffset, size: size.value, end: dataOffset + size.value };
  }

  /**
   * An element's data, copied out of the window so the window can move on.
   *
   * @param {ElementHeader} element
   * @returns {Promise<Buffer | null>} Null when the data is larger than one
   *   portion: refused, never assembled.
   */
  async data(element) {
    if (element.size === null || element.size > this.#portion) {
      return null;
    }
    return Buffer.from(await this.bytes(element.dataOffset, element.size));
  }

  /**
   * The first `length` bytes of an element's data, without reading the rest.
   *
   * @param {ElementHeader} element
   * @param {number} length
   * @returns {Promise<Buffer>}
   */
  async peek(element, length) {
    const available = element.size === null ? length : Math.min(length, element.size);
    return this.bytes(element.dataOffset, available);
  }
}
