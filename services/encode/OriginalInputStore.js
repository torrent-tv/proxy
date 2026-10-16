/** Copied, admitted file ranges shared by live inputs and HTTP responses. */
export class OriginalInputStore {
  #files = new Map();
  #owners = new Map();
  #parts = new Set();
  #changed;

  constructor({ changed = () => {} } = {}) { this.#changed = changed; }

  get bytes() { return [...this.#parts].reduce((sum, part) => sum + (part.charged ? sizeOf(part) : 0), 0); }
  get required() { return [...this.#parts].reduce((sum, part) => sum + (part.charged && (part.refs || part.loading) ? sizeOf(part) : 0), 0); }

  #file(source) {
    const key = JSON.stringify([source.sourceKey, source.fileIndex]);
    if (!this.#files.has(key)) this.#files.set(key, { key, parts: [], owners: new Set() });
    return this.#files.get(key);
  }

  /** Keep common parts across seeks while an output of this file exists. */
  retain(owner, sources) {
    const files = this.#owners.get(owner) ?? new Set();
    for (const source of sources) {
      const file = this.#file(source);
      file.owners.add(owner);
      files.add(file);
    }
    this.#owners.set(owner, files);
  }

  forget(owner) {
    for (const file of this.#owners.get(owner) ?? []) {
      file.owners.delete(owner);
      for (const part of [...file.parts]) this.#discardUnused(part);
      this.#prune(file);
    }
    this.#owners.delete(owner);
  }

  /** Unused common bytes are wanted, never required, and can leave for room. */
  trim(limit) {
    let bytes = this.bytes;
    for (const part of this.#parts) {
      if (bytes <= limit) break;
      if (part.refs || part.loading) continue;
      bytes -= part.charged ? sizeOf(part) : 0;
      this.#discard(part);
    }
  }

  #prune(file) {
    if (!file.parts.length && !file.owners.size) this.#files.delete(file.key);
  }

  #discard(part) {
    part.charged = false;
    part.buffer = null;
    part.ensure = null;
    this.#parts.delete(part);
    const position = part.file.parts.indexOf(part);
    if (position >= 0) part.file.parts.splice(position, 1);
    this.#prune(part.file);
    this.#changed();
  }

  #discardUnused(part) {
    if (part.refs || part.loading) return;
    if (!part.failed && part.buffer && part.common && part.file.owners.size) return;
    this.#discard(part);
  }

  #unpin(parts) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const part of parts) { part.refs--; this.#discardUnused(part); }
    };
  }

  /** Protect existing bytes during an asynchronous budget revision. */
  protect(sources) {
    const parts = new Set();
    for (const source of sources) {
      for (const part of this.#file(source).parts) {
        if (source.input.ranges.some(([start, end]) => start <= part.end && end >= part.start)) parts.add(part);
      }
    }
    for (const part of parts) part.refs++;
    return this.#unpin(parts);
  }

  available(source) {
    const file = this.#files.get(JSON.stringify([source.sourceKey, source.fileIndex]));
    return (file?.parts ?? []).filter(part => !part.failed).map(part => [part.start, part.end]);
  }

