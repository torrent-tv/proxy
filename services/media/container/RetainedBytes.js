import { IndexMemoryUnavailable } from "./memory-unavailable.js";

/** Reserve a retained metadata buffer before requesting its bytes. */
export class RetainedBytes {
  #allocation;
  #held = 0;
  #closed = false;

  constructor(memory = {}) {
    this.#allocation = memory.forRecord?.(this, "declarations") ?? memory;
  }

  async read(bytes, read) {
    if (this.#closed || this.#held) throw new Error("Metadata allocation is no longer available.");
    if (this.#allocation.reserve?.(bytes) === false) throw new IndexMemoryUnavailable(bytes);
    this.#held = bytes;
    try {
      const value = await read();
      if (this.#closed) throw new Error("Metadata source was forgotten during its read.");
      return value;
    } catch (error) {
      this.#release();
      throw error;
    }
  }

  #release() {
    if (!this.#held) return;
    this.#allocation.release?.(this.#held);
    this.#held = 0;
  }

  dispose() {
    if (this.#closed) return;
    this.#closed = true;
    this.#release();
    this.#allocation.dispose?.();
  }
}
