/**
 * @file What is wanted from one torrent right now, and by whom.
 *
 * **One statement, two consumers.** Until 2026-09-02 the same intent was
 * written down twice and reconciled by a third piece of code. A reader told the
 * piece store `protectRange(readerId, from, to)` so its bytes would not be
 * evicted from memory; it separately told the torrent `select(from, to, 1)` so
 * they would be fetched; and the pool then read the store's memory claims every
 * few seconds to rebuild the download claims WebTorrent had dropped once
 * satisfied. One want, three places, and a sweeper between two of them.
 *
 * Here it is stated once. Memory reads this to decide what to keep resident;
 * the swarm layer reads it to decide what to ask peers for. Neither owns it and
 * neither can drift from the other.
 *
 * Knows nothing about WebTorrent, nothing about the piece store, and nothing
 * about pieces — so it is testable with numbers alone.
 */

import { isConditional, Urgency, URGENCY_ORDER } from "./Urgency.js";
import { unionOf, Window } from "./Window.js";

export class DemandRegister {
  /** Claimant → the one window it currently states. */
  #windows = new Map();

  /**
   * State a need, replacing whatever that claimant said before.
   *
   * Replacing rather than adding is the point: a reader walking a film restates
   * a moving window many times a second, and if those accumulated the download
   * set would grow to the whole file within a minute.
   *
   * @param {object} params
   * @param {string} params.claimant
   * @param {number} params.fileIndex
   * @param {number} params.byteStart
   * @param {number} params.byteEnd
   * @param {number} params.urgency
   * @returns {Window}
   */
  state({ claimant, fileIndex, byteStart, byteEnd, urgency }) {
    const window = new Window({ claimant, fileIndex, byteStart, byteEnd, urgency });
    this.#windows.set(claimant, window);
    return window;
  }

  /**
   * Withdraw what a claimant said.
   *
   * Named by claimant, so a release that arrives twice, or after the claimant
   * has gone, withdraws nothing rather than somebody else's window. Must be
   * called from a `finally`: a reader that ends without withdrawing keeps the
   * swarm fetching for somebody who is no longer there.
   *
   * @param {string} claimant
   * @returns {boolean} Whether there was anything to withdraw.
   */
  withdraw(claimant) {
    return this.#windows.delete(claimant);
  }

  /** How many claimants are stating something. */
  get size() {
    return this.#windows.size;
  }

  /**
   * Every stated window, most urgent first.
   *
   * @returns {Window[]}
   */
  windows() {
    return [...this.#windows.values()].sort((left, right) => left.urgency - right.urgency);
  }

  /**
   * The windows at one level of urgency.
   *
   * @param {number} urgency
   * @returns {Window[]}
   */
  at(urgency) {
    return this.windows().filter((window) => window.urgency === urgency);
  }

  /**
   * The union of what is wanted of one file at one level, in byte ranges.
   *
   * @param {number} fileIndex
   * @param {number} urgency
   * @returns {Array<{ byteStart: number, byteEnd: number }>}
   */
  unionFor(fileIndex, urgency) {
    return unionOf(
      this.windows().filter((window) => window.fileIndex === fileIndex && window.urgency === urgency)
    );
  }

  /**
   * The union of everything wanted of one file, whatever the urgency.
   *
   * This is what memory is sized against: a piece inside any stated window will
   * be read, and evicting it means fetching it back from disk moments later.
   *
   * @param {number} [fileIndex] - Every file when omitted.
   * @returns {Array<{ byteStart: number, byteEnd: number }>}
   */
  union(fileIndex) {
    const wanted = fileIndex === undefined
      ? this.windows()
      : this.windows().filter((window) => window.fileIndex === fileIndex);
    // Ranges of different files must not be merged: byte 100 of file 0 and byte
    // 100 of file 1 are different bytes.
    const byFile = new Map();
    for (const window of wanted) {
      const list = byFile.get(window.fileIndex) ?? [];
      list.push(window);
      byFile.set(window.fileIndex, list);
    }
    return [...byFile.values()].flatMap((list) => unionOf(list));
  }

  /** Which files anybody is stating a need for. */
  files() {
    return [...new Set(this.windows().map((window) => window.fileIndex))].sort((a, b) => a - b);
  }

  /**
   * The most urgent level anybody is stating, or null when nothing is stated.
   *
   * @returns {number | null}
   */
  mostUrgent() {
    const windows = this.windows();
    return windows.length === 0 ? null : windows[0].urgency;
  }

  /**
   * Which levels should be stated to the swarm, given what is still missing.
   *
   * The three urgent levels always. The two speculative ones only while
   * everything above them is complete — and withdrawn whole the moment one is
   * not, because a withdrawn window is not in the download set at all and a
   * peer with nothing urgent to give cannot fall through to it. That is the
   * difference from a permanently low priority, which is exactly what lets a
   * peer fall through and spend the shared link on a piece nobody is waiting
   * for.
   *
   * @param {(window: Window) => boolean} isSatisfied - Whether a window has
   *   everything it asked for. Given from outside because only the torrent
   *   knows what has arrived.
   * @param {boolean} [speculativeAllowed] - Whether anything ELSEWHERE is still
   *   waiting for something urgent. False holds the speculative levels back
   *   even when this torrent has everything it needs: two films on one proxy
   *   share the link, so filling the tail of one while a viewer of the other
   *   has a still picture spends the same bandwidth twice over.
   * @returns {number[]} Levels to state, most urgent first.
   */
  levelsToState(isSatisfied, speculativeAllowed = true) {
    const stating = [];
    let everythingAboveIsSatisfied = speculativeAllowed;
    for (const urgency of URGENCY_ORDER) {
      if (isConditional(urgency) && !everythingAboveIsSatisfied) {
        break;
      }
      stating.push(urgency);
      const level = this.at(urgency);
      if (level.some((window) => !isSatisfied(window))) {
        everythingAboveIsSatisfied = false;
      }
    }
    return stating;
  }

  /** Forget everything. The torrent is going. */
  clear() {
    this.#windows.clear();
  }
}

export { Urgency };
