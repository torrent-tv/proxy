/** One shared keyframe table per source file. Reads use available bytes only. */

import { KeyframeTable } from "./container/KeyframeTable.js";
import { isUnavailable } from "./container/unavailable.js";
import { IndexMemoryUnavailable } from "./container/memory-unavailable.js";
import { logger as defaultLogger } from "../../utils/logger.js";

export class KeyframeTables {
  /** One per file, handed out rather than copied. @type {Map<string, KeyframeTable>} */
  #byFile = new Map();

  /** The read in flight, so the second asker joins it. @type {Map<string, Promise<KeyframeTable>>} */
  #reading = new Map();

  /** @type {((params: { sourceKey: string, fileIndex: number }) => Promise<object | null>) | null} */
  #readTable;

  /** @type {{ info: Function, warn: Function }} */
  #logger;

  /**
   * @param {object} [params]
   * @param {(params: { sourceKey: string, fileIndex: number }) => Promise<object | null>} [params.readTable] -
   *   Whatever can answer what this file's container states. The whole of this
   *   object's outside world.
   * @param {{ info: Function, warn: Function }} [params.logger]
   */
  constructor({ readTable = null, logger = defaultLogger } = {}) {
    this.#readTable = typeof readTable === "function" ? readTable : null;
    this.#logger = logger;
  }

  /**
   * @param {string} sourceKey
   * @param {number} fileIndex
   * @returns {string}
   */
  static keyFor(sourceKey, fileIndex) {
    return `${sourceKey}:${fileIndex}`;
  }

  /**
   * This file's table — the one object everyone reading it holds.
   *
   * Made empty on first ask rather than on first answer, so a session created
   * before the read finishes holds the very object the answer lands in. Handing
   * out a value instead is what used to leave a late table unreachable to the
   * sessions that needed it most.
   *
   * @param {{ sourceKey: string, fileIndex: number }} params
   * @returns {KeyframeTable}
   */
  of({ sourceKey, fileIndex }) {
    const key = KeyframeTables.keyFor(sourceKey, fileIndex);
    let table = this.#byFile.get(key);
    if (!table) {
      table = new KeyframeTable();
      this.#byFile.set(key, table);
    }
    return table;
  }

  /**
   * Fill in the file's table, reading once however many ask.
   *
   * Rejects when the read rejects — see point 3 in the file comment.
   *
   * @param {{ sourceKey: string, fileIndex: number, logName?: string }} params
   * @returns {Promise<KeyframeTable>}
   */
  async read({ sourceKey, fileIndex, logName = "" }) {
    const key = KeyframeTables.keyFor(sourceKey, fileIndex);
    const table = this.of({ sourceKey, fileIndex });
    if (table.answered) {
      return table;
    }
    const running = this.#reading.get(key);
    if (running) {
      return running;
    }
    if (!this.#readTable) {
      // Nothing can answer. NOT recorded as an answer about the file: this is
      // an object built without its one connection to the outside, and saying
      // "this file has no keyframes" on that basis would be a statement about
      // the wiring dressed up as a statement about the bytes.
      return table;
    }
    // The WHOLE wait, as whoever asked for the table experiences it: the swarm
    // delivering the head and tail of the file, the parse over those bytes, and
    // the crossing to the torrent thread and back. The worker's own line
    // (`container-keyframes:`) reports the last two apart from the first, and
    // reading the two lines as one figure is what led to a wrong conclusion on
    // 2026-09-04 — they differ by up to sixty seconds on a thin swarm.
    const startedMs = Date.now();
    // Called here and not inside a `.then`, so that "one read per file" is true
    // at the instant the second asker arrives rather than one microtask later.
    // A reader that throws synchronously is a failed read like any other.
    let started;
    try {
      started = Promise.resolve(this.#readTable({ sourceKey, fileIndex }));
    } catch (error) {
      started = Promise.reject(error);
    }
    const work = started
      .then((reading) => {
        if (this.#byFile.get(key) !== table) throw new DOMException("Keyframe request was withdrawn.", "AbortError");
        table.learn({
          times: Array.isArray(reading?.times) ? reading.times : null,
          tolerance: reading?.tolerance,
          // Which container answered, whether or not it produced a table: the
          // refusal that follows names it, and "unknown" would make that line
          // say nothing about the file it is refusing.
          format: reading?.format ?? "unrecognised"
        });
        this.#logger.info(
          `keyframe index "${logName}": ${table.readable ? `${table.count} times` : "none"} from the ` +
            `${table.format} container, waited ${Date.now() - startedMs}ms`
        );
        return table;
      })
      .catch((error) => {
        if (isUnavailable(error)) {
          this.#logger.info(
            `keyframe index "${logName}": not downloaded yet after ${Date.now() - startedMs}ms — ` +
              "read again when pieces of the file arrive"
          );
        } else if (error instanceof IndexMemoryUnavailable) {
          this.#logger.info(`keyframe index "${logName}": waiting for ${error.bytes} additional allocation bytes`);
        } else {
          this.#logger.warn(
            `keyframe index "${logName}": the read failed after ${Date.now() - startedMs}ms — ` +
              `${error?.message ?? error}`
          );
        }
        throw error;
      })
      .finally(() => {
        if (this.#reading.get(key) === work) this.#reading.delete(key);
      });
    this.#reading.set(key, work);
    return work;
  }

