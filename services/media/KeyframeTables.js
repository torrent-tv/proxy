/**
 * @file Reading the keyframe table of a file: once, whoever asks, with a bound
 * on how long anybody waits for it.
 *
 * The table itself is `container/KeyframeTable.js`, one object per file. This is
 * the policy around filling it in, and it is a policy because three things had
 * to be true at once and each of them was learned from a field session:
 *
 * 1. **once per file, and one WAIT per file.** Two sessions created in the same
 *    moment used to miss the cache together and read the table twice — which is
 *    what two viewers opening one film do, measured 13 ms apart on 2026-09-03.
 *    Whoever asks second joins the read already running;
 * 2. **the wait is bounded, the READ is not.** A picture cannot be copied
 *    without the table, so the answer to "not yet" is to re-encode — but the
 *    read goes on, lands in the file's own table, and is there for whoever holds
 *    it. Cancelling it would make every later viewer pay the whole wait again;
 * 3. **a read that THREW is not an answer.** "The head is not downloaded" says
 *    nothing about the file; turning it into "this file has no keyframes" makes
 *    every picture of it a re-encode for as long as the process lives.
 *
 * **What it does NOT know.** Where the bytes come from. The reader is one
 * function handed in at construction — on this proxy it crosses to the torrent
 * thread, where one container per file answers the track table and the media
 * info from the same header — so this can be exercised with plain values alone.
 * It used to live in the session manager, which also carried a SECOND reader
 * that fetched the file over the proxy's own HTTP and parsed it there: a
 * transport inside a layer that must not have one, and a second answer to a
 * question with one owner.
 *
 * **Why this is not `ContainerOrchestrator`, which is the same shape and sits
 * in this directory: the THREAD, not the responsibility.** That one holds a
 * container per file and needs byte ranges to build it, so it can only live
 * where the torrent is — the worker. This lives on the main thread, where the
 * sessions are, and reaches the other across the channel. The table is
 * therefore held twice, once per thread, and the two are not equals: the
 * worker's is the parse, memoized on the container it parsed, and the main
 * thread's is the answer, which nothing in the worker ever reads back. Three
 * directories of the storage layer are kept apart for the same reason, and it
 * is stated here for the same reason too — an unexplained second home reads as
 * a second owner.
 */

import { KeyframeTable } from "./container/KeyframeTable.js";
import { logger as defaultLogger } from "../../utils/logger.js";

/**
 * How long anybody waits for the table before giving up on copying the picture.
 *
 * Measured on the addon host, 2026-09-04, over seventeen files from
 * `Dropbox/trn` — four containers, pieces from 0.25 to 16 MB, files from 0.36 to
 * 20 GB, each torrent registered fresh so nothing of it was downloaded
 * (`research/keyframe-table-read-2026-09-04.md`). Every table that arrived did
 * so within 24.8 s, most within half a second; the two files that answered
 * nothing took 120.9 s and 120.5 s.
 *
 * Those two figures are not a coincidence and they are what fixes this one:
 * they are TWO of the bound the read already has — `READ_ABANDON_MS` in
 * `torrent/worker/resume-warm.js`, one for the wait on the file's edges and
 * one for the read itself, in series. A caller waiting for two of them is the
 * defect; waiting for one is the bound, and it leaves 2.4x over the slowest
 * table that did arrive. The line printed when it fires names which case
 * happened, so the field can move it rather than an argument.
 */
export const KEYFRAME_TABLE_BUDGET_MS = 60_000;

export class KeyframeTables {
  /** One per file, handed out rather than copied. @type {Map<string, KeyframeTable>} */
  #byFile = new Map();

  /** The read in flight, so the second asker joins it. @type {Map<string, Promise<KeyframeTable>>} */
  #reading = new Map();

  /** @type {((params: { sourceKey: string, fileIndex: number }) => Promise<object | null>) | null} */
  #readTable;

  /** @type {number} */
  #budgetMs;

  /** @type {{ info: Function, warn: Function }} */
  #logger;

  /**
   * @param {object} [params]
   * @param {(params: { sourceKey: string, fileIndex: number }) => Promise<object | null>} [params.readTable] -
   *   Whatever can answer what this file's container states. The whole of this
   *   object's outside world.
   * @param {number} [params.budgetMs] - How long `within` waits.
   * @param {{ info: Function, warn: Function }} [params.logger]
   */
  constructor({ readTable = null, budgetMs = KEYFRAME_TABLE_BUDGET_MS, logger = defaultLogger } = {}) {
    this.#readTable = typeof readTable === "function" ? readTable : null;
    const declared = Number(budgetMs);
    this.#budgetMs = Number.isFinite(declared) && declared > 0 ? declared : KEYFRAME_TABLE_BUDGET_MS;
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

  /** How long a caller of `within` waits. @returns {number} */
  get budgetMs() {
    return this.#budgetMs;
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
        this.#logger.warn(
          `keyframe index "${logName}": the read failed after ${Date.now() - startedMs}ms — ` +
            `${error?.message ?? error}`
        );
        throw error;
      })
      .finally(() => {
        this.#reading.delete(key);
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
   * The same read, with a bound on how long THIS caller waits for it.
   *
   * The read is not cancelled when the bound is reached — it goes on, and it
   * lands in the table this returns, which is the file's own. What the bound
   * decides is only whether this caller waits: a copied picture cannot be cut
   * without the table, so the answer to "not yet" is to re-encode, which needs
   * no table because it places the keyframes itself.
   *
   * @param {{ sourceKey: string, fileIndex: number, logName?: string }} params
   * @returns {Promise<{ table: KeyframeTable, arrived: boolean }>} `arrived` is
   *   about THIS wait. False with an unanswered table means the read is still
   *   running, which is not the same as a file with no keyframes.
   */
  async within(params) {
    const read = this.read(params);
    let timer = null;
    const budget = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), this.#budgetMs);
      // A caller must not be held open by this timer alone.
      timer?.unref?.();
    });
    const answer = await Promise.race([read.then((table) => ({ table, arrived: true })), budget]);
    clearTimeout(timer);
    // Nothing is added here to swallow a late rejection: the race is holding a
    // handler on that promise already, and a second one would only look like it
    // was doing something.
    return answer ?? { table: this.of(params), arrived: false };
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
        }
      }
      return;
    }
    this.#byFile.delete(KeyframeTables.keyFor(sourceKey, fileIndex));
  }

  /** @returns {number} */
  get size() {
    return this.#byFile.size;
  }
}
