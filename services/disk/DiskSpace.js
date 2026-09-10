/**
 * @file One owner of the disk, read by everything that takes any of it.
 *
 * Three things on this proxy write to the same disk and, until now, each
 * decided for itself how much it could take:
 *
 *   - the segments an encoder produces, bounded by a quarter of what was free
 *     plus a floor of 2 GB, both numbers chosen out of nothing;
 *   - the pieces the memory store spills, bounded by nothing at all — 14 400 MB
 *     written in one fifty-minute viewing, field 2026-08-31;
 *   - the diagnostics we keep on purpose (core dumps, heap snapshots, packet
 *     captures), each bounded by a COUNT and none by a size: on the addon host
 *     two dumps and five snapshots came to 3.2 GB.
 *
 * Each read the free space as though it were the only claimant, so three
 * ceilings each stood for the whole disk. This is the one place that reads it,
 * and what it hands out is a share.
 *
 * THE RULE IS THE ONE MEMORY ALREADY USES, on the other reading: what is free
 * now, plus what we already hold, less what everything that is not us has been
 * seen to need. Nothing is a fraction chosen by hand.
 */

import { OtherDemand, divideAllowance } from "../piece-store/allowance.js";

/**
 * A consumer of the disk.
 *
 * @typedef {object} DiskConsumer
 * @property {string} name - What it is called in the reading.
 * @property {() => number} held - What it holds right now, in bytes.
 * @property {() => number} wanted - What it would take if it could. A consumer
 *   that cannot say asks for what it holds, which is the honest statement of a
 *   thing that only grows when something arrives.
 * @property {(allowanceBytes: number) => void} allow - Told its share.
 */

export class DiskSpace {
  /** @type {Map<string, DiskConsumer>} */
  #consumers = new Map();

  #otherDemand = new OtherDemand();

  #readFree;

  #logger;

  /** The last division, for the reading. @type {{ name: string, held: number, allowed: number }[]} */
  #last = [];

  #freeBytes = 0;

  /**
   * @param {object} params
   * @param {() => Promise<number | null>} params.readFree - What the machine
   *   says is free on the disk these consumers share.
   * @param {{ info: (line: string) => void, warn?: (line: string) => void }} [params.logger]
   */
  constructor({ readFree, logger = null }) {
    this.#readFree = readFree;
    this.#logger = logger;
  }

  /**
   * Register a consumer. Registering twice under one name replaces it.
   *
   * @param {DiskConsumer} consumer
   * @returns {void}
   */
  register(consumer) {
    this.#consumers.set(consumer.name, consumer);
  }

  /**
   * @param {string} name
   * @returns {void}
   */
  forget(name) {
    this.#consumers.delete(name);
  }

  /**
   * Read the disk, divide it, and tell each consumer its share.
   *
   * Called on the same timer that revises memory: a disk that fills while a
   * film is playing must lower the ceilings, not keep ones taken when it was
   * empty. That is the mistake memory made until 2026-08-28, and every disk
   * ceiling on this proxy made until now.
   *
   * @returns {Promise<{ freeBytes: number, allowanceBytes: number, shares: { name: string, held: number, allowed: number }[] }>}
   */
  async revise() {
    const consumers = [...this.#consumers.values()];
    if (consumers.length === 0) {
      return { freeBytes: 0, allowanceBytes: 0, shares: [] };
    }
    const held = consumers.reduce((sum, consumer) => sum + Math.max(0, consumer.held()), 0);
    const free = await this.#readFree();
    // WITHOUT A READING, NOTHING IS ALLOWED TO GROW. A disk whose free space
    // cannot be read is not a disk with room; answering "unbounded" there is how
    // the spill file came to have no limit in the first place.
    this.#freeBytes = Number.isFinite(free) && free !== null ? Math.max(0, free) : 0;
    const reserve = this.#otherDemand.note(this.#freeBytes, held);
    const allowance = Math.max(0, this.#freeBytes + held - reserve);
    const shares = divideAllowance(
      consumers.map((consumer) => Math.max(0, consumer.wanted())),
      allowance
    );
    this.#last = consumers.map((consumer, position) => ({
      name: consumer.name,
      held: consumer.held(),
      allowed: shares[position]
    }));
    for (const [position, consumer] of consumers.entries()) {
      consumer.allow(shares[position]);
    }
    // SAID, every pass, in the series beside the memory reading. "Why is there
    // no room" was a question no log could answer: the ceilings were worked out
    // in three places and not one of them was printed beside the others.
    this.#logger?.info?.(this.describe());
    return { freeBytes: this.#freeBytes, allowanceBytes: allowance, shares: this.#last };
  }

  /**
   * One line: what the disk has, what each consumer holds, and what it may.
   *
   * Said because "why is there no room" is otherwise a question no log can
   * answer — the three ceilings were computed in three places and none of them
   * was printed beside the others.
   *
   * @returns {string}
   */
  describe() {
    if (this.#last.length === 0) {
      return "disk: nothing has claimed any yet";
    }
    const parts = this.#last.map(
      (share) => `${share.name} ${megabytes(share.held)} of ${megabytes(share.allowed)}`
    );
    return `disk: ${megabytes(this.#freeBytes)} free; ${parts.join(", ")}`;
  }
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function megabytes(bytes) {
  return `${Math.round(Math.max(0, bytes) / (1024 * 1024))}MB`;
}
