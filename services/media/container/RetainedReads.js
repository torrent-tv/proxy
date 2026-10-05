import { IndexMemoryUnavailable } from "./memory-unavailable.js";

/** Retained declaration ranges reserve memory before reading and share retries. */
export class RetainedReads {
  #allocation;
  #ranges = new Map();
  #held = 0;
  #closed = false;

  constructor(memory = {}) {
    this.#allocation = memory.forRecord?.(this, "declarations") ?? memory;
  }

  async read(start, end, read) {
    if (this.#closed) throw new Error("Metadata source was forgotten.");
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      throw new TypeError("Retained metadata requires an exact byte range.");
    }
    const key = `${start}:${end}`;
    if (this.#ranges.has(key)) return this.#ranges.get(key);
    const bytes = end - start + 1;
    if (this.#allocation.reserve?.(bytes) === false) throw new IndexMemoryUnavailable(bytes);
    this.#held += bytes;
    const pending = Promise.resolve().then(() => read(start, end)).then(value => {
      if (this.#closed) throw new Error("Metadata source was forgotten during its read.");
      if (!value || value.length !== bytes) throw new Error("Retained metadata read is incomplete.");
      if (value.byteOffset === 0 && value.buffer.byteLength === bytes && value.buffer instanceof ArrayBuffer) return value;
      const owned = Buffer.allocUnsafeSlow(bytes);
      owned.set(value);
      return owned;
    }).catch(error => {
      this.#ranges.delete(key);
      if (!this.#closed) {
        this.#held -= bytes;
        this.#allocation.release?.(bytes);
      }
      throw error;
    });
    this.#ranges.set(key, pending);
    return pending;
  }

  dispose() {
    if (this.#closed) return;
    this.#closed = true;
    this.#ranges.clear();
    this.#allocation.release?.(this.#held);
    this.#held = 0;
    this.#allocation.dispose?.();
  }
}