  #missing(source) {
    const file = this.#file(source);
    const missing = [];
    for (const [start, end] of source.input.ranges) {
      let at = start;
      for (const part of file.parts) {
        if (part.end < at || part.failed) continue;
        if (part.start > end) break;
        if (at < part.start) missing.push([at, Math.min(end, part.start - 1)]);
        at = Math.max(at, part.end + 1);
        if (at > end) break;
      }
      if (at <= end) missing.push([at, end]);
    }
    return missing;
  }

  bytesNeeded(sources) { return sources.reduce((sum, source) => sum + this.#missing(source).reduce((n, [start, end]) => n + end - start + 1, 0), 0); }

  /** Reserve missing ranges synchronously; a second admission sees them pending. */
  acquire(sources, room, { readRanges, now = Date.now }) {
    const additionalBytes = this.bytesNeeded(sources);
    if (additionalBytes > room) return null;
    const parts = new Set();
    const owned = new Set();
    const stats = { copiedBytes: 0, sharedBytes: 0, copyMs: 0 };
    for (const source of sources) {
      const file = this.#file(source);
      for (const [start, end] of this.#missing(source)) {
        // A common prefix must never retain the rest of a large media buffer.
        const cuts = new Set([start, end + 1]);
        for (const [first, last] of source.input.commonRanges ?? []) {
          if (first > start && first <= end) cuts.add(first);
          if (last >= start && last < end) cuts.add(last + 1);
        }
        const offsets = [...cuts].sort((a, b) => a - b);
        for (let i = 1; i < offsets.length; i++) {
          const first = offsets[i - 1], last = offsets[i] - 1;
          const part = { file, source, start: first, end: last, refs: 0, charged: true,
            common: (source.input.commonRanges ?? []).some(([a, b]) => a <= first && b >= last),
            buffer: null, loading: false, failed: false, promise: null, ensure: null };
          file.parts.push(part);
          this.#parts.add(part);
          owned.add(part);
        }
      }
      file.parts.sort((a, b) => a.start - b.start);
      for (const part of file.parts) {
        for (const [start, end] of source.input.ranges) {
          const bytes = Math.max(0, Math.min(end, part.end) - Math.max(start, part.start) + 1);
          if (!bytes) continue;
          parts.add(part);
          if (!owned.has(part)) stats.sharedBytes += bytes;
        }
      }
    }
    for (const part of parts) part.refs++;
    let released = false;
    const unpin = this.#unpin(parts);
    const copy = async (source, ranges) => {
      const selected = [...parts].filter(part => part.file.key === JSON.stringify([source.sourceKey, source.fileIndex]) &&
        ranges.some(([start, end]) => start <= part.end && end >= part.start));
      const fresh = selected.filter(part => owned.has(part) && !part.promise);
      if (fresh.length) {
        for (const part of fresh) part.loading = true;
        const startedAt = now();
        // Defer the read until every part names the same pending operation.
        const operation = Promise.resolve().then(() => readRanges(source, fresh.map(part => [part.start, part.end]), additionalBytes))
          .then(buffers => {
            if (buffers === null) return false;
            if (!Array.isArray(buffers) || buffers.length !== fresh.length || buffers.some((buffer, i) => !Buffer.isBuffer(buffer) || buffer.length !== sizeOf(fresh[i]))) {
              throw new Error("Original input reader returned incomplete ranges.");
            }
            for (let i = 0; i < fresh.length; i++) fresh[i].buffer = buffers[i];
            stats.copiedBytes += fresh.reduce((sum, part) => sum + sizeOf(part), 0);
            return true;
          }).catch(error => { for (const part of fresh) part.error = error; return false; }).then(ok => {
            stats.copyMs += Math.max(0, now() - startedAt);
            for (const part of fresh) {
              part.loading = false;
              if (!ok) { part.failed = true; this.#discard(part); }
              else this.#discardUnused(part);
            }
            return ok;
          });
        for (const part of fresh) { part.promise = operation; part.ensure = null; }
      }
      for (const part of selected) if (!part.promise) part.ensure();
      const answers = await Promise.all(selected.map(part => part.promise));
      const failure = selected.find(part => part.error);
      if (failure) throw failure.error;
      return !released && answers.every(Boolean);
    };
    for (const part of owned) part.ensure = () => copy(part.source, [[part.start, part.end]]);
    return {
      stats, additionalBytes,
      copy,
      endOf(source, start) {
        if (released) return null;
        const part = [...parts].find(part => part.file.key === JSON.stringify([source.sourceKey, source.fileIndex]) &&
          part.buffer && part.start <= start && part.end >= start);
        return part ? part.end + 1 : null;
      },
      slices(source, start, end, pin = false) {
        if (released) return null;
        const selected = [...parts].filter(part => part.file.key === JSON.stringify([source.sourceKey, source.fileIndex]) && part.start <= end && part.end >= start)
          .sort((a, b) => a.start - b.start);
        if (selected.some(part => !part.buffer || part.failed)) return null;
        const buffers = selected.map(part => part.buffer.subarray(Math.max(start, part.start) - part.start, Math.min(end, part.end) - part.start + 1));
        if (buffers.reduce((sum, buffer) => sum + buffer.length, 0) !== end - start + 1) return null;
        if (pin) for (const part of selected) part.refs++;
        return { buffers, release: pin ? this.releaseParts(selected) : () => {} };
      },
      // Bound separately because slices' `this` is the lease, not the store.
      releaseParts: selected => this.#unpin(selected),
      release() { if (!released) { released = true; unpin(); } }
    };
  }
}

const sizeOf = part => part.end - part.start + 1;
