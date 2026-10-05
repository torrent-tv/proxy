/**
 * @file The one budget: how much of this machine the proxy may take, and how
 * that is divided between everything that holds bytes.
 *
 * THERE IS ONE BUDGET, AND IT IS NOT ONE NUMBER. Memory cannot be paid for with
 * disk, so what is divided is divided per RESOURCE; what there is one of is the
 * OWNER, the POLICY, and the place that reads the machine. Until 2026-09-14
 * there were two owners — the memory store divided memory inside the torrent
 * thread, `DiskSpace` divided disk on the main one — each applying the same rule
 * from `allowance.js` to its own reading, neither able to see the other.
 *
 * **Why one owner rather than two, and it is measured rather than argued.** The
 * claimants TRADE ACROSS RESOURCES. Pieces held in memory that do not fit are
 * spilled to disk — the same bytes, in whichever resource there is room for —
 * so how much memory the piece store is given decides how much disk it needs.
 * Whole files exist on disk so that pieces need not be held at all; produced
 * segments exist on disk because making them again is dear. Field 2026-08-31:
 * **14 400 MB spilled to disk in fifty minutes** while the memory store held
 * 312-424 MB. Give it memory and there is no spill to bound. Two owners cannot
 * make that trade, because neither sees both sides of it.
 *
 * **A RESOURCE IS WHAT CANNOT BE SUBSTITUTED, and disk is not one of them.**
 * Measured on the addon host 2026-09-05: `/tmp`, where the segments and the
 * spill live, is the overlay filesystem (`dev=68`); `/data`, where the
 * diagnostics live, is ext4 on the nvme (`dev=66305`). One "disk" figure
 * divided between claimants on two devices gives each of them a share of a disk
 * it is not writing to — which is what `DiskSpace` did, reading the free space
 * of the segment root alone. So a resource is named by the DEVICE its
 * claimants' directories are on, read with `statSync(dir).dev` rather than
 * guessed.
 *
 * **The policy is the operator's, stated once at startup.** Three shapes, and
 * the default is the measured one:
 *
 *   - `adaptive` (default) — what is free now, plus what we already hold, less
 *     what everything that is not us has recently been seen to need. Nothing
 *     chosen: `allowance.js` computes every term from readings;
 *   - `share` — a fraction of what is free. A chosen number, and legitimately
 *     so: it is the machine's owner saying what of their machine we may use;
 *   - `fixed` — a hard ceiling, the same;
 *
 * plus a FLOOR per resource, which is the operator saying "below this the proxy
 * is not worth running". A floor is not a licence to take: it bounds from
 * below what the policy hands out, and a claimant below its own minimum says so
 * rather than working badly in silence.
 *
 * The distinction matters because everything else in this codebase refuses
 * chosen constants. These are chosen BY THE PERSON WHOSE MACHINE IT IS, which
 * is the one kind of number that is not ours to derive.
 */

import { OtherDemand, divideAllowance } from "./allowance.js";

/**
 * One thing that holds bytes of one resource.
 *
 * @typedef {object} Claimant
 * @property {string} name - What it is called in the reading.
 * @property {string} resource - Which resource it takes.
 * @property {() => number} held - What it holds right now, in bytes.
 * @property {() => number} wanted - What it would take if it could.
 * @property {(allowanceBytes: number) => void} allow - Told its share.
 * @property {number} [minimum] - Below this it cannot do its job, and says so.
 */

/**
 * What the operator has said we may take.
 *
 * @typedef {object} BudgetPolicy
 * @property {"adaptive" | "share" | "fixed"} [kind]
 * @property {number} [share] - For `share`: the fraction of free space, 0..1.
 * @property {number} [bytes] - For `fixed`: the ceiling.
 * @property {Record<string, number>} [floors] - Per resource, the least this
 *   proxy should have. Absent, the policy's own answer stands.
 */

export class MachineBudget {
  #revisionPromise = null;
  #reviseAgain = false;
  /** Resource name → how to read what is free, and what others have needed. */
  #resources = new Map();

  /** @type {Claimant[]} */
  #claimants = [];

  /** @type {BudgetPolicy} */
  #policy;

  #logger;

  /** The last division, for the reading. @type {Map<string, { freeBytes: number, allowanceBytes: number, shares: { name: string, held: number, allowed: number, short: boolean }[] }>} */
  #last = new Map();

  /**
   * @param {object} params
   * @param {BudgetPolicy} [params.policy]
   * @param {{ info: (line: string) => void, warn?: (line: string) => void }} [params.logger]
   */
  constructor({ policy = {}, logger = null } = {}) {
    this.#policy = { kind: "adaptive", ...policy };
    this.#logger = logger;
  }

  /**
   * Say that a resource exists and how to read what is free of it.
   *
   * @param {object} params
   * @param {string} params.name
   * @param {() => Promise<number | null> | number | null} params.readFree
   * @returns {void}
   */
  defineResource({ name, readFree }) {
    if (!this.#resources.has(name)) {
      this.#resources.set(name, { readFree, otherDemand: new OtherDemand() });
      return;
    }
    this.#resources.get(name).readFree = readFree;
  }

