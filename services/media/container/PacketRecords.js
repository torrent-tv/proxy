// Fixed-width packet facts and exact range addresses, outside the object heap.
// Allocation size is a storage block size, not an admission allowance.
import { IndexMemoryUnavailable } from "./memory-unavailable.js";

const BLOCK_BYTES = 65536;
const ADDRESS_BYTES = 8;
const HEADER_BYTES = 56;

export class PacketRecords {
  #blocks = [];
  #addresses = [];
  #used = 0;
  #length = 0;
  #bytes = 0;
  #reserve;
  #release;
  #onDispose;
  #disposed = false;
  #prepaid = 0;
  // Where the records first go back in time (-1 while they never do), the last
  // time pushed, and the longest duration any record has had: what lets a
  // reader find an interval by search instead of reading every record.
  #descentAt = -1;
  #lastPts = -Infinity;
  #longest = 0;

  constructor(memory = {}) {
    const allocation = memory.forRecord?.(this) ?? memory;
    this.#reserve = allocation.reserve ?? (() => true);
    this.#release = allocation.release ?? (() => {});
    this.#onDispose = allocation.dispose;
  }

  dispose() {
    if (this.#disposed) return;
    this.length = 0;
    this.releaseUnusedCapacity();
    this.#disposed = true;
    this.#onDispose?.();
  }

  get length() { return this.#length; }
  get allocatedBytes() { return this.#bytes; }

  /** Admit a declared table's complete allocation before reconstructing it. */
  reserveCapacity(count, recordBytes) {
    if (this.#disposed || this.#length || this.#prepaid || !Number.isSafeInteger(count) || count < 0 ||
        !Number.isSafeInteger(recordBytes) || recordBytes < HEADER_BYTES || recordBytes > BLOCK_BYTES) {
      throw new TypeError("Invalid declared packet capacity.");
    }
    const bytes = Math.ceil(count / Math.floor(BLOCK_BYTES / recordBytes)) * BLOCK_BYTES +
      Math.ceil(count / (BLOCK_BYTES / ADDRESS_BYTES)) * BLOCK_BYTES;
    if (!Number.isSafeInteger(bytes)) throw new TypeError("Declared packet capacity exceeds its integer range.");
    if (bytes && !this.#reserve(bytes)) throw new IndexMemoryUnavailable(bytes);
    this.#prepaid = bytes;
  }

  releaseUnusedCapacity() {
    if (this.#prepaid) this.#release(this.#prepaid);
    this.#prepaid = 0;
  }

  set length(value) {
    if (!Number.isSafeInteger(value) || value < 0 || value > this.#length) {
      throw new TypeError("Packet records may only be truncated.");
    }
    const previousBytes = this.#bytes;
    if (value === 0) {
      this.#blocks = [];
      this.#addresses = [];
      this.#used = 0;
      this.#bytes = 0;
    } else if (value < this.#length) {
      const addressAt = (value - 1) * ADDRESS_BYTES;
      const address = this.#addresses[Math.floor(addressAt / BLOCK_BYTES)];
      const blockIndex = address.readUInt32LE(addressAt % BLOCK_BYTES);
      const at = address.readUInt32LE(addressAt % BLOCK_BYTES + 4);
      const block = this.#blocks[blockIndex];
      this.#blocks.length = blockIndex + 1;
      this.#addresses.length = Math.ceil(value * ADDRESS_BYTES / BLOCK_BYTES);
      const flags = block.readUInt32LE(at + 48);
      this.#used = at + HEADER_BYTES + block.readUInt32LE(at + 52) * 16 + ((flags & 2) ? 32 : 0) + ((flags & 8) ? 4 : 0) + ((flags & 16) ? 4 : 0);
      this.#bytes = [...this.#blocks, ...this.#addresses].reduce((sum, buffer) => sum + buffer.length, 0);
    }
    this.#length = value;
    if (this.#descentAt >= value) this.#descentAt = -1;
    this.#lastPts = value ? this.ptsAt(value - 1) : -Infinity;
    if (!value) this.#longest = 0;
    if (previousBytes !== this.#bytes) this.#release(previousBytes - this.#bytes);
  }

  /** Whether every record's time is at least the one before it. */
  get ptsAscending() { return this.#descentAt < 0; }

  /** No record has lasted longer than this, though a removed one may have: a bound, not a measurement. */
  get longestDuration() { return this.#longest; }

  /** The first record whose time is at least `seconds`, `length` when there is none; only when the times ascend. */
  firstAtOrAfter(seconds) {
    if (!this.ptsAscending) throw new Error("Records whose times go back cannot be searched by time.");
    let low = 0, high = this.#length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.ptsAt(middle) < seconds) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  push(packet) {
    if (this.#disposed) throw new Error("Packet records were released.");
    if (!Number.isFinite(packet.pts) || !Array.isArray(packet.ranges) ||
      packet.ranges.some(range => !Array.isArray(range) || range.length !== 2 ||
        !Number.isSafeInteger(range[0]) || !Number.isSafeInteger(range[1]) || range[0] < 0 || range[1] < range[0]) ||
      [packet.duration, packet.dts, packet.discardPaddingSeconds, packet.bitOffset, packet.bitLength]
        .some(value => value != null && !Number.isFinite(value)) ||
      (packet.expectedHash !== undefined && !/^[\da-f]{64}$/i.test(packet.expectedHash)) ||
      [packet.streamId, packet.decodeFromIndex].some(value => value !== undefined && (!Number.isInteger(value) || value < 0 || value > 0xffffffff))) {
      throw new TypeError("Invalid binary packet facts.");
    }
    const bytes = HEADER_BYTES + packet.ranges.length * 16 + (packet.expectedHash ? 32 : 0) + (packet.streamId !== undefined ? 4 : 0) + (packet.decodeFromIndex !== undefined ? 4 : 0);
    let block = this.#blocks.at(-1);
    const newBlock = !block || block.length - this.#used < bytes;
    const perAddressBlock = BLOCK_BYTES / ADDRESS_BYTES;
    const addressBlockIndex = Math.floor(this.#length / perAddressBlock);
    const newAddresses = !this.#addresses[addressBlockIndex];
    const growth = (newBlock ? Math.max(BLOCK_BYTES, bytes) : 0) + (newAddresses ? BLOCK_BYTES : 0);
    const prepaid = Math.min(growth, this.#prepaid);
    if (growth > prepaid && !this.#reserve(growth - prepaid)) throw new IndexMemoryUnavailable(growth - prepaid);
    this.#prepaid -= prepaid;
    let payloadAllocation, addressAllocation;
    try {
      if (newBlock) payloadAllocation = Buffer.alloc(Math.max(BLOCK_BYTES, bytes));
      if (newAddresses) addressAllocation = Buffer.alloc(BLOCK_BYTES);
    } catch (error) {
      if (growth) this.#release(growth);
      throw error;
    }
    if (newBlock) {
      block = payloadAllocation;
      this.#blocks.push(block);
      this.#bytes += block.length;
      this.#used = 0;
    }
    if (newAddresses) {
      this.#addresses.push(addressAllocation);
      this.#bytes += BLOCK_BYTES;
    }
    const address = this.#addresses[addressBlockIndex];
    const addressAt = (this.#length % perAddressBlock) * ADDRESS_BYTES;
    address.writeUInt32LE(this.#blocks.length - 1, addressAt);
    address.writeUInt32LE(this.#used, addressAt + 4);
    const at = this.#used;
    const numbers = [packet.pts, packet.duration, packet.dts, packet.discardPaddingSeconds,
      packet.bitOffset, packet.bitLength];
    numbers.forEach((value, index) => block.writeDoubleLE(value ?? NaN, at + index * 8));
    block.writeUInt32LE((packet.keyframe ? 1 : 0) | (packet.expectedHash ? 2 : 0) | (packet.streamId !== undefined ? 8 : 0) | (packet.decodeFromIndex !== undefined ? 16 : 0) | (packet.decodeFromIndex !== undefined && !packet.decodeDependencyUnknown ? 32 : 0), at + 48);
    block.writeUInt32LE(packet.ranges.length, at + 52);
    packet.ranges.forEach(([start, end], index) => {
      block.writeDoubleLE(start, at + HEADER_BYTES + index * 16);
      block.writeDoubleLE(end, at + HEADER_BYTES + index * 16 + 8);
    });
    if (packet.expectedHash) block.write(packet.expectedHash, at + HEADER_BYTES + packet.ranges.length * 16, 32, "hex");
    if (packet.streamId !== undefined) block.writeUInt32LE(packet.streamId, at + bytes - 4 - (packet.decodeFromIndex !== undefined ? 4 : 0));
    if (packet.decodeFromIndex !== undefined) block.writeUInt32LE(packet.decodeFromIndex, at + bytes - 4);
    this.#used += bytes;
    if (this.#descentAt < 0 && packet.pts < this.#lastPts) this.#descentAt = this.#length;
    this.#lastPts = packet.pts;
    if (packet.duration > this.#longest) this.#longest = packet.duration;
    return ++this.#length;
  }

  #address(index) {
    const addressAt = index * ADDRESS_BYTES;
    const address = this.#addresses[Math.floor(addressAt / BLOCK_BYTES)];
    const offset = addressAt % BLOCK_BYTES;
    return [this.#blocks[address.readUInt32LE(offset)], address.readUInt32LE(offset + 4)];
  }

  ptsAt(index) {
    const [block, at] = this.#address(index);
    return block.readDoubleLE(at);
  }

  durationAt(index) {
    const [block, at] = this.#address(index);
    return block.readDoubleLE(at + 8);
  }

  keyframeAt(index) {
    const [block, at] = this.#address(index);
    return !!(block.readUInt32LE(at + 48) & 1);
  }

  derivedDurationAt(index) {
    const [block, at] = this.#address(index);
    return !!(block.readUInt32LE(at + 48) & 4);
  }

  at(index) {
    if (index < 0) index += this.#length;
    if (index < 0 || index >= this.#length) return undefined;
    const [block, at] = this.#address(index);
    const flags = block.readUInt32LE(at + 48), count = block.readUInt32LE(at + 52);
    const packet = { pts: block.readDoubleLE(at), keyframe: !!(flags & 1), ranges: [] };
    const duration = block.readDoubleLE(at + 8);
    if (!Number.isNaN(duration)) packet.duration = duration;
    for (const [number, name] of ["dts", "discardPaddingSeconds", "bitOffset", "bitLength"].entries()) {
      const value = block.readDoubleLE(at + 16 + number * 8);
      if (!Number.isNaN(value)) packet[name] = value;
    }
    for (let range = 0; range < count; range++) packet.ranges.push([
      block.readDoubleLE(at + HEADER_BYTES + range * 16), block.readDoubleLE(at + HEADER_BYTES + range * 16 + 8)
    ]);
    if (flags & 2) packet.expectedHash = block.subarray(at + HEADER_BYTES + count * 16, at + HEADER_BYTES + count * 16 + 32).toString("hex");
    if (flags & 8) packet.streamId = block.readUInt32LE(at + HEADER_BYTES + count * 16 + ((flags & 2) ? 32 : 0));
    if (flags & 16) packet.decodeFromIndex = block.readUInt32LE(at + HEADER_BYTES + count * 16 + ((flags & 2) ? 32 : 0) + ((flags & 8) ? 4 : 0));
    if ((flags & 16) && !(flags & 32)) packet.decodeDependencyUnknown = true;
    return packet;
  }

  setDecodeFromIndex(index, first) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.#length ||
        !Number.isSafeInteger(first) || first < 0 || first > index || first > 0xffffffff) {
      throw new TypeError("Invalid decoder dependency address.");
    }
    const [block, at] = this.#address(index);
    const flags = block.readUInt32LE(at + 48), count = block.readUInt32LE(at + 52);
    if (!(flags & 16)) throw new Error("Decoder dependency storage was not reserved.");
    block.writeUInt32LE(first, at + HEADER_BYTES + count * 16 + ((flags & 2) ? 32 : 0) + ((flags & 8) ? 4 : 0));
    block.writeUInt32LE(flags | 32, at + 48);
  }

  extendLastPresentation(seconds) {
    if (!this.#length) return;
    const [block, at] = this.#address(this.#length - 1);
    const duration = block.readDoubleLE(at + 8) + seconds;
    block.writeDoubleLE(duration, at + 8);
    if (duration > this.#longest) this.#longest = duration;
  }

  setDuration(index, seconds, derived = false) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.#length || !Number.isFinite(seconds) || seconds < 0) {
      throw new TypeError("A packet duration requires an existing record and a finite nonnegative value.");
    }
    const [block, at] = this.#address(index);
    block.writeDoubleLE(seconds, at + 8);
    if (seconds > this.#longest) this.#longest = seconds;
    const flags = block.readUInt32LE(at + 48);
    block.writeUInt32LE(derived ? flags | 4 : flags & ~4, at + 48);
  }

  *[Symbol.iterator]() { for (let index = 0; index < this.#length; index++) yield this.at(index); }
  map(callback) { return Array.from(this, callback); }
  filter(callback) { return Array.from(this).filter(callback); }
  some(callback) { for (const packet of this) if (callback(packet)) return true; return false; }
  every(callback) { for (const packet of this) if (!callback(packet)) return false; return true; }
  reduce(callback, initial) {
    let value = initial;
    for (const packet of this) value = callback(value, packet);
    return value;
  }
  slice(start = 0, end = this.#length) {
    if (start < 0) start = Math.max(0, this.#length + start);
    if (end < 0) end = Math.max(0, this.#length + end);
    const records = [];
    for (let index = start; index < Math.min(end, this.#length); index++) records.push(this.at(index));
    return records;
  }
}
