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
 * round-robin it afterwards. The library checks selections separately for each
 * wire. If that wire holds no missing piece from a non-zero selection, it falls
 * through to a zero selection. A zero priority therefore does not withhold a
 * less urgent piece from a peer that lacks the first class.
 *
 * While an urgent piece is missing, only the global first class is stated.
 * This keeps a wire that lacks those pieces from spending its requests on a
 * lower class. The first class is the most urgent missing level at its highest
 * map priority, regardless of deadlines. Every window in that class is stated
 * so peers holding different first-class pieces can all contribute. Once no
 * urgent piece is missing, conditional levels may be stated at zero.
 */

import {
  isConditional,
  piecesOf,
  Urgency,
  urgencyName
} from "../demand/index.js";
import { pieceStoreOf } from "../piece-store-of.js";
import { compareBands } from "./bands.js";

export class SwarmSelection {
  #torrent;
  #register;
  /** What was last stated to the library, so a restatement can be a no-op. */
  #stated = new Map();
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
  constructor({ torrent, register, findStore = pieceStoreOf }) {
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
   * @param {{ urgency: number, priority: number } | null} [options.firstClass] -
   *   The most urgent missing level and its highest priority across every
   *   torrent. Without it, this torrent's own.
   * @returns {{ stated: number, withdrawn: number }}
   */
  reconcile({ speculativeAllowed = !this.hasUrgentMissing(), firstClass = null } = {}) {
    const missing = this.#register.windows().filter(window => !this.#isSatisfied(window));
    const first = firstClass ?? this.missingBand();
    const strictFirstClass = first !== null && !isConditional(first.urgency);
    /** @type {Map<string, { from: number, to: number, priority: number }>} */
    const wanted = new Map();
    for (const priority of [1, 0]) {
      const ranges = [];
      for (const window of missing) {
        if (!speculativeAllowed && isConditional(window.urgency)) continue;
        // The first class is the only eligible urgent level; zero priority
        // still falls through on wires that have none of its pieces.
        const inFirstClass = first !== null && !isConditional(window.urgency)
          && window.urgency === first.urgency && window.priority >= first.priority;
        if (strictFirstClass && !inFirstClass) continue;
        if ((inFirstClass ? 1 : 0) !== priority) continue;
        const range = this.#piecesFor(window);
        if (range) ranges.push(range);
      }
      // Merged within one priority: two readers wanting the same or adjacent
      // pieces are one instruction, and an unchanged map restates nothing.
      ranges.sort((a, b) => a.from - b.from);
      const union = [];
      for (const range of ranges) {
        const previous = union.at(-1);
        if (previous && range.from <= previous.to + 1) previous.to = Math.max(previous.to, range.to);
        else union.push({ from: range.from, to: range.to, priority });
      }
      for (const range of union) wanted.set(`${range.from}-${range.to}-${priority}`, range);
      if (priority === 1) this.firstClassPieces = union.map(range => range.from === range.to ? `${range.from}` : `${range.from}-${range.to}`);
    }
    this.firstClass = first;

    let withdrawn = 0;
    for (const [key, range] of [...this.#stated]) {
      if (wanted.has(key)) {
        continue;
      }
      this.#deselect(range);
      this.#stated.delete(key);
      withdrawn += 1;
    }

    this.#cancelUnwanted(wanted.values());

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

    this.#projectIntoMemory();
    for (const window of this.#register.at(Urgency.BLOCKED)) {
      if (this.#isSatisfied(window)) continue;
      const range = this.#piecesFor(window);
      if (range) {
        try { this.#torrent.critical?.(range.from, range.to); }
        catch { /* A closing torrent cannot accept a critical selection. */ }
      }
    }
    return { stated, withdrawn };
  }

  /** Take everything back. The torrent is going, or nobody wants anything. */
  releaseAll() {
    for (const range of this.#stated.values()) {
      this.#deselect(range);
    }
    this.#stated.clear();
    this.#cancelUnwanted([]);
    const store = this.#findStore(this.#torrent);
    for (const claimant of this.#protectedInMemory) {
      store?.releaseProtection?.(claimant);
    }
    this.#protectedInMemory.clear();
  }

  /** Cancel removed blocks in this pass; the wire callback releases reservations. */
  #cancelUnwanted(ranges) {
    const wanted = [...ranges];
    for (const wire of this.#torrent.wires ?? []) {
      for (const request of [...(wire.requests ?? [])]) {
        if (wanted.some((range) => request.piece >= range.from && request.piece <= range.to)) continue;
        if (typeof wire.cancel !== "function") continue;
        try {
          wire.cancel(request.piece, request.offset, request.length);
          this.#torrent.emit?.("download-request-cancelled", {
            piece: request.piece, offset: request.offset, length: request.length, reason: "demand-withdrawn"
          });
        } catch (error) {
          this.#torrent.emit?.("download-request-cancel-failed", {
            piece: request.piece, offset: request.offset, length: request.length, error: error?.message ?? String(error)
          });
        }
      }
    }
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

