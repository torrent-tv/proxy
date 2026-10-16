/** Exact binary index ownership and pending growth under the shared budget. */
export class IndexMemory {
  #files = new Map();
  #held = 0;
  #packetBytes = 0;
  #allowed = 0;
  #revise;
  #changed;
  #revisionQueued = false;
  #growthBytes;

  /**
   * @param {object} params
   * @param {() => void} params.reviseBudget
   * @param {() => void} params.changed
   * @param {number} [params.growthBytes] - What one growth of a table can
   *   take at most, kept free beyond what is held while anything is held. A
   *   table grows a block at a time, each twice the last; allowed exactly what
   *   it held, each growth was refused first and its whole read tried again:
   *   a soundtrack piece after a seek was refused three times and ready after
   *   53.7 s (r58, torrent-tv/meta#178).
   */
  constructor({ reviseBudget, changed, growthBytes = 0 }) {
    this.#revise = reviseBudget;
    this.#changed = changed;
    this.#growthBytes = growthBytes;
  }

  held() { return this.#held; }
  packetBytes() { return this.#packetBytes; }
  wanted() {
    const short = [...this.#files.values()].reduce((sum, file) => sum + Math.max(0, file.needed - file.held), 0);
    return this.#held + Math.max(short, this.#held > 0 ? this.#growthBytes : 0);
  }
  /** What is held and asked for, without the margin kept for growth. */
  required() {
    return this.#held + [...this.#files.values()].reduce((sum, file) => sum + Math.max(0, file.needed - file.held), 0);
  }

  allow(bytes) {
    const allowed = Math.max(0, bytes);
    if (allowed === this.#allowed) return;
    this.#allowed = allowed;
    this.#changed?.();
  }

  #requestRevision() {
    if (this.#revisionQueued) return;
    this.#revisionQueued = true;
    queueMicrotask(() => {
      this.#revisionQueued = false;
      this.#revise?.();
    });
  }

  forFile(sourceKey, fileIndex) {
    const key = JSON.stringify([sourceKey, fileIndex]);
    let file = this.#files.get(key);
    if (file) return file.memory;
    file = { sourceKey, held: 0, needed: 0, records: new Set(), closed: false };
    file.memory = {
      // Whether a reservation of this many bytes would succeed now. Asked by a
      // reader that keeps a refusal, so the refusal never outlives the state
      // of memory it was given in — an event comes only when the allowance
      // changes, and bytes released under the same allowance raise none.
      fits: bytes => !file.closed && this.#held + bytes <= this.#allowed,
      forRecord: (record, kind = "packets") => {
        file.records.add(record);
        let disposed = false;
        return {
          reserve: bytes => {
            if (file.closed || disposed) return false;
            if (this.#held + bytes > this.#allowed) {
              const needed = file.held + bytes;
              if (needed > file.needed) { file.needed = needed; this.#requestRevision(); }
              return false;
            }
            file.held += bytes;
            this.#held += bytes;
            if (kind === "packets") this.#packetBytes += bytes;
            if (file.held >= file.needed) file.needed = 0;
            return true;
          },
          release: bytes => {
            file.held -= bytes;
            this.#held -= bytes;
            if (kind === "packets") this.#packetBytes -= bytes;
            this.#requestRevision();
          },
          dispose: () => { disposed = true; file.records.delete(record); }
        };
      }
    };
    this.#files.set(key, file);
    return file.memory;
  }

  forget(sourceKey) {
    for (const [key, file] of this.#files) {
      if (file.sourceKey !== sourceKey) continue;
      file.closed = true;
      file.needed = 0;
      for (const record of [...file.records]) record.dispose();
      this.#files.delete(key);
    }
    this.#requestRevision();
    this.#changed?.();
  }
}
