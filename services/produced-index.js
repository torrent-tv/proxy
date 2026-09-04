/**
 * @file One statement of what an output has produced.
 *
 * Every run of an output writes into that output's own directory, and there is
 * exactly one. Two runs cannot want the same name because they are given
 * stretches that do not overlap — which is what replaced the directory-per-run
 * scheme that once kept them apart, and with it the whole notion of a run
 * having a place of its own.
 *
 * Three places used to ask what has been produced, and each answered for
 * itself: the look-ahead counted numbers, the serving path looked for a file,
 * the header derivation listed names. Two of them held opposite beliefs about
 * one file for ten minutes on 2026-09-03 — a segment a killed run had opened
 * and never written was a NAME to one and an empty file to the other, so the
 * encoder was stopped for having produced it while the request for it was
 * refused for its being unwritten. That defect is fixed; what allowed it was
 * three rules with no shared definition, and this is the shared definition.
 *
 * It is also what those three cost. Every one of them listed the directory on
 * the thread that carries the data channel — 1350 files for a 90-minute film,
 * on every segment request. A directory's modification time changes when an
 * entry is added or removed, so this asks THAT and re-reads only when it has
 * moved. A quiet request costs one `stat` instead of a listing plus a `stat`
 * per file.
 */

import path from "node:path";
import { readdirSync, statSync } from "node:fs";

/**
 * What an output's directory holds.
 *
 * @typedef {object} DirectoryContents
 * @property {number} readAt - The directory's modification time when it was read.
 * @property {Map<string, string>} byName - File name to full path, every file.
 * @property {Map<number, string>} byNumber - Segment number to full path, only
 *   for segments carrying bytes.
 */

/**
 * What an output has produced, and where.
 *
 * Not a cache of a truth kept elsewhere: this IS where the answer lives, and
 * the disk is read only to build it and to notice that it has moved on.
 */
export class ProducedIndex {
  /** @type {string} */
  #dirPath;

  /** @type {{ isSegmentFileName: (name: string) => boolean, segmentIndexFromName: (name: string) => number }} */
  #segmentFormat;

  /** @type {DirectoryContents | null} */
  #contents = null;

  /**
   * Paths already seen carrying bytes. A piece that has bytes never loses them,
   * so this answer never has to be taken back — which is what makes it worth
   * keeping.
   *
   * @type {Set<string>}
   */
  #nonEmpty = new Set();

  /**
   * How many times the directory has been listed.
   *
   * The whole point of this class is that the answer is (nearly) one per change
   * rather than one per request, and a claim like that is worth being able to
   * check rather than believe.
   */
  #directoryReads = 0;

  /**
   * @param {object} options
   * @param {string} options.dirPath - The output's directory. Every run writes
   *   straight into it.
   * @param {{ isSegmentFileName: (name: string) => boolean, segmentIndexFromName: (name: string) => number }} options.segmentFormat
   */
  constructor({ dirPath, segmentFormat }) {
    this.#dirPath = dirPath;
    this.#segmentFormat = segmentFormat;
  }

  /** How many times the directory has been listed. @returns {number} */
  get directoryReads() {
    return this.#directoryReads;
  }

  /** Where the output writes. @returns {string} */
  get dirPath() {
    return this.#dirPath;
  }

  /**
   * Bring the index up to date with the disk, reading only if it has moved.
   *
   * @returns {void}
   */
  refresh() {
    let changedAt;
    try {
      changedAt = statSync(this.#dirPath).mtimeMs;
    } catch {
      this.#forget();
      return;
    }
    if (this.#contents?.readAt === changedAt) {
      return;
    }
    this.#read(changedAt);
  }

  /**
   * Where a produced file is, or null when nothing has written it.
   *
   * @param {string} fileName
   * @returns {string | null}
   */
  pathOf(fileName) {
    this.refresh();
    return this.#contents?.byName.get(fileName) ?? null;
  }

  /**
   * Every segment number the output holds with bytes in it.
   *
   * @returns {Set<number>}
   */
  segmentNumbers() {
    this.refresh();
    return new Set(this.#contents?.byNumber.keys() ?? []);
  }

  /**
   * Every produced file name.
   *
   * @returns {string[]}
   */
  fileNames() {
    this.refresh();
    return [...(this.#contents?.byName.keys() ?? [])];
  }

  /**
   * Forget what is held, so the next question re-reads the disk.
   *
   * Used where a file has just been removed on purpose: the directory's own
   * time has moved, so a refresh would find it anyway, but a caller that
   * deletes a file and asks in the same tick should not be told it is there.
   *
   * @returns {void}
   */
  invalidate() {
    this.#forget();
  }

  /**
   * Read the directory into the index.
   *
   * @param {number} changedAt
   * @returns {void}
   */
  #read(changedAt) {
    let names;
    try {
      names = readdirSync(this.#dirPath, { withFileTypes: false });
      this.#directoryReads += 1;
    } catch {
      this.#forget();
      return;
    }
    /** @type {DirectoryContents} */
    const contents = { readAt: changedAt, byName: new Map(), byNumber: new Map() };
    for (const name of names) {
      const full = path.join(this.#dirPath, name);
      if (!this.#segmentFormat.isSegmentFileName(name)) {
        contents.byName.set(name, full);
        continue;
      }
      const index = this.#segmentFormat.segmentIndexFromName(name);
      if (index < 0) {
        continue;
      }
      if (!this.#nonEmpty.has(full)) {
        let size = 0;
        try {
          size = statSync(full).size;
        } catch {
          continue; // Vanished between the listing and the question.
        }
        if (size === 0) {
          continue; // Opened, nothing written into it yet — or ever.
        }
        this.#nonEmpty.add(full);
      }
      contents.byName.set(name, full);
      contents.byNumber.set(index, full);
    }
    const previous = this.#contents;
    if (previous) {
      for (const held of previous.byName.values()) {
        if (!contents.byName.has(path.basename(held))) {
          this.#nonEmpty.delete(held);
        }
      }
    }
    this.#contents = contents;
  }

  /**
   * Drop everything the index answered for.
   *
   * @returns {void}
   */
  #forget() {
    for (const held of this.#contents?.byName.values() ?? []) {
      this.#nonEmpty.delete(held);
    }
    this.#contents = null;
  }
}
