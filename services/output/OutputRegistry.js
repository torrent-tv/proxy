/**
 * @file The live outputs and the lifetime of each registry entry.
 *
 * Presence is the only statement that an output exists. Creation and access
 * times describe the registry entry, not the media, viewer or encoder, so they
 * are kept here and never copied onto the output object.
 */

export class OutputRegistry {
  #byId = new Map();
  #lifetime = new Map();
  #now;

  constructor({ now = Date.now } = {}) {
    this.#now = now;
  }

  set(id, output) {
    const known = this.#byId.get(id);
    this.#byId.set(id, output);
    if (known !== output) {
      const at = this.#now();
      this.#lifetime.set(id, { startedAt: at, lastAccessedAt: at });
    }
    return this;
  }

  get(id) {
    return this.#byId.get(id);
  }

  has(id) {
    return this.#byId.has(id);
  }

  delete(id) {
    this.#lifetime.delete(id);
    return this.#byId.delete(id);
  }

  clear() {
    this.#lifetime.clear();
    this.#byId.clear();
  }

  touch(outputOrId, at = this.#now()) {
    const id = typeof outputOrId === "string" ? outputOrId : outputOrId?.id;
    const lifetime = this.#lifetime.get(id);
    if (!lifetime || !Number.isFinite(at)) {
      return false;
    }
    lifetime.lastAccessedAt = at;
    return true;
  }

  startedAt(outputOrId) {
    const id = typeof outputOrId === "string" ? outputOrId : outputOrId?.id;
    return this.#lifetime.get(id)?.startedAt ?? null;
  }

  lastAccessedAt(outputOrId) {
    const id = typeof outputOrId === "string" ? outputOrId : outputOrId?.id;
    return this.#lifetime.get(id)?.lastAccessedAt ?? null;
  }

  expiredBefore(cutoff) {
    const ids = [];
    for (const [id, lifetime] of this.#lifetime) {
      if (lifetime.lastAccessedAt < cutoff) {
        ids.push(id);
      }
    }
    return ids;
  }

  keys() {
    return this.#byId.keys();
  }

  values() {
    return this.#byId.values();
  }

  entries() {
    return this.#byId.entries();
  }

  get size() {
    return this.#byId.size;
  }

  [Symbol.iterator]() {
    return this.#byId[Symbol.iterator]();
  }
}
