/**
 * @file The only thing in this proxy that tells WebTorrent what to fetch.
 *
 * One per torrent. It reads the demand register — the single statement of what
 * anybody wants — and turns it into the library's `select`, `deselect` and
 * `critical`. Nothing else calls those, so two parts of this program can no
 * longer ask for different things and overwrite each other.
 *
 * That used to happen and it is written into the code this replaces. The reader
 * held a moving window; the pool held a whole-file selection; a third place set
 * a window around the read head. A whole-file read undid a seek that had just
 * happened, and the swarm walked forward from the first hole: measured on a
 * 4.7 GB film, a seek to 89.1 % fetched 2.47 GB over 93 s before the segment
 * could be served.
 *
 * **Why urgency is not a number given to the library.** Measured against the
 * vendored 2.8.5: selections are sorted by priority only when one is inserted,
 * and `shufflePriority` then moves the selection just served to the back of the
 * whole non-zero group. Distinct numbers therefore order the list once and
 * round-robin it afterwards. So the ordering is kept HERE, by choosing what to
 * state at all, and the library is given only the distinction it honours:
 * non-zero for what is wanted now, zero for the speculative tail.
 */

import {
  isConditional,
  piecesOf,
  selectionPriority,
  Urgency,
  urgencyName
} from "../demand/index.js";
import { findSharedStore } from "../piece-store/shared-piece-store.js";

export class SwarmSelection {
  #torrent;
  #register;
  /** What was last stated to the library, so a restatement can be a no-op. */
  #stated = new Map();
  /** Pieces this instance marked for displacement, so it clears only its own. */
  #displacing = null;
  /** Claimants whose windows are currently protected in memory. */
  #protectedInMemory = new Set();
  #findStore;

  /**
   * @param {object} params
   * @param {import("webtorrent").Torrent} params.torrent
   * @param {import("../demand/index.js").DemandRegister} params.register
   * @param {(torrent: object) => object | null} [params.findStore] - How the
   *   piece store is reached. Injectable so a test can drive the memory
   *   projection without constructing a real store.
   */
  constructor({ torrent, register, findStore = findSharedStore }) {
    this.#torrent = torrent;
    this.#register = register;
    this.#findStore = findStore;
  }

  /**
   * Bring the library's download set into line with what is stated.
   *
   * Called after any change to the register and on a timer. On a timer because
   * WebTorrent DELETES a selection once every piece in it has arrived, so a
   * window that is satisfied and then reopened — the reader moved on, or a
   * piece was evicted and lost — is gone from the library while it is still
   * stated here.
   *
   * @param {object} [options]
   * @param {boolean} [options.speculativeAllowed] - Whether anything on ANY
   *   torrent is still waiting for something urgent. The registry works it out
   *   once and hands the same answer to every selection, because the link is
   *   shared and the question is not a per-torrent one.
   * @returns {{ stated: number, withdrawn: number }}
   */
  reconcile({ speculativeAllowed = true } = {}) {
    const levels = this.#register.levelsToState(
      (window) => this.#isSatisfied(window),
      speculativeAllowed
    );
    /** @type {Map<string, { from: number, to: number, priority: number }>} */
    const wanted = new Map();
    for (const urgency of levels) {
      for (const window of this.#register.at(urgency)) {
        const range = this.#piecesFor(window);
        if (!range) {
          continue;
        }
        // Merged by range and priority, not by claimant: two readers wanting
        // the same pieces are one instruction to the swarm.
        const key = `${range.from}-${range.to}-${selectionPriority(urgency)}`;
        wanted.set(key, { from: range.from, to: range.to, priority: selectionPriority(urgency) });
      }
    }