  /** The highest missing map band, without choosing protocol blocks. */
  missingBand() {
    let band=null;
    for(const window of this.#register.windows()) {
      if(this.#isSatisfied(window))continue;
      if(!band||compareBands(window,band)<0)band={urgency:window.urgency,priority:window.priority,deadlineAt:window.deadlineAt};
    }
    return band;
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
   * WHAT WILL BE READ SOON, WHICH IS NOT WHAT WILL BE DOWNLOADED SOON. Memory
   * holds the first; the swarm is told the second; and the priority map states
   * the second, over the whole rest of the film.
   *
   * `AHEAD` used to reach memory, and it is exactly the speculative lead: the
   * map states one claimant per zone, so on a film with seven zones one `NEAR`
   * and four `AHEAD` arrived here as five separate holders, each covering tens
   * of megabytes. Field 2026-09-08: the store reported `5 reader(s) want 24
   * piece(s) of 25 the store may hold (widest window 17)` — the union of what
   * was declared equalled the whole capacity, so every admission had to evict a
   * piece somebody had declared, and 100 of 1395 evictions did. Beside that,
   * 6565 spills and 7575 revivals in 44 minutes with a median 0.0 s on disk, and
   * 2138 h264 parse errors on a picture that was being COPIED.
   *
   * Raising the allowance does not touch it: a lead stated over the rest of the
   * film grows to fill whatever memory it is given, and the ratio is unchanged.
   * What belongs in memory is what a READ is stopped on and the little in front
   * of it — the levels a read itself states — and those are `BLOCKED` and
   * `NEAR`.
   *
   * @returns {void}
   */
  #projectIntoMemory() {
    const store = this.#findStore(this.#torrent);
    if (!store || typeof store.protectRange !== "function") {
      return;
    }
    const holding = new Set();
    for (const urgency of [...new Set(this.#register.windows().map(window => window.urgency))]) {
      for (const window of this.#register.at(urgency)) {
        const range = this.#piecesFor(window);
        if (!range) {
          continue;
        }
        // The level goes with the range: it is what eviction compares when
        // everything resident is wanted by somebody, and dropping it here is
        // what left the store choosing by recency alone.
        // The download map is an eviction preference. Actual reads own pins;
        // declaring a whole-file tail must not set a whole-file memory floor.
        store.protectRange(window.claimant, range.from, range.to, window.urgency, window.deadlineAt, window.priority, false);
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
    const store = this.#findStore(this.#torrent);
    for (let index = range.from; index <= range.to; index += 1) {
      const present = store?.locationOf ? store.locationOf(index) !== "missing" : this.#torrent.bitfield?.get(index);
      if (!present) {
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
      this.#torrent.select?.(from, to, priority);
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
      this.#torrent.deselect?.(from, to);
    } catch {
      // silent-ok.
    }
  }

  /**
   * One line saying what the swarm has been told and why.
   *
   * @returns {string}
   */
  describe() {
    const needs = this.#register
      .windows()
      .map((window) => `${urgencyName(window.urgency)}:${window.claimant}`);
    return (
      `download: ${this.#stated.size} instruction(s) to the swarm from ` +
      `${this.#register.size} stated need(s) [${needs.join(" ")}]` +
      "; peer requests issued by WebTorrent"
    );
  }
}
