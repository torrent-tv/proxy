/**
 * @file One statement of what a session has produced.
 *
 * A session's encoder writes segments into a directory of its own per run, and
 * a run is started afresh at every backward seek, so a session accumulates
 * `run-1`, `run-2`, … and keeps them: a segment any run ever finished is still
 * the right answer for that number, which is what lets a seek back into an
 * earlier stretch be served from disk with no restart.
 *
 * Three places used to ask what the session holds, and each answered for
 * itself: the look-ahead counted numbers, the serving path looked for a file,
 * the header derivation listed names. Two of them held opposite beliefs about
 * one file for ten minutes on 2026-09-03 — a segment a killed run had opened
 * and never written was a NAME to one and an empty file to the other, so the
 * encoder was stopped for having produced it while the request for it was
 * refused for its being unwritten. That defect is fixed; what allowed it was
 * three rules with no shared definition, and this is the shared definition.
 *
 * It is also what those three cost. Every one of them walked every run
 * directory on the thread that carries the data channel — 1350 files for a
 * 90-minute film, on every segment request. A directory's modification time
 * changes when an entry is added or removed, so this asks THAT of each run and
 * re-reads only the ones that moved. A quiet request costs one `stat` per run
 * instead of a listing plus a `stat` per file.
 *
 * Newest run wins, and that rule is applied when the question is asked rather
 * than when a directory is read: each run's contents are held separately, so
 * re-reading one run cannot overwrite what a newer one answers.
 */

import path from "node:path";
import { readdirSync, statSync } from "node:fs";

/**
 * What one run's directory holds.
 *
 * @typedef {object} RunContents
 * @property {number} readAt - The directory's modification time when it was read.
 * @property {Map<string, string>} byName - File name to full path, every file.
 * @property {Map<number, string>} byNumber - Segment number to full path, only
 *   for segments carrying bytes.
 */

/**
 * What a session has produced, and where.
 *
 * Not a cache of a truth kept elsewhere: this IS where the answer lives, and
 * the disk is read only to build it and to notice that a run has moved on.
 */
export class ProducedIndex {
  /** @type {string} */
  #dirPath;

  /** @type {{ isSegmentFileName: (name: string) => boolean, segmentIndexFromName: (name: string) => number }} */
  #segmentFormat;

  /** Run directory to what it holds. @type {Map<string, RunContents>} */
  #runs = new Map();

  /**
   * Paths already seen carrying bytes. A piece that has bytes never loses them
   * and a run rewriting a number writes into a directory of its own, so this
   * answer never has to be taken back — which is what makes it worth keeping.
   *
   * @type {Set<string>}
   */
  #nonEmpty = new Set();

  /** The run directories, newest first, as of the last listing. @type {string[]} */
  #runDirs = [];

  /** The session directory's modification time when the runs were listed. */
  #runsListedAt = -1;

  /**
   * How many times a run directory has been listed.
   *
   * The whole point of this class is that the answer is (nearly) one per change
   * rather than one per request, and a claim like that is worth being able to
   * check rather than believe.
   */
  #directoryReads = 0;

  /**
   * @param {object} options
   * @param {string} options.dirPath - The session's own directory; runs live under it.
   * @param {{ isSegmentFileName: (name: string) => boolean, segmentIndexFromName: (name: string) => number }} options.segmentFormat
   */
  constructor({ dirPath, segmentFormat }) {
    this.#dirPath = dirPath;
    this.#segmentFormat = segmentFormat;
  }

  /** How many times a run directory has been listed. @returns {number} */
  get directoryReads() {
    return this.#directoryReads;
  }

