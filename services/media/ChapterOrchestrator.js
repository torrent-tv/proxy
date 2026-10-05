/** One chapter result per file; transport and storage access are injected. */
import { chapterResult, ChapterUnsupported } from "./container/chapters.js";
import { isUnavailable } from "./container/unavailable.js";

export class ChapterOrchestrator {
  constructor({ containers, fileFor, now = Date.now, onChanged = () => {} }) {
    this.containers = containers;
    this.fileFor = fileFor;
    this.now = now;
    this.onChanged = onChanged;
    this.files = new Map();
  }

  get(sourceKey, fileIndex) {
    const key = `${sourceKey}:${fileIndex}`;
    for (const [oldKey, old] of this.files) if (old.expires < this.now()) this.files.delete(oldKey);
    let entry = this.files.get(key);
    if (!entry) {
      entry = { sourceKey, fileIndex, answer: chapterResult("pending"), reading: null, expires: this.now() + 3600000 };
      this.files.set(key, entry);
    }
    entry.expires = this.now() + 3600000;
    if (!entry.answer.complete) this.warm(entry);
    return { ...entry.answer, sourceKey, fileIndex, revision: entry.revision ?? 0 };
  }

  warm(entry) {
    if (entry.reading) return;
    entry.reading = (async () => {
      let answer;
      try {
        const file = await this.fileFor(entry.sourceKey, entry.fileIndex);
        if (!file) return;
        if (file.invalid) {
          answer = chapterResult("error", { reason: "file-index-not-found" });
        } else {
        const ranges = await file.heldRanges();
        const signature = JSON.stringify(ranges);
        if (entry.signature === signature) return;
        const container = await this.containers.containerFor({ ...file, detectRange: file.readHeld });
        entry.signature = signature;
        answer = container ? await container.readChapters({ ranges, read: file.readHeld })
          : chapterResult("unsupported", { reason: "unknown-container" });
        }
      } catch (error) {
        answer = isUnavailable(error) ? chapterResult("pending", { missingRange: [error.start, error.end] })
          : error instanceof ChapterUnsupported ? chapterResult("unsupported", { reason: error.message })
          : chapterResult("error", { reason: String(error?.message ?? error) });
      }
      if (this.files.get(`${entry.sourceKey}:${entry.fileIndex}`) === entry && answer && JSON.stringify(answer) !== JSON.stringify(entry.answer)) {
        entry.answer = answer;
        entry.revision = (entry.revision ?? 0) + 1;
        this.onChanged({ sourceKey: entry.sourceKey, fileIndex: entry.fileIndex, revision: entry.revision });
      }
    })().finally(() => {
      entry.reading = null;
      if (entry.again && this.files.get(`${entry.sourceKey}:${entry.fileIndex}`) === entry) {
        entry.again = false;
        this.warm(entry);
      }
    });
  }

  arrived(sourceKey, fileIndex) {
    const entry = this.files.get(`${sourceKey}:${fileIndex}`);
    if (entry && !entry.answer.complete && entry.expires > this.now()) {
      if (entry.reading) entry.again = true;
      else this.warm(entry);
    }
  }

  forget(sourceKey, fileIndex) {
    this.files.delete(`${sourceKey}:${fileIndex}`);
  }
}
