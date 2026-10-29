/**
 * The bytes an active playback forecast says must remain available on disk.
 * Viewers of one output share its stored bytes, so its demand is the largest
 * live viewer demand; distinct outputs add their requirements.
 */
export class PlaybackStorageDemand {
  #byOutput = new Map();
  #changed;

  constructor(changed = () => {}) {
    this.#changed = changed;
  }

  /** @returns {number} */
  bytes() {
    let total = 0;
    for (const viewers of this.#byOutput.values()) {
      let shared = 0;
      for (const bytes of viewers.values()) shared = Math.max(shared, bytes);
      total += shared;
    }
    return total;
  }

  /** @param {string} outputKey @returns {number} */
  bytesExcept(outputKey) {
    let total = 0;
    for (const [key, viewers] of this.#byOutput) {
      if (key === outputKey) continue;
      let shared = 0;
      for (const bytes of viewers.values()) shared = Math.max(shared, bytes);
      total += shared;
    }
    return total;
  }

  /** @param {string} outputKey @param {string} consumerId @param {number} bytes */
  note(outputKey, consumerId, bytes) {
    if (!outputKey || !consumerId || !Number.isFinite(bytes) || bytes < 0) return;
    const before = this.bytes();
    let viewers = this.#byOutput.get(outputKey);
    if (!viewers) {
      viewers = new Map();
      this.#byOutput.set(outputKey, viewers);
    }
    viewers.set(consumerId, bytes);
    this.#notifyIfChanged(before);
  }

  /** @param {string} outputKey @param {string} consumerId */
  release(outputKey, consumerId) {
    const viewers = this.#byOutput.get(outputKey);
    if (!viewers?.has(consumerId)) return;
    const before = this.bytes();
    viewers.delete(consumerId);
    if (viewers.size === 0) this.#byOutput.delete(outputKey);
    this.#notifyIfChanged(before);
  }

  #notifyIfChanged(before) {
    const after = this.bytes();
    if (after !== before) this.#changed(after);
  }
}
