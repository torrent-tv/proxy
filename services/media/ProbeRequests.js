import { IndexMemoryUnavailable } from "./container/memory-unavailable.js";

/** Probes repeat only after the resource they need changes. */
export class ProbeRequests {
  #files = new Map();
  #ids = new Map();
  #publish;
  #failed;
  #next = 0;
  #listeners = new Map();
  #memoryRevision = 0;

  constructor({ publish, failed }) {
    this.#publish = publish;
    this.#failed = failed;
  }

  read({ sourceKey, fileIndex, statement, probe }) {
    const key = `${sourceKey}:${fileIndex}:${statement}`;
    let request = this.#files.get(key);
    if (!request) {
      request = { key, sourceKey, fileIndex, statement, probe, revision: 0, readRevision: -1, result: null, pending: null, ranges: [] };
      this.#files.set(key, request);
    }
    if (request.pending) return request.pending;
    if (request.result && !["needs-ranges", "needs-memory"].includes(request.result.kind)) return Promise.resolve(request.result);
    if (request.result?.kind === "needs-memory" ? request.readMemoryRevision === this.#memoryRevision : request.readRevision === request.revision) return Promise.resolve(request.result);
    return this.#start(request);
  }

  subscribe(sourceKey, fileIndex, listener) {
    const key = `${sourceKey}:${fileIndex}`;
    const listeners = this.#listeners.get(key) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#listeners.delete(key);
    };
  }

  #notify(request, result) {
    for (const listener of this.#listeners.get(`${request.sourceKey}:${request.fileIndex}`) ?? []) listener(result);
  }

  withdraw(sourceKey, fileIndex) {
    for (const [key, request] of this.#files) {
      if (request.sourceKey !== sourceKey || request.fileIndex !== fileIndex ||
        (!request.pending && ["result", "terminal"].includes(request.result?.kind))) continue;
      this.#files.delete(key);
      request.controller?.abort();
      this.#notify(request, { kind: "cancelled" });
    }
  }

  needs(requestId, start, end) {
    const request = this.#ids.get(requestId);
    if (!request) return false;
    request.ranges.push([start, end]);
    request.controller.abort();
    return true;
  }

  bytesChanged(sourceKey, fileIndex) {
    for (const request of this.#files.values()) {
      if (request.sourceKey !== sourceKey || request.fileIndex !== fileIndex) continue;
      request.revision++;
      if (!request.pending && request.result?.kind === "needs-ranges") {
        void this.#start(request).catch(error => this.#failed?.(request, error));
      }
    }
  }

  memoryChanged() {
    this.#memoryRevision++;
    for (const request of this.#files.values()) {
      if (!request.pending && request.result?.kind === "needs-memory") {
        void this.#start(request).catch(error => this.#failed?.(request, error));
      }
    }
  }

  forget(sourceKey, fileIndex) {
    for (const [key, request] of this.#files) {
      if (request.sourceKey !== sourceKey || (fileIndex !== undefined && request.fileIndex !== fileIndex)) continue;
      this.#files.delete(key);
      request.controller?.abort();
      this.#notify(request, { kind: "cancelled", reason: "source-forgotten" });
    }
  }

  async #start(request) {
    const requestId = `${request.key}:${++this.#next}`;
    request.readRevision = request.revision;
    request.readMemoryRevision = this.#memoryRevision;
    request.ranges = [];
    request.controller = new AbortController();
    this.#ids.set(requestId, request);
    const pending = Promise.resolve().then(async () => {
      let value;
      try {
        value = await request.probe({ requestId, signal: request.controller.signal });
      } catch (error) {
        if (this.#files.get(request.key) !== request) return { kind: "cancelled", requestId };
        // Aborting a strict missing-byte read may reject the process promise.
        // Its ranges remain demand and must be published before retrying.
        if (error instanceof IndexMemoryUnavailable) {
          value = { kind: "needs-memory", bytes: error.bytes };
        } else if (request.ranges.length === 0) {
          value = { kind: "terminal", reason: "media-probe-failed", message: error?.message ?? String(error) };
        }
      }
      if (this.#files.get(request.key) !== request) return { kind: "cancelled", requestId };
      request.result = request.ranges.length > 0
        ? { kind: "needs-ranges", ranges: [...request.ranges], requestId }
        : ["terminal", "needs-memory"].includes(value?.kind) ? { ...value, requestId } : { kind: "result", value, requestId };
      await this.#publish({ sourceKey: request.sourceKey, fileIndex: request.fileIndex, statement: request.statement, result: request.result });
      if (this.#files.get(request.key) === request) this.#notify(request, request.result);
      return request.result;
    }).finally(() => {
      this.#ids.delete(requestId);
      request.pending = null;
      const changed = request.result?.kind === "needs-memory"
        ? this.#memoryRevision !== request.readMemoryRevision
        : request.result?.kind === "needs-ranges" && request.revision !== request.readRevision;
      if (this.#files.get(request.key) === request && changed) {
        queueMicrotask(() => {
          if (!request.pending) void this.#start(request).catch(error => this.#failed?.(request, error));
        });
      }
    });
    request.pending = pending;
    return pending;
  }
}