  /**
   * The run directories, newest first.
   *
   * Re-listed only when the session directory itself has changed, which happens
   * when a run is created or removed and at no other time.
   *
   * @returns {string[]}
   */
  runDirs() {
    let changedAt;
    try {
      changedAt = statSync(this.#dirPath).mtimeMs;
    } catch {
      this.#runDirs = [];
      this.#runsListedAt = -1;
      return this.#runDirs;
    }
    if (changedAt === this.#runsListedAt) {
      return this.#runDirs;
    }
    try {
      // The output's own directory first, because that is where every run
      // writes now. Runs used to be kept apart by a directory each; they are
      // kept apart by their intervals instead, so no two of them can want the
      // same number and one flat directory is correct. The `run-*` reading
      // survives only to serve what an older version of this proxy left on the
      // disk, and it comes second because anything written flat is later.
      this.#runDirs = [
        this.#dirPath,
        ...readdirSync(this.#dirPath, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && entry.name.startsWith("run-"))
          .map((entry) => entry.name)
          .sort((a, b) => Number(b.slice(4)) - Number(a.slice(4)))
          .map((name) => path.join(this.#dirPath, name))
      ];
      this.#runsListedAt = changedAt;
    } catch {
      this.#runDirs = [];
      this.#runsListedAt = -1;
    }
    return this.#runDirs;
  }

  /**
   * Bring the index up to date with the disk, reading only what has moved.
   *
   * @returns {void}
   */
  refresh() {
    const dirs = this.runDirs();
    const live = new Set(dirs);
    for (const dir of [...this.#runs.keys()]) {
      if (!live.has(dir)) {
        this.#forgetDir(dir);
      }
    }
    for (const dir of dirs) {
      let changedAt;
      try {
        changedAt = statSync(dir).mtimeMs;
      } catch {
        this.#forgetDir(dir);
        continue;
      }
      if (this.#runs.get(dir)?.readAt === changedAt) {
        continue;
      }
      this.#readDir(dir, changedAt);
    }
  }

  /**
   * Where a produced file is, or null when no run has written it.
   *
   * @param {string} fileName
   * @returns {string | null}
   */
  pathOf(fileName) {
    this.refresh();
    for (const dir of this.#runDirs) {
      const held = this.#runs.get(dir)?.byName.get(fileName);
      if (held !== undefined) {
        return held;
      }
    }
    return null;
  }

  /**
   * Every segment number some run holds with bytes in it.
   *
   * @returns {Set<number>}
   */
  segmentNumbers() {
    this.refresh();
    const numbers = new Set();
    for (const dir of this.#runDirs) {
      for (const index of this.#runs.get(dir)?.byNumber.keys() ?? []) {
        numbers.add(index);
      }
    }
    return numbers;
  }

  /**
   * Every produced file name, whatever run holds it.
   *
   * @returns {string[]}
   */
  fileNames() {
    this.refresh();
    const names = new Set();
    for (const dir of this.#runDirs) {
      for (const name of this.#runs.get(dir)?.byName.keys() ?? []) {
        names.add(name);
      }
    }
    return [...names];
  }

  /**
   * Forget what is held about a directory, so the next question re-reads it.
   *
   * Used where a file has just been removed on purpose: the directory's own
   * time has moved, so a refresh would find it anyway, but a caller that
   * deletes a file and asks in the same tick should not be told it is there.
   *
   * @param {string} [dir] - One run, or every run when not given.
   * @returns {void}
   */
  invalidate(dir) {
    if (dir === undefined) {
      for (const held of [...this.#runs.keys()]) {
        this.#forgetDir(held);
      }
      this.#runsListedAt = -1;
      return;
    }
    this.#forgetDir(dir);
  }

  /**
   * Read one run's directory into the index.
   *
   * @param {string} dir
   * @param {number} changedAt
   * @returns {void}
   */
  #readDir(dir, changedAt) {
    let names;
    try {
      names = readdirSync(dir, { withFileTypes: false });
      this.#directoryReads += 1;
    } catch {
      this.#forgetDir(dir);
      return;
    }
    /** @type {RunContents} */
    const contents = { readAt: changedAt, byName: new Map(), byNumber: new Map() };
    for (const name of names) {
      const full = path.join(dir, name);
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
    const previous = this.#runs.get(dir);
    if (previous) {
      for (const held of previous.byName.values()) {
        if (!contents.byName.has(path.basename(held))) {
          this.#nonEmpty.delete(held);
        }
      }
    }
    this.#runs.set(dir, contents);
  }

  /**
   * Drop everything a directory answered for.
   *
   * @param {string} dir
   * @returns {void}
   */
  #forgetDir(dir) {
    const contents = this.#runs.get(dir);
    if (contents) {
      for (const held of contents.byName.values()) {
        this.#nonEmpty.delete(held);
      }
    }
    this.#runs.delete(dir);
  }
}
