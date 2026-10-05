/** Retry unfinished statements when their missing resource changes. */
export class MediaReadRequests {
  #requests = new Map();
  #read;
  #failed;
  #versions = new Map();
  #listeners = new Map();
  #memoryVersion = 0;

  memoryRevision() { return this.#memoryVersion; }

  subscribe(sourceKey, fileIndex, listener) {
    const key = `${sourceKey}:${fileIndex}`;
    let listeners = this.#listeners.get(key);
    if (!listeners) this.#listeners.set(key, listeners = new Set());
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#listeners.delete(key);
    };
  }

  #notify(sourceKey, fileIndex, result) {
    for (const listener of [...(this.#listeners.get(`${sourceKey}:${fileIndex}`) ?? [])]) listener(result);
  }

  constructor({ read, failed }) {
    this.#read = read;
    this.#failed = failed;
  }

  revision(sourceKey, fileIndex) {
    return this.#versions.get(`${sourceKey}:${fileIndex}`) ?? 0;
  }

  record(params, statement, result, revision = this.revision(params.sourceKey, params.fileIndex), memoryRevision = this.#memoryVersion) {
    const key = requestKey(params, statement);
    if (!["needs-ranges", "needs-memory"].includes(result.kind)) {
      this.#notify(params.sourceKey, params.fileIndex, result);
      return this.#requests.delete(key);
    }
    const existing = this.#requests.get(key);
    if (existing) { existing.params = params; existing.kind = result.kind; }
    else this.#requests.set(key, { params, statement, kind: result.kind, running: false, changed: false });
    const request = this.#requests.get(key);
    // A read can change from missing memory to missing bytes. An event for
    // its previous resource cannot authorize another read of unchanged bytes.
    request.changed = result.kind === "needs-memory"
      ? memoryRevision !== this.#memoryVersion : revision !== this.revision(params.sourceKey, params.fileIndex);
    if (request.changed) {
      if (!request.running) queueMicrotask(() => { if (!request.running) void this.#retry(request); });
    }
  }

  memoryChanged() {
    this.#memoryVersion++;
    for (const request of this.#requests.values()) {
      if (request.kind !== "needs-memory") continue;
      // The retried statement announces its result. A memory event is not a
      // source change for another statement still waiting for missing bytes.
      request.changed = true;
      if (!request.running) void this.#retry(request);
    }
  }

  bytesChanged(sourceKey, fileIndex) {
    const fileKey = `${sourceKey}:${fileIndex}`;
    this.#versions.set(fileKey, this.revision(sourceKey, fileIndex) + 1);
    this.#notify(sourceKey, fileIndex, { kind: "bytes-changed" });
    for (const request of this.#requests.values()) {
      if (request.params.sourceKey !== sourceKey || request.params.fileIndex !== fileIndex) continue;
      if (request.kind !== "needs-ranges") continue;
      request.changed = true;
      if (!request.running) void this.#retry(request);
    }
  }

  forget(sourceKey, fileIndex) {
    for (const key of [...this.#listeners.keys()]) {
      if (fileIndex === undefined ? key.startsWith(`${sourceKey}:`) : key === `${sourceKey}:${fileIndex}`) {
        for (const listener of [...this.#listeners.get(key)]) listener({ kind: "cancelled", reason: "source-forgotten" });
        this.#listeners.delete(key);
      }
    }
    for (const [key, request] of this.#requests) {
      if (request.params.sourceKey === sourceKey && (fileIndex === undefined || request.params.fileIndex === fileIndex)) {
        this.#requests.delete(key);
      }
    }
    for (const key of this.#versions.keys()) {
      if (fileIndex === undefined ? key.startsWith(`${sourceKey}:`) : key === `${sourceKey}:${fileIndex}`) this.#versions.delete(key);
    }
  }

  retain(sourceKey, fileIndex, wanted) {
    for (const [key, request] of this.#requests) {
      if (request.params.sourceKey === sourceKey && request.params.fileIndex === fileIndex &&
        !wanted(request.params, request.statement)) this.#requests.delete(key);
    }
  }

  async #retry(request) {
    request.running = true;
    const key = requestKey(request.params, request.statement);
    try {
      while (request.changed && this.#requests.get(key) === request) {
        request.changed = false;
        await this.#read(request.params, request.statement);
      }
    } catch (error) {
      this.#failed?.(request.params, request.statement, error);
    } finally {
      request.running = false;
    }
  }
}

function requestKey(params, statement) {
  return JSON.stringify([params.sourceKey, params.fileIndex, statement, params.requestId ?? null]);
}