  /**
   * Register something that holds bytes. Registering twice under one name
   * replaces it.
   *
   * @param {Claimant} claimant
   * @returns {void}
   */
  register(claimant) {
    this.#claimants = this.#claimants.filter((one) => one.name !== claimant.name);
    this.#claimants.push(claimant);
  }

  /**
   * @param {string} name
   * @returns {void}
   */
  forget(name) {
    this.#claimants = this.#claimants.filter((one) => one.name !== name);
  }

  /** Total measured policy allowance, independent of its current division. */
  capacityOf(name) {
    const reading = this.#last.get(name);
    return reading?.measured ? reading.allowanceBytes : null;
  }

  /**
   * Read every resource, divide each, and tell each claimant its share.
   *
   * @returns {Promise<Map<string, { freeBytes: number, allowanceBytes: number, shares: object[] }>>}
   */
  revise() {
    if (this.#revisionPromise) {
      this.#reviseAgain = true;
      return this.#revisionPromise;
    }
    this.#revisionPromise = (async () => {
      do {
        this.#reviseAgain = false;
        await this.#readRevision();
      } while (this.#reviseAgain);
      return this.#last;
    })().finally(() => { this.#revisionPromise = null; });
    return this.#revisionPromise;
  }

  async #readRevision() {
    for (const [name, resource] of this.#resources) {
      const claimants = this.#claimants.filter((one) => one.resource === name);
      if (claimants.length === 0) {
        continue;
      }
      const held = claimants.reduce((sum, one) => sum + Math.max(0, one.held()), 0);
      const free = await resource.readFree();
      // WITHOUT A READING, NOTHING IS ALLOWED TO GROW. A resource whose free
      // space cannot be read is not a resource with room; answering "unbounded"
      // there is how the spill file came to have no limit in the first place.
      const freeBytes = Number.isFinite(free) && free !== null ? Math.max(0, free) : 0;
      const allowanceBytes = this.#allowanceFor(name, resource, freeBytes, held);
      const shares = divideAllowance(claimants.map((one) => Math.max(0, one.wanted())), allowanceBytes,
        claimants.map(one => Math.max(0, one.required?.() ?? 0)));
      const reading = claimants.map((one, position) => ({
        name: one.name,
        held: one.held(),
        allowed: shares[position],
        short: Number.isFinite(one.minimum) && shares[position] < one.minimum
      }));
      this.#last.set(name, { freeBytes, allowanceBytes, measured: Number.isFinite(free) && free !== null, shares: reading });
      for (const [position, one] of claimants.entries()) {
        one.allow(shares[position]);
      }
      for (const share of reading.filter((one) => one.short)) {
        // SAID, because a claimant working below what it needs is a fault of
        // the machine and not of the code, and it is invisible otherwise.
        this.#logger?.warn?.(
          `budget: ${share.name} has ${megabytes(share.allowed)} of ${name}, ` +
          `below the ${megabytes(claimants.find((one) => one.name === share.name)?.minimum ?? 0)} it needs`
        );
      }
    }
    this.#logger?.info?.(this.describe());
    return this.#last;
  }

  /**
   * What the policy allows of one resource.
   *
   * @param {string} name
   * @param {{ otherDemand: OtherDemand }} resource
   * @param {number} freeBytes
   * @param {number} heldBytes
   * @returns {number}
   */
  #allowanceFor(name, resource, freeBytes, heldBytes) {
    // Noted whatever the policy, because the reading of what others need is a
    // measurement of the machine and does not stop being true when the operator
    // has named a number.
    const reserve = resource.otherDemand.note(freeBytes, heldBytes);
    const floor = Math.max(0, Number(this.#policy.floors?.[name]) || 0);
    let allowance;
    if (this.#policy.kind === "fixed") {
      allowance = Math.max(0, Number(this.#policy.bytes) || 0);
    } else if (this.#policy.kind === "share") {
      const share = Math.min(1, Math.max(0, Number(this.#policy.share) || 0));
      allowance = Math.floor((freeBytes + heldBytes) * share);
    } else {
      // What is free now, plus what we already hold, less what everything that
      // is not us has recently been seen to need.
      allowance = Math.max(0, freeBytes + heldBytes - reserve);
    }
    return Math.max(allowance, Math.min(floor, freeBytes + heldBytes));
  }

  /**
   * One line per resource: what it has, what each claimant holds and may hold.
   *
   * @returns {string}
   */
  describe() {
    if (this.#last.size === 0) {
      return "budget: nothing has claimed anything yet";
    }
    const lines = [];
    for (const [name, reading] of this.#last) {
      const parts = reading.shares.map(
        (share) => `${share.name} ${megabytes(share.held)} of ${megabytes(share.allowed)}${share.short ? " (short)" : ""}`
      );
      lines.push(`${name}: ${megabytes(reading.freeBytes)} free; ${parts.join(", ")}`);
    }
    return `budget — ${lines.join(" | ")}`;
  }
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function megabytes(bytes) {
  return `${Math.round(Math.max(0, bytes) / (1024 * 1024))}MB`;
}