    let withdrawn = 0;
    for (const [key, range] of [...this.#stated]) {
      if (wanted.has(key)) {
        continue;
      }
      this.#deselect(range);
      this.#stated.delete(key);
      withdrawn += 1;
    }

    let stated = 0;
    for (const [key, range] of wanted) {
      // Re-stated when the library has dropped it, even though this instance
      // believes it is stated: that is the whole reason this runs on a timer.
      if (this.#stated.has(key) && this.#libraryHolds(range)) {
        continue;
      }
      this.#select(range);
      this.#stated.set(key, range);
      stated += 1;
    }

    this.#markDisplacement();
    this.#projectIntoMemory();
    return { stated, withdrawn };
  }

  /** Take everything back. The torrent is going, or nobody wants anything. */
  releaseAll() {
    for (const range of this.#stated.values()) {
      this.#deselect(range);
    }
    this.#stated.clear();
    this.#clearDisplacement();
    const store = this.#findStore(this.#torrent);
    for (const claimant of this.#protectedInMemory) {
      store?.releaseProtection?.(claimant);
    }
    this.#protectedInMemory.clear();
  }

  /**
   * What is stated right now.
   *
   * @returns {Array<{ from: number, to: number, priority: number }>}
   */
  statedRanges() {
    return [...this.#stated.values()];
  }

  /**
   * Whether anything urgent on THIS torrent has not arrived.
   *
   * Read by the registry, which asks every torrent and gives the same answer
   * back to all of them.
   *
   * @returns {boolean}
   */
  hasUrgentMissing() {
    for (const urgency of [Urgency.BLOCKED, Urgency.NEAR, Urgency.AHEAD]) {
      for (const window of this.#register.at(urgency)) {
        if (!this.#isSatisfied(window)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Permission to take a block from a slow peer, for the level being waited on
   * and nothing else.
   *
   * Cleared before it is set again, because WebTorrent never clears the flag
   * itself: a reader walking a film would otherwise leave every piece of it
   * marked, and the mark would mean nothing anywhere.
   *
   * @returns {void}
   */
  #markDisplacement() {
    const blocked = this.#register
      .at(Urgency.BLOCKED)
      .map((window) => this.#piecesFor(window))
      .filter((range) => range !== null);
    if (blocked.length === 0) {
      this.#clearDisplacement();
      return;
    }
    const from = Math.min(...blocked.map((range) => range.from));
    const to = Math.max(...blocked.map((range) => range.to));
    if (this.#displacing && this.#displacing.from === from && this.#displacing.to === to) {
      return;
    }
    this.#clearDisplacement();
    try {
      this.#torrent.critical?.(from, to);
      this.#displacing = { from, to };
    } catch {
      // silent-ok: displacement is an optimisation, and a torrent being torn
      // down is not worth failing a read over.
      this.#displacing = null;
    }
  }

  /**
   * Tell the piece store which bytes will be read soon, from the same stated
   * needs the swarm is told about.
   *
   * The second half of stating a need once. Until 2026-09-02 a reader said the
   * same thing twice — `protectRange` to the store for memory and a selection
   * to the torrent for download — and a third piece of code read the first to
   * rebuild the second. Now there is one statement and two views of it, both
   * computed here.
   *
   * Only the urgent levels. Memory holds what will be READ soon; the tail and
   * the gap behind the playhead are fetched speculatively and must not push a
   * piece the decoder is about to want out of memory.
   *
   * @returns {void}
   */
  #projectIntoMemory() {
    const store = this.#findStore(this.#torrent);
    if (!store || typeof store.protectRange !== "function") {
      return;
    }
    const holding = new Set();
    for (const urgency of [Urgency.BLOCKED, Urgency.NEAR, Urgency.AHEAD]) {
      for (const window of this.#register.at(urgency)) {
        const range = this.#piecesFor(window);
        if (!range) {
          continue;
        }
        store.protectRange(window.claimant, range.from, range.to);
        holding.add(window.claimant);
      }
    }
    for (const claimant of this.#protectedInMemory) {
      if (!holding.has(claimant)) {
        store.releaseProtection?.(claimant);
      }
    }
    this.#protectedInMemory = holding;
  }

  /** @returns {void} */
  #clearDisplacement() {
    if (!this.#displacing || !Array.isArray(this.#torrent._critical)) {
      this.#displacing = null;
      return;
    }
    for (let index = this.#displacing.from; index <= this.#displacing.to; index += 1) {
      this.#torrent._critical[index] = false;
    }
    this.#displacing = null;
  }

  /**
   * The pieces a window covers, or null when the file or the torrent cannot
   * answer yet.
   *
   * @param {import("../demand/index.js").Window} window
   * @returns {{ from: number, to: number } | null}
   */
  #piecesFor(window) {
    const file = this.#torrent?.files?.[window.fileIndex];
    if (!file) {
      return null;
    }
    return piecesOf({
      fileOffset: Number(file.offset),
      byteStart: window.byteStart,
      byteEnd: Math.min(window.byteEnd, Number(file.length) - 1),
      pieceLength: Number(this.#torrent.pieceLength)
    });
  }

  /**
   * Whether everything a window asked for has arrived.
   *
   * @param {import("../demand/index.js").Window} window
   * @returns {boolean}
   */
  #isSatisfied(window) {
    const range = this.#piecesFor(window);
    if (!range) {
      return true;
    }
    for (let index = range.from; index <= range.to; index += 1) {
      if (!this.#torrent.bitfield?.get(index)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Whether the library still holds this instruction.
   *
   * Read from its own list, because it removes a selection once satisfied and
   * says nothing about having done so.
   *
   * @param {{ from: number, to: number }} range
   * @returns {boolean}
   */
  #libraryHolds({ from, to }) {
    const items = Array.isArray(this.#torrent?._selections?._items)
      ? this.#torrent._selections._items
      : [];
    return items.some((item) => item?.from === from && item?.to === to);
  }

  /**
   * @param {{ from: number, to: number, priority: number }} range
   * @returns {void}
   */
  #select({ from, to, priority }) {
    try {
      // The private form takes the stream flag, which makes a selection several
      // claimants can hold at the same bounds; the public one merges and
      // subtracts intervals and cannot express "one of several wants this". The
      // public call is the fallback if a future version drops the private one.
      if (typeof this.#torrent._select === "function") {
        this.#torrent._select(from, to, priority, null, true);
      } else if (typeof this.#torrent.select === "function") {
        this.#torrent.select(from, to, priority);
      }
    } catch {
      // silent-ok: never fail a read because the download set refused.
    }
  }

  /**
   * @param {{ from: number, to: number }} range
   * @returns {void}
   */
  #deselect({ from, to }) {
    try {
      if (typeof this.#torrent._deselect === "function") {
        this.#torrent._deselect(from, to, true);
      } else if (typeof this.#torrent.deselect === "function") {
        this.#torrent.deselect(from, to);
      }
    } catch {
      // silent-ok.
    }
  }

  /**
   * One line saying what the swarm has been told and why.
   *
   * @returns {string}
   */
  describe(speculativeAllowed = true) {
    const stating = this.#register.levelsToState(
      (window) => this.#isSatisfied(window),
      speculativeAllowed
    );
    const speculative = stating.filter((urgency) => isConditional(urgency)).map(urgencyName);
    const needs = this.#register
      .windows()
      .map((window) => `${urgencyName(window.urgency)}:${window.claimant}`);
    return (
      `download: ${this.#stated.size} instruction(s) to the swarm from ` +
      `${this.#register.size} stated need(s) [${needs.join(" ")}]` +
      (speculative.length > 0
        ? `; ${speculative.join(" and ")} also stated — nothing urgent is missing`
        : "; nothing speculative is stated — something urgent is still missing") +
      (this.#displacing
        ? `; pieces ${this.#displacing.from}-${this.#displacing.to} may be taken from slow peers`
        : "")
    );
  }
}
