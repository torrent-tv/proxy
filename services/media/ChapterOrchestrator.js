/** Selected-file snapshots; retries belong to the shared media request queue. */
import { chapterResult } from "./container/chapters.js";
import { IndexMemoryUnavailable } from "./container/memory-unavailable.js";

export class ChapterOrchestrator {
  constructor({ containers, fileFor, subscribe = () => () => {}, withdraw = () => {}, now = Date.now, onChanged = () => {}, failed = () => {} }) {
    Object.assign(this, { containers, fileFor, subscribe, withdraw, now, onChanged, failed });
    this.files = new Map();
  }

  get(sourceKey, fileIndex) {
    for (const old of this.files.values()) if (old.expires < this.now()) this.forget(old.sourceKey, old.fileIndex);
    const key = `${sourceKey}:${fileIndex}`;
    let entry = this.files.get(key);
    if (!entry) {
      entry = { sourceKey, fileIndex, reading: null, requested: false, bytes: 0 };
      entry.dispose = () => {
        entry.allocation?.release(entry.bytes + (entry.candidate?.length ?? 0));
        entry.allocation?.dispose();
        entry.bytes = 0;
        entry.candidate = null;
        entry.buffer = null;
      };
      this.files.set(key, entry);
      entry.unsubscribe = this.subscribe(sourceKey, fileIndex, (event) => {
        if (event.kind === "cancelled") this.forget(sourceKey, fileIndex);
        else if (!entry.requested && event.kind === "bytes-changed") this.warm(entry);
      });
    }
    entry.expires = this.now() + 3600000;
    if (!entry.requested) this.warm(entry);
    return { ...(entry.buffer ? JSON.parse(entry.buffer.toString("utf8")) : chapterResult("pending")), sourceKey, fileIndex, revision: entry.revision ?? 0 };
  }

  update(entry, result) {
    if (this.files.get(`${entry.sourceKey}:${entry.fileIndex}`) !== entry) return;
    let answer;
    if (result.value?.version === 1) answer = result.value;
    else if (result.kind === "needs-ranges") answer = chapterResult("pending", { missingRange: result.ranges[0] });
    else if (result.kind === "needs-memory") answer = chapterResult("pending", { resource: "memory", requiredBytes: result.bytes });
    else if (result.reason === "request-obsolete") return;
    else if (["format-not-supported", "chapter-not-supported"].includes(result.reason)) {
      answer = chapterResult("unsupported", { reason: result.chapterReason ?? result.reason });
    } else answer = chapterResult("error", { reason: result.message ?? result.reason });
    const buffer = result.value && entry.candidate ? entry.candidate : Buffer.from(JSON.stringify(answer));
    const charged = buffer === entry.candidate ? buffer.length : 0;
    if (entry.candidate && !charged) entry.allocation?.release(entry.candidate.length);
    entry.candidate = null;
    if (entry.buffer?.equals(buffer)) {
      entry.allocation?.release(charged);
      return;
    }
    entry.allocation?.release(entry.bytes);
    entry.bytes = charged;
    entry.buffer = buffer;
    entry.revision = (entry.revision ?? 0) + 1;
    this.onChanged({ sourceKey: entry.sourceKey, fileIndex: entry.fileIndex, revision: entry.revision });
  }

  warm(entry) {
    if (entry.reading) return;
    entry.reading = (async () => {
      const params = await this.fileFor(entry.sourceKey, entry.fileIndex);
      if (!params || this.files.get(`${entry.sourceKey}:${entry.fileIndex}`) !== entry) return;
      entry.requested = true;
      if (params.invalid) return this.update(entry, { kind: "terminal", reason: "file-index-not-found" });
      const publish = params.onReadResult;
      entry.allocation ??= params.packetMemory?.forRecord?.(entry, "declarations");
      params.acceptChapterResult = (value) => {
        const serialized = JSON.stringify(value);
        const bytes = Buffer.byteLength(serialized);
        if (entry.allocation?.reserve(bytes) === false) throw new IndexMemoryUnavailable(bytes);
        entry.candidate = Buffer.from(serialized);
      };
      params.isCurrent = () => {
        if (entry.expires <= this.now()) this.forget(entry.sourceKey, entry.fileIndex);
        return this.files.get(`${entry.sourceKey}:${entry.fileIndex}`) === entry;
      };
      params.onReadResult = async (statement, result, revision) => {
        await publish?.(statement, result, revision);
        this.update(entry, result);
      };
      await this.containers.inspect(params, "chapters");
    })().catch((error) => {
      this.failed(error);
      if (this.files.get(`${entry.sourceKey}:${entry.fileIndex}`) === entry) {
        entry.requested = false;
        this.update(entry, { kind: "terminal", reason: "chapter-request-failed", message: error.message });
      }
    }).finally(() => { entry.reading = null; });
  }

  forget(sourceKey, fileIndex) {
    for (const [key, entry] of this.files) {
      if (entry.sourceKey !== sourceKey || (fileIndex !== undefined && entry.fileIndex !== fileIndex)) continue;
      this.files.delete(key);
      entry.dispose();
      entry.unsubscribe?.();
      this.withdraw(entry.sourceKey, entry.fileIndex);
    }
  }
}
