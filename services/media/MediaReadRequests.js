/**
 * Retry unfinished statements when their missing resource changes.
 *
 * ONE REFUSAL OF MEMORY ANSWERS THE STATEMENT, not one request of it. The
 * table a statement reserves belongs to the file — a soundtrack's packet table
 * is one table for every segment of it — so once a read of a statement has
 * been refused memory, the other requests of the same statement of the same
 * file wait for memory to change instead of being read and refused one by one.
 * Read one by one, a cold two-hour AVI's 1943 soundtrack segments were refused
 * in turn when the index's last piece arrived, which held the main thread for
 * 3.3 s and the budget revision that would have given the memory behind it
 * (Home Assistant 2026-10-12, torrent-tv/meta#178). A retry wave therefore
 * reads one request of each statement first and the others once it has
 * answered.
 */
export class MediaReadRequests {
  #requests = new Map();
  /** File and statement → the memory revision at which a read of it was refused memory. */
  #refusedMemory = new Map();
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
    if (result.kind === "needs-memory") this.#refusedMemory.set(statementKey(params, statement), memoryRevision);
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
    const wave = [];
    for (const request of this.#requests.values()) {
      if (request.kind !== "needs-memory") continue;
      // The retried statement announces its result. A memory event is not a
      // source change for another statement still waiting for missing bytes.
      request.changed = true;
      if (!request.running) wave.push(request);
    }
    this.#retryWave(wave);
  }

  bytesChanged(sourceKey, fileIndex) {
    const fileKey = `${sourceKey}:${fileIndex}`;
    this.#versions.set(fileKey, this.revision(sourceKey, fileIndex) + 1);
    this.#notify(sourceKey, fileIndex, { kind: "bytes-changed" });
    const wave = [];
    for (const request of this.#requests.values()) {
      if (request.params.sourceKey !== sourceKey || request.params.fileIndex !== fileIndex) continue;
      if (request.kind !== "needs-ranges") continue;
      request.changed = true;
      if (!request.running) wave.push(request);
    }
    this.#retryWave(wave);
  }

  /**
   * Retry `requests`: one of each statement of each file first, the others of
   * that statement once it has answered.
   *
   * @param {object[]} requests
   */
  #retryWave(requests) {
    const groups = new Map();
    for (const request of requests) {
      const key = statementKey(request.params, request.statement);
      const group = groups.get(key);
      if (group) group.push(request);
      else groups.set(key, [request]);
    }
    for (const [head, ...rest] of groups.values()) {
      void this.#retry(head).then(() => {
        for (const request of rest) if (!request.running) void this.#retry(request);
      });
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
    for (const key of [...this.#refusedMemory.keys()]) {
      const [refusedSource, refusedFile] = JSON.parse(key);
      if (refusedSource === sourceKey && (fileIndex === undefined || refusedFile === fileIndex)) this.#refusedMemory.delete(key);
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
        if (this.#refusedMemory.get(statementKey(request.params, request.statement)) === this.#memoryVersion) {
          // The same statement of the same file was refused memory in this
          // very state of memory: so is this one, without reading it.
          request.kind = "needs-memory";
          break;
        }
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

function statementKey(params, statement) {
  return JSON.stringify([params.sourceKey, params.fileIndex, statement]);
}
