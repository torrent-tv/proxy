/**
 * @file How much of a machine's resource the stores may hold between them.
 *
 * Written once and used twice, because memory and disk are the same question
 * asked of two resources: what is free now, plus what we already hold, less
 * what everything that is not us has recently been seen to need.
 *
 * It used to exist only for memory, inside the memory store, keyed on module
 * state. Disk had no such rule at all — the spill file grew until the machine
 * did, 14.4 GB in a single viewing on 2026-08-31 — and copying the memory rule
 * across would have made two rules to keep in step. One rule, two readings.
 */

/**
 * How many observations of other processes' demand are kept.
 *
 * A window rather than a high-water: a single spike would otherwise stand for
 * the life of the process and hold the stores down long after whatever caused
 * it had finished.
 */
const OTHER_DEMAND_SAMPLES = 60;

/**
 * What everything that is not us has recently been seen to need.
 *
 * One instance per resource. A fall in what is free that we did not cause is a
 * measurement of somebody else's demand; a fall we did cause is our own doing
 * and says nothing about the machine.
 */
export class OtherDemand {
  /** @type {number[]} */
  #falls = [];

  #lastFreeBytes = 0;

  #lastHeldBytes = 0;

  /**
   * Take a reading, and answer what to reserve for others.
   *
   * @param {number} freeBytes - What the machine says is free now.
   * @param {number} heldBytes - What the stores hold of this resource now.
   * @returns {number} The reserve, in bytes.
   */
  note(freeBytes, heldBytes) {
    if (this.#lastFreeBytes > 0) {
      const fell = this.#lastFreeBytes - freeBytes;
      const ours = heldBytes - this.#lastHeldBytes;
      this.#falls.push(Math.max(0, fell - ours));
      if (this.#falls.length > OTHER_DEMAND_SAMPLES) {
        this.#falls.shift();
      }
    }
    this.#lastFreeBytes = freeBytes;
    this.#lastHeldBytes = heldBytes;
    return this.reserve();
  }

  /** @returns {number} */
  reserve() {
    return this.#falls.length === 0 ? 0 : Math.max(...this.#falls);
  }

  /** Forget the readings. For tests, which share a module. */
  forget() {
    this.#falls = [];
    this.#lastFreeBytes = 0;
    this.#lastHeldBytes = 0;
  }
}

/**
 * How much of the resource the stores may hold between them.
 *
 * What the machine reports free is what could be taken ON TOP of what is
 * already held, so the stores' own bytes are added back: the pair is the
 * ceiling the stores could reach.
 *
 * @param {number} freeBytes
 * @param {number} heldBytes
 * @param {number} reserveBytes
 * @returns {number}
 */
export function machineAllowanceBytes(freeBytes, heldBytes, reserveBytes) {
  return Math.max(0, Math.max(freeBytes, 0) + Math.max(heldBytes, 0) - Math.max(reserveBytes, 0));
}

/**
 * Divide what the machine allows between the stores, by what each is asking
 * for.
 *
 * When everyone's ask fits, everyone gets it and the machine's limit never
 * binds. When the asks do not fit, each store is cut in proportion to what it
 * asked, so a store wanting little is not cut to make room for one wanting
 * much.
 *
 * @param {number[]} wantedBytes - What each store is asking for, in order.
 * @param {number} allowanceBytes
 * @returns {number[]} What each store may hold, in the same order.
 */
export function divideAllowance(wantedBytes, allowanceBytes) {
  const total = wantedBytes.reduce((sum, want) => sum + Math.max(0, want), 0);
  if (total <= allowanceBytes || total === 0) {
    return wantedBytes.map((want) => Math.max(0, want));
  }
  return wantedBytes.map((want) => Math.floor(allowanceBytes * (Math.max(0, want) / total)));
}
