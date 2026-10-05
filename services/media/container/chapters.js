/** File chapter declarations and bounded, non-fetching byte access. */
import { BytesUnavailable, strictReader } from "./unavailable.js";

export class ChapterUnsupported extends Error {
  constructor(reason) { super(reason); this.name = "ChapterUnsupported"; }
}

export function chapterResult(state, extra = {}) {
  return { version: 1, state, complete: state !== "pending", selectedEditionId: null,
    editions: [], sections: [], tailContent: "unknown", ...extra };
}

/** Limits bound hostile metadata, not the media file's size. */
export const CHAPTER_LIMITS = { entries: 4096, depth: 64, textBytes: 8192, readBytes: 8 * 1024 * 1024, elements: 100000 };

export class ChapterBytes {
  constructor(held, size) {
    this.held = held;
    this.size = size;
    this.read = strictReader(held.read, size);
    this.used = 0;
    this.elements = 0;
    this.window = null;
    this.windowAt = 0;
  }

  async bytes(start, length) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > this.size) {
      throw new Error("Chapter byte range is outside the file");
    }
    if (length === 0) return Buffer.alloc(0);
    if (this.window && start >= this.windowAt && start + length <= this.windowAt + this.window.length) {
      return this.window.subarray(start - this.windowAt, start - this.windowAt + length);
    }
    const range = this.held.ranges.find(([first, last]) => first <= start && last >= start + length - 1);
    if (!range) throw new BytesUnavailable(start, start + length - 1, 0);
    // Header traversal must not copy adjacent video payloads into the metadata budget.
    const span = length;
    this.used += span;
    if (this.used > CHAPTER_LIMITS.readBytes) throw new ChapterUnsupported("chapter-read-budget");
    if (++this.elements % 64 === 0) await new Promise((resolve) => setImmediate(resolve));
    this.window = await this.read(start, start + span - 1);
    this.windowAt = start;
    return this.window.subarray(0, length);
  }

  step(depth = 0) {
    if (++this.elements > CHAPTER_LIMITS.elements || depth > CHAPTER_LIMITS.depth) {
      throw new ChapterUnsupported("chapter-structure-budget");
    }
  }
}

export function chapterSeconds(value, units) {
  const seconds = Number(value / BigInt(units)) + Number(value % BigInt(units)) / units;
  if (!Number.isFinite(seconds) || seconds > Number.MAX_SAFE_INTEGER) throw new Error("Chapter time is outside the supported numeric range");
  return seconds;
}

export function classifyChapter(titles) {
  const types = new Set();
  for (const { text } of titles) {
    const title = text.trim().toLowerCase();
    if (/^(op(?:ening)?|opening credits|opening theme|オープニング)$/.test(title)) types.add("opening");
    if (/^(ed|ending|ending theme|エンディング)$/.test(title)) types.add("ending");
    if (/^(credits|end credits|closing credits|титры)$/.test(title)) types.add("credits");
    if (/^(post[- ]credits?(?: scene)?|after[- ]credits?(?: scene)?)$/.test(title)) types.add("post-credits");
  }
  return { type: types.size === 1 ? [...types][0] : "chapter", classification: types.size === 1 ? "title-hint" : "unclassified" };
}

/** Build navigation intervals without promoting inferred ends to file facts. */
export function navigationSections(edition, duration = null) {
  const out = [];
  const walk = (chapters) => {
    for (const chapter of chapters) {
      if (chapter.enabled && !chapter.hidden) {
        const next = chapters.filter((other) => other.startSeconds > chapter.startSeconds)
          .reduce((end, other) => Math.min(end, other.startSeconds), Infinity);
        const inferred = Number.isFinite(next) ? next : duration;
        out.push({ ...chapter, children: undefined, ...classifyChapter(chapter.titles),
          displayEndSeconds: chapter.endSeconds ?? inferred,
          endSource: chapter.endSeconds !== null ? "declared" : inferred !== null ? "navigation" : "unknown",
          automaticSkipAllowed: false, evidence: "file-chapter" });
      }
      walk(chapter.children);
    }
  };
  walk(edition.chapters);
  return out.sort((a, b) => a.startSeconds - b.startSeconds || a.order - b.order);
}
