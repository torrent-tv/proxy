/**
 * @file Packet records of one track read as one list across adjoining tables.
 *
 * A Matroska track's packets are read in stretches: wherever a viewer is, the
 * download map asks first, and a stretch begins at the cue before it. Each
 * stretch keeps its own table, and when one reaches the next they adjoin. A
 * request reads the stretches it spans as one list through this view; nothing
 * is copied, and the tables stay the container's (torrent-tv/meta#178).
 *
 * Read-only apart from what the index derives per request: a duration worked
 * out from the following packet is written to the table holding the packet,
 * and an MP3 decoder dependency to the table holding it when its first packet
 * is in the same table. One that reaches into an earlier table is kept in this
 * view only, since a table states its dependencies by its own positions.
 */
export class PacketRecordsChain {
  #parts;
  #offsets;
  #fixed;
  #dependencies = new Map();

  /** @param {import("./PacketRecords.js").PacketRecords[]} parts - In file order; every part but the last adjoins the next and no longer grows. */
  constructor(parts) {
    if (!Array.isArray(parts) || parts.length === 0) throw new TypeError("A packet chain needs at least one table.");
    this.#parts = parts;
    this.#offsets = [];
    let offset = 0;
    for (const part of parts) {
      this.#offsets.push(offset);
      offset += part.length;
    }
    this.#fixed = this.#offsets.at(-1);
  }

  get length() { return this.#fixed + this.#parts.at(-1).length; }
  get allocatedBytes() { return 0; }

  get ptsAscending() {
    for (let part = 0; part < this.#parts.length; part++) {
      const records = this.#parts[part];
      if (!records.ptsAscending) return false;
      const next = this.#parts[part + 1];
      if (next?.length && records.length && next.ptsAt(0) < records.ptsAt(records.length - 1)) return false;
    }
    return true;
  }

  get longestDuration() { return Math.max(...this.#parts.map(part => part.longestDuration)); }

  /** The table holding `index` and the position within it. */
  #locate(index) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) throw new RangeError(`No packet record ${index}.`);
    if (index >= this.#fixed) return [this.#parts.length - 1, index - this.#fixed];
    let low = 0, high = this.#parts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >>> 1;
      if (this.#offsets[middle] <= index) low = middle;
      else high = middle - 1;
    }
    return [low, index - this.#offsets[low]];
  }

  ptsAt(index) { const [part, at] = this.#locate(index); return this.#parts[part].ptsAt(at); }
  durationAt(index) { const [part, at] = this.#locate(index); return this.#parts[part].durationAt(at); }
  keyframeAt(index) { const [part, at] = this.#locate(index); return this.#parts[part].keyframeAt(at); }
  derivedDurationAt(index) { const [part, at] = this.#locate(index); return this.#parts[part].derivedDurationAt(at); }

  setDuration(index, seconds, derived = false) {
    const [part, at] = this.#locate(index);
    this.#parts[part].setDuration(at, seconds, derived);
  }

  setDecodeFromIndex(index, first) {
    if (!Number.isSafeInteger(first) || first < 0 || first > index) throw new TypeError("Invalid decoder dependency address.");
    const [part, at] = this.#locate(index);
    const offset = this.#offsets[part];
    if (first >= offset) {
      this.#parts[part].setDecodeFromIndex(at, first - offset);
      this.#dependencies.delete(index);
    } else {
      this.#dependencies.set(index, first);
    }
  }

  at(index) {
    if (index < 0) index += this.length;
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.length) return undefined;
    const [part, at] = this.#locate(index);
    const packet = this.#parts[part].at(at);
    if (this.#dependencies.has(index)) {
      packet.decodeFromIndex = this.#dependencies.get(index);
      delete packet.decodeDependencyUnknown;
    } else if (packet.decodeFromIndex !== undefined) {
      packet.decodeFromIndex += this.#offsets[part];
    }
    return packet;
  }

  firstAtOrAfter(seconds) {
    if (!this.ptsAscending) throw new Error("Records whose times go back cannot be searched by time.");
    let low = 0, high = this.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.ptsAt(middle) < seconds) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  forEachInTimeRange(from, to, visit) {
    for (let part = 0; part < this.#parts.length; part++) {
      const offset = this.#offsets[part];
      this.#parts[part].forEachInTimeRange(from, to, (index, pts) => visit(offset + index, pts));
    }
  }

  someAtTime(seconds, matches) {
    for (let part = 0; part < this.#parts.length; part++) {
      const offset = this.#offsets[part];
      if (this.#parts[part].someAtTime(seconds, index => matches(offset + index))) return true;
    }
    return false;
  }

  /** The tables are the container's: a request's index lets go of nothing. */
  dispose() {}
  releaseUnusedCapacity() {}

  *[Symbol.iterator]() { for (let index = 0; index < this.length; index++) yield this.at(index); }
  map(callback) { return Array.from(this, callback); }
  filter(callback) { return Array.from(this).filter(callback); }
  some(callback) { for (const packet of this) if (callback(packet)) return true; return false; }
  every(callback) { for (const packet of this) if (!callback(packet)) return false; return true; }
  reduce(callback, initial) {
    let value = initial;
    for (const packet of this) value = callback(value, packet);
    return value;
  }
  slice(start = 0, end = this.length) {
    const length = this.length;
    if (start < 0) start = Math.max(0, length + start);
    if (end < 0) end = Math.max(0, length + end);
    const records = [];
    for (let index = start; index < Math.min(end, length); index++) records.push(this.at(index));
    return records;
  }
}
