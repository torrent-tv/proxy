import { admitInput } from "./AdmittedInput.js";

/** Event-driven preparation; a synchronous run request can take only ready input. */
export class EncodeInputs {
  #requests = new Map();
  #revision = 0;
  #held = 0;
  #allowed = 0;
  #wanted = new Map();
  #resolve;
  #read;
  #revise;
  #changed;
  #failed;
  #capacity;
  #urgent;

  constructor({ resolve, readRanges, reviseBudget, changed, failed, capacity = () => null, urgent = () => true }) {
    this.#resolve = resolve;
    this.#read = readRanges;
    this.#revise = reviseBudget;
    this.#changed = changed;
    this.#failed = failed;
    this.#capacity = capacity;
    this.#urgent = urgent;
  }

  held() { return this.#held; }
  wanted() { return this.#held + [...this.#wanted.values()].reduce((sum, bytes) => sum + bytes, 0); }
  allow(bytes) {
    const changed = this.#allowed !== Math.max(0, bytes);
    this.#allowed = Math.max(0, bytes);
    if (changed) this.#retryMemory();
  }

  #retryMemory() {
    for (const request of this.#requests.values()) {
      if (!request.pending && request.result?.kind === "needs-memory") this.#prepare(request);
    }
  }

  failureOf(output) {
    for (const request of this.#requests.values()) {
      if (request.output === output && request.result?.kind === "terminal") return request.result;
    }
    return null;
  }

  retain(output, windows) {
    for (const [key, request] of this.#requests) {
      if (request.output !== output || windows.some(window => request.from <= window.to && request.to >= window.from)) continue;
      this.#requests.delete(key);
      this.#wanted.delete(key);
      request.result?.release?.();
    }
    this.#retryMemory();
  }

  take(output, from, to) {
    const key = `${output.outputKey ?? output.id}:${from}:${to}`;
    const existing = this.#requests.get(key);
    if (existing?.result?.kind === "result") {
      this.#requests.delete(key);
      return existing.result;
    }
    if (existing?.pending || existing?.revision === this.#revision || existing?.result?.kind === "terminal") return null;
    const request = existing ?? { output, from, to, key };
    this.#requests.set(key, request);
    this.#prepare(request);
    return null;
  }

  async acquire(output, from, to) {
    const key = `${output.outputKey ?? output.id}:${from}:${to}`;
    const ready = this.take(output, from, to);
    if (ready) return ready;
    await this.#requests.get(key)?.promise;
    const request = this.#requests.get(key);
    if (request?.result?.kind !== "result") return null;
    return this.take(output, from, to);
  }

  bytesChanged() {
    this.#revision++;
    for (const request of this.#requests.values()) {
      if (!request.pending && request.result?.kind !== "result" && request.result?.kind !== "terminal") this.#prepare(request);
    }
  }

  forget(output) {
    for (const [key, request] of this.#requests) {
      if (request.output !== output) continue;
      this.#requests.delete(key);
      this.#wanted.delete(key);
      request.result?.release?.();
    }
  }

  #prepare(request) {
    request.pending = true;
    request.revision = this.#revision;
    request.promise = (async () => {
      const resolved = await this.#resolve(request.output, request.from, request.to);
      if (this.#requests.get(request.key) !== request) return;
      const result = resolved.kind === "result" ? await admitInput({
        sources: resolved.sources,
        readRanges: this.#read,
        reserve: async bytes => {
          this.#wanted.set(request.key, bytes);
          await this.#revise();
          const capacity = this.#capacity();
          if (capacity !== null && bytes > capacity && this.#urgent(request.output, request.from)) return {
            kind: "terminal", reason: "source-input-exceeds-memory-capacity", bytes, capacity
          };
          if (this.#requests.get(request.key) !== request || this.#allowed - this.#held < bytes) return null;
          this.#wanted.delete(request.key);
          this.#held += bytes;
          let released = false;
          return () => {
            if (!released) {
              released = true; this.#held -= bytes;
              queueMicrotask(() => this.#retryMemory());
            }
          };
        }
      }) : resolved;
      if (this.#requests.get(request.key) !== request) { result.release?.(); return; }
      request.result = result;
      if (result.kind === "result" || result.kind === "terminal") this.#changed(request.output, result);
    })().catch(error => {
      if (this.#requests.get(request.key) === request) {
        request.result = { kind: "terminal", reason: "input-preparation-failed", message: error.message };
        this.#failed(request.output, error);
      }
    }).finally(() => {
      request.pending = false;
      if (request.result?.kind !== "needs-memory") this.#wanted.delete(request.key);
      if (this.#requests.get(request.key) === request && request.revision !== this.#revision &&
        request.result?.kind !== "result" && request.result?.kind !== "terminal") this.#prepare(request);
    });
  }
}