  /**
   * Start the read without waiting for it and without ever rejecting.
   *
   * The index lives at the END of a Matroska file, which is also where the
   * codec probe reads — both wait for the same piece to arrive, and they used
   * to do it one after the other: measured 2026-08-04, a probe of 722-1206 ms
   * followed by an index read of 311-430 ms, all of it before the first
   * segment. Started together, the second costs nothing.
   *
   * @param {{ sourceKey: string, fileIndex: number, logName?: string }} params
   * @returns {Promise<void>}
   */
  async warm(params) {
    try {
      await this.read(params);
    } catch {
      // Best effort by construction: nobody is waiting for this answer yet.
    }
  }

  /**
   * Read again a table somebody asked for and nobody has answered.
   *
   * Called when pieces of the file arrive. A table nobody asked for is left
   * alone — this is not a reason to read every file of a torrent — and one
   * already read, or being read, is not touched.
   *
   * @param {{ sourceKey: string, fileIndex: number, logName?: string }} params
   * @returns {void}
   */
  readAgainIfUnanswered(params) {
    const key = KeyframeTables.keyFor(params.sourceKey, params.fileIndex);
    const table = this.#byFile.get(key);
    if (!table || table.answered || this.#reading.has(key)) {
      return;
    }
    void this.warm(params);
  }

  /** Available-byte reads do not replace copying after elapsed time. */
  async within(params) {
    try {
      const table = await this.read(params);
      return { table, arrived: table.answered };
    } catch (error) {
      if (isUnavailable(error) || error instanceof IndexMemoryUnavailable) {
        const table = this.of(params);
        return { table, arrived: table.answered };
      }
      throw error;
    }
  }

  /**
   * Take in a table found by something other than the reader — the packet
   * probe, which finds keyframes by decoding, where no container index exists.
   *
   * @param {{ sourceKey: string, fileIndex: number }} params
   * @param {{ times?: number[] | null, tolerance?: number, format?: string }} reading
   * @returns {KeyframeTable} The file's table, as it now stands.
   */
  learn(params, reading) {
    return this.of(params).learn(reading);
  }

  /**
   * Drop every table nobody holds any more.
   *
   * Swept by the OBJECT, the way the timelines, the outputs and the source
   * files beside it are: what must survive is what a live session points at,
   * and that is a reference rather than a string that happens to match one. A
   * map that only ever grows is the shape of half the memory faults recorded in
   * this repository.
   *
   * **A file whose read is still running is kept whatever the set says.** Drop
   * it and the read completes into an object nobody holds, the next asker makes
   * a fresh empty one, and the whole wait — up to a minute off a thin swarm —
   * is paid again for an answer this process already had. That is also the
   * window in which a table warmed by the playback planner has no session yet.
   *
   * @param {Set<import("./container/KeyframeTable.js").KeyframeTable>} inUse
   * @returns {number} How many were dropped.
   */
  forgetUnused(inUse) {
    let dropped = 0;
    for (const [key, table] of [...this.#byFile.entries()]) {
      if (inUse.has(table) || this.#reading.has(key)) {
        continue;
      }
      this.#byFile.delete(key);
      dropped += 1;
    }
    return dropped;
  }

  /**
   * @param {string} sourceKey
   * @param {number} [fileIndex] - Absent, every file of this torrent.
   * @returns {void}
   */
  forget(sourceKey, fileIndex) {
    if (fileIndex === undefined) {
      for (const key of [...this.#byFile.keys()]) {
        if (key.startsWith(`${sourceKey}:`)) {
          this.#byFile.delete(key);
          this.#reading.delete(key);
        }
      }
      return;
    }
    const key = KeyframeTables.keyFor(sourceKey, fileIndex);
    this.#byFile.delete(key);
    this.#reading.delete(key);
  }

  /** @returns {number} */
  get size() {
    return this.#byFile.size;
  }
}
