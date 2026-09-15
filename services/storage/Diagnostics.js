/**
 * @file The room the evidence takes, and the one rule that bounds it.
 *
 * Core dumps, heap snapshots and packet captures are bytes on the same disk the
 * product needs, and until 2026-09-14 every one of them was bounded by a COUNT
 * and none by a size: two dumps and five snapshots, kept by their own rules,
 * came to 3.2 GB on the addon host, and a capture of one wedge was taken
 * thirteen times in six hours. A count is not a size and cannot bound a disk —
 * the size of a dump is the size of the process, and the size of a snapshot is
 * the size of the heap.
 *
 * **They are a claimant like any other, and they are told their share.** What
 * makes them different is what happens at the boundary, and it is the whole of
 * the design here:
 *
 * 1. **over the share, collection STOPS. Nothing recorded is deleted to make
 *    room.** A dump is the only evidence of the death it records, and the
 *    machine destroying it to keep collecting would be trading the answer for
 *    the chance of another question. So a refusal is a LINE — "the evidence of
 *    this was not kept, there was no room, and here is the figure" — rather
 *    than a silence;
 * 2. **except what is superseded, which is not evidence twice.** Only where a
 *    new artifact strictly contains what an old one said. A heap snapshot taken
 *    at a HIGHER high-water records the growth the lower one recorded and more;
 *    a packet capture of a connection already captured adds nothing. Core dumps
 *    are never superseded: each is a distinct death;
 * 3. **what they ask for is measured, not a fraction.** What they hold, plus
 *    room for one more of the largest kind seen. So the claim grows as evidence
 *    accumulates and never asks for a share of a disk it has no use for.
 *
 * All of this is temporary by intention — most of this collection goes after
 * release — and that is exactly why it must not be the thing that fills a
 * viewer's disk in the meantime.
 *
 * **CORE DUMPS ARE NOT OURS TO REFUSE, and that limit is stated rather than
 * papered over.** The kernel writes them, whole address space at a time — 4.18
 * GB each on the field host — and no gate of ours is consulted. They are
 * counted here, so they take room from what the product may hold and the figure
 * is visible; what happens when one is about to be written is the kernel's
 * business. The only lever this side has is removal, and removal of a dump is
 * removal of the only evidence of a death, which rule 1 refuses. So they are
 * measured and reported, and the pruning that already keeps the newest two is
 * left where it is: changing it is a decision about evidence, not about disk.
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export class Diagnostics {
  /** @type {{ name: string, directory: () => string }[]} */
  #kinds = [];

  /** What the owner of the disk has allowed, or null before the first division. */
  #allowanceBytes = null;

  /** What the directories were last seen to weigh. */
  #heldBytes = 0;

  /** The largest single artifact seen, which is the room one more of it needs. */
  #largestBytes = 0;

  /** @type {{ info: Function, warn: Function }} */
  #logger;

  /**
   * @param {object} params
   * @param {{ name: string, directory: () => string, matches: (name: string) => boolean }[]} params.kinds -
   *   Where each kind writes and how its files are told from anything else in
   *   the same directory — the state directory holds the proxy's own small
   *   files too, and they are not evidence.
   * @param {{ info: Function, warn: Function }} [params.logger]
   */
  constructor({ kinds, logger = null }) {
    this.#kinds = Array.isArray(kinds) ? kinds : [];
    this.#logger = logger ?? { info: () => {}, warn: () => {} };
  }

  /**
   * Re-read what the evidence weighs.
   *
   * @returns {Promise<number>}
   */
  async measure() {
    let total = 0;
    let largest = this.#largestBytes;
    for (const kind of this.#kinds) {
      const directory = kind.directory();
      if (!directory) {
        continue;
      }
      let names = [];
      try {
        names = await readdir(directory);
      } catch {
        continue; // Not there yet, which is the ordinary state before a fault.
      }
      for (const name of names) {
        if (typeof kind.matches === "function" && !kind.matches(name)) {
          continue;
        }
        try {
          const size = (await stat(path.join(directory, name))).size;
          total += size;
          largest = Math.max(largest, size);
        } catch {
          // Gone between the listing and the question.
        }
      }
    }
    this.#heldBytes = total;
    this.#largestBytes = largest;
    return total;
  }

  /** What the evidence weighed when it was last measured. @returns {number} */
  held() {
    return this.#heldBytes;
  }

  /**
   * What it asks the owner of the disk for.
   *
   * What it holds, plus room for one more of the largest kind seen. A measured
   * quantity: the claim grows with the evidence rather than standing for a
   * fraction of a disk it has no use for. Before anything has been written it
   * asks for nothing, which is correct — a proxy that has never faulted needs
   * no room to record a fault it has not had.
   *
   * @returns {number}
   */
  wanted() {
    return this.#heldBytes + this.#largestBytes;
  }

  /**
   * Take the share the owner has divided out.
   *
   * @param {number} bytes
   * @returns {void}
   */
  allow(bytes) {
    this.#allowanceBytes = Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
  }

  /**
   * Whether there is room to record one more thing of this size.
   *
   * @param {object} params
   * @param {string} params.what - What would have been recorded, for the line.
   * @param {number} params.bytes - What it is expected to weigh.
   * @returns {boolean}
   */
  mayKeep({ what, bytes }) {
    if (this.#allowanceBytes === null) {
      return true;
    }
    const wanted = Math.max(0, Number(bytes) || 0);
    if (this.#heldBytes + wanted <= this.#allowanceBytes) {
      return true;
    }
    // SAID, NEVER SWALLOWED. The evidence of this fault is not being kept, and
    // an investigation that finds nothing must be able to tell "it did not
    // happen" from "we had nowhere to put it".
    this.#logger.warn(
      `diagnostics: ${what} was NOT kept — the evidence already here weighs ` +
      `${megabytes(this.#heldBytes)} of the ${megabytes(this.#allowanceBytes)} this disk can spare, ` +
      `and this would have needed ${megabytes(wanted)} more. Nothing already recorded is removed ` +
      "to make room: a dump is the only evidence of the death it records."
    );
    return false;
  }

  /**
   * Take one artifact into account without re-reading the directories.
   *
   * @param {number} bytes
   * @returns {void}
   */
  noteKept(bytes) {
    const size = Math.max(0, Number(bytes) || 0);
    this.#heldBytes += size;
    this.#largestBytes = Math.max(this.#largestBytes, size);
  }

  /**
   * What to say about the evidence in the periodic line.
   *
   * @returns {string}
   */
  describe() {
    const allowed = this.#allowanceBytes === null ? "not yet divided" : megabytes(this.#allowanceBytes);
    return `diagnostics hold ${megabytes(this.#heldBytes)} of ${allowed}`;
  }
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function megabytes(bytes) {
  return `${Math.round(Math.max(0, bytes) / (1024 * 1024))}MB`;
}
