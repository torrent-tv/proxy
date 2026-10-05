/** Exact binary index ownership and pending growth under the shared budget. */
export class IndexMemory {
  #files = new Map();
  #held = 0;
  #packetBytes = 0;
  #allowed = 0;
  #revise;
  #changed;
  #revisionQueued = false;

  constructor({ reviseBudget, changed }) {
    this.#revise = reviseBudget;
    this.#changed = changed;
  }

  held() { return this.#held; }
  packetBytes() { return this.#packetBytes; }
  wanted() {
    return this.#held + [...this.#files.values()].reduce((sum, file) => sum + Math.max(0, file.needed - file.held), 0);
  }
  required() { return this.wanted(); }

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
    file.memory = { forRecord: (record, kind = "packets") => {
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
    } };
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
