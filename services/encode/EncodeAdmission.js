/**
 * @file Whether this machine can take one more encoder, counted across every
 * output at once (roadmap item 97, step 13).
 *
 * WHAT WAS MISSING. How many encoders an output may run was answered per
 * output (`EncodeRuns.maxRunsForOutput`) and always at least one, so a second
 * output got its encoder whatever the first was already costing — and on the
 * addon host two 1080p encodes run at 0.99x and 0.98x, so opening one more
 * output slowed everybody below realtime. Nothing could refuse.
 *
 * THE UNIT is seconds of work per second of film, the one the quality offer
 * judges every step in (`EncodeCost`). An encoder costs what it costs: a
 * soundtrack is a small fraction of a re-encoded picture, and counting them as
 * processes would refuse a viewer their sound for the sake of a number. Costs
 * add, and a set of encoders is affordable when the machine, corrected for the
 * share of it nobody has priced, still makes a second of film per second:
 * `share / Σ cost >= 1`. On the addon host that reproduces the measurement it
 * is meant to hold: 1080p alone at 1.96x costs 0.51 s/s, two cost 1.02 and make
 * 0.98x, measured 0.99x and 0.98x. At 480p it is pessimistic — two at 7.12x
 * each predict 3.56x and were measured at 4.20x — and pessimistic is the side
 * a refusal may err on.
 *
 * WHO HOLDS A PLACE, and nothing is stored here to say so:
 *
 * 1. every live encoder, at the cost of its output;
 * 2. every output a present viewer is being PREPARED onto — a step being
 *    warmed, or a move to another limit of the height on screen — once per
 *    output however many viewers wait for it, and only while no encoder is
 *    running there yet, since a running one already holds its place;
 * 3. every output a present viewer is WATCHING that still has something left
 *    to make and no encoder on it yet — the output just opened for them,
 *    which the plan has not placed an encoder on in the same moment. Without
 *    it the place an output is opened on is nobody's until its first encoder
 *    starts, and two viewers opening two films in that gap are both told there
 *    is room for one (roadmap item 97, step 14).
 *
 * The second is read off the viewers' own records. A preparation is recorded
 * where it belongs, on the viewer, and the place it holds ends the moment that
 * record does: no second register to keep in step, and no release to forget
 * on one of the paths a preparation can end by.
 *
 * AN ADMITTED ENCODER IS NEVER TAKEN AWAY. A refusal only ever stops something
 * from starting; what runs keeps running. So "the admission removed an encoder
 * from an output being prepared" does not happen by construction.
 *
 * WHAT IS NOT SOLVED, stated so it is not discovered: places go to whoever
 * asks first. A second encoder on one output — one catching up behind another
 * — takes a place a viewer opening another film may be waiting for, and the
 * viewer waits until it ends.
 */

import { correctForAvailability } from "./available-share.js";

/**
 * @typedef {object} OutputLoad
 * @property {number | null} costSec - One encoder on it, in seconds of work
 *   per second of film. Null when nothing has priced it.
 * @property {string} fileKey - The file it is made from.
 * @property {number} fileCostSec - What that file costs by being fetched and
 *   delivered, once however many of its outputs are encoding.
 */

/**
 * @typedef {object} AdmissionHost
 * @property {() => Map<string, number>} liveRunsByAddress - How many encoders
 *   are alive on each output.
 * @property {() => Set<string>} preparedAddresses - Every output a present
 *   viewer is being prepared onto.
 * @property {() => Set<string>} [watchedAddresses] - Every output a present
 *   viewer is watching that still has something left to make.
 * @property {(address: string) => OutputLoad | null} loadOf
 * @property {(spec: object, file: object) => OutputLoad | null} [loadForCandidate]
 * @property {() => ({ share: number, known: boolean } | null)} availability
 */

export class EncodeAdmission {
  /** @type {AdmissionHost} */
  #host;

  /**
   * @param {AdmissionHost} host
   */
  constructor(host) {
    for (const name of ["liveRunsByAddress", "preparedAddresses", "loadOf", "availability"]) {
      if (typeof host?.[name] !== "function") {
        throw new TypeError(`EncodeAdmission requires ${name}`);
      }
    }
    this.#host = host;
  }

  /**
   * Seconds of film per second this machine makes of each output while all of
   * this is running, corrected for what nobody has priced.
   *
   * @param {number} costSec
   * @returns {number}
   */
  #speedAt(costSec) {
    if (!(costSec > 0)) {
      return Number.POSITIVE_INFINITY;
    }
    return correctForAvailability(1 / costSec, this.#host.availability());
  }

  /**
   * What everything holding a place costs, leaving one output out.
   *
   * @param {string | null} except
   * @param {string | null} [exceptFileKey] - Leave out every output of this file.
   * @returns {{ costSec: number, files: Set<string>, unpriced: string[] }}
   */
  #occupied(except, exceptFileKey = null) {
    const live = this.#host.liveRunsByAddress();
    /** @type {Map<string, number>} */
    const units = new Map();
    for (const [address, count] of live) {
      if (address !== except && count > 0) {
        units.set(address, count);
      }
    }
    for (const address of this.#heldWithoutRun()) {
      if (address !== except && !units.has(address)) {
        units.set(address, 1);
      }
    }
    let costSec = 0;
    const files = new Set();
    const unpriced = [];
    for (const [address, count] of units) {
      const load = this.#host.loadOf(address);
      if (exceptFileKey && load?.fileKey === exceptFileKey) {
        continue;
      }
      if (!load) {
        unpriced.push(address);
        continue;
      }
      if (load.costSec === null) {
        unpriced.push(address);
      } else {
        costSec += count * load.costSec;
      }
      if (load.fileKey && !files.has(load.fileKey)) {
        files.add(load.fileKey);
        costSec += load.fileCostSec;
      }
    }
    return { costSec, files, unpriced };
  }

  /**
   * What `count` encoders on this output add to what is already held.
   *
   * @param {OutputLoad} load
   * @param {Set<string>} files
   * @param {number} count
   * @returns {number}
   */
  static #added(load, files, count) {
    if (count <= 0) {
      return 0;
    }
    const file = load.fileKey && !files.has(load.fileKey) ? load.fileCostSec : 0;
    return file + count * (load.costSec ?? 0);
  }

  /**
   * Whether a viewer may be prepared onto this output now.
   *
   * Asked BEFORE the preparation is recorded, and answered in the same
   * synchronous stretch as the record is written: two preparations onto two
   * different outputs then cannot both be told there is room for one, because
   * the second is asked after the first has been recorded and is counted.
   *
   * An output that already holds a place — an encoder running there, or
   * another viewer being prepared onto it — is admitted without arithmetic: it
   * needs one encoder however many wait for it.
   *
   * @param {string} address
   * @returns {{ admitted: boolean, reason: string, speedX: number | null }}
   */
  admitsPreparation(address) {
    if (!address) {
      return { admitted: false, reason: "the output has no address", speedX: null };
    }
    if ((this.#host.liveRunsByAddress().get(address) ?? 0) > 0) {
      return { admitted: true, reason: "an encoder already runs there", speedX: null };
    }
    if (this.#heldWithoutRun().has(address)) {
      return { admitted: true, reason: "it already holds a place for another viewer", speedX: null };
    }
    return this.#assessCandidate(address, this.#host.loadOf(address));
  }

  /**
   * Whether a not-yet-opened format can take a place on the whole machine.
   * The output choice calls this for each candidate rung; the final claim uses
   * `admitsWatching` with the same arithmetic after registering the output.
   *
   * @param {object} spec
   * @param {object} file
   * @returns {{ admitted: boolean, reason: string, speedX: number | null }}
   */
  previewCandidate(spec, file) {
    const address = typeof spec?.toKey === "function" ? spec.toKey() : "";
    if (!address) {
      return { admitted: false, reason: "the output has no address", speedX: null };
    }
    if ((this.#host.liveRunsByAddress().get(address) ?? 0) > 0) {
      return { admitted: true, reason: "an encoder already runs there", speedX: null };
    }
    if (this.#heldWithoutRun().has(address)) {
      return { admitted: true, reason: "it already holds a place for another viewer", speedX: null };
    }
    const load = this.#host.loadForCandidate?.(spec, file) ?? null;
    return this.#assessCandidate(address, load);
  }

  /**
   * Projected production rate for outputs currently holding machine capacity.
   * A live encoder reading takes precedence; this measured-cost projection
   * supplies the playback trajectory before its first run sample arrives.
   *
   * @returns {number | null}
   */
  projectedSpeedX() {
    const occupied = this.#occupied(null);
    if (occupied.unpriced.length > 0) {
      return null;
    }
    const speedX = this.#speedAt(occupied.costSec);
    return Number.isFinite(speedX) && speedX > 0 ? speedX : null;
  }

  #assessCandidate(address, load) {
    if (!load || load.costSec === null) {
      return { admitted: false, reason: "the output has no measured encoding cost", speedX: null };
    }
    const others = this.#occupied(address);
    if (others.unpriced.length > 0) {
      return {
        admitted: false,
        reason: `capacity is unknown while ${others.unpriced.length} occupied output(s) have no measured cost`,
        speedX: null
      };
    }
    const speedX = this.#speedAt(others.costSec + EncodeAdmission.#added(load, others.files, 1));
    if (speedX >= 1) {
      return { admitted: true, reason: "", speedX: Number.isFinite(speedX) ? speedX : null };
    }
    return {
      admitted: false,
      reason:
        `this machine would make ${speedX.toFixed(2)}x of every output with one more encoder ` +
        `(${(others.costSec + EncodeAdmission.#added(load, others.files, 1)).toFixed(3)} s of work ` +
        `per second of film)` +
        (others.unpriced.length > 0 ? `, not counting ${others.unpriced.length} output(s) nothing has priced` : ""),
      speedX
    };
  }

  /**
   * Whether a viewer may be put on this output now — asked when an output is
   * OPENED for somebody, or when somebody joins one nothing is making.
   *
   * The same arithmetic as a preparation, and asked the same way: before the
   * viewer is placed, in the same synchronous stretch as the placing, so the
   * next opening is asked after this one is counted. An output that needs no
   * encoder — everything it will serve already made — takes no place at all.
   *
   * @param {string} address
   * @returns {{ admitted: boolean, reason: string, speedX: number | null }}
   */
  admitsWatching(address) {
    if (address && this.#host.finished?.(address) === true) {
      return { admitted: true, reason: "everything it serves is already made", speedX: null };
    }
    return this.admitsPreparation(address);
  }

  /**
   * What everything holding a place costs now, in seconds of work per second
   * of film, and what that leaves: the figure a question about ANOTHER file is
   * priced beside — the pool asking whether this host could serve a film it
   * has only been told about.
   *
   * Outputs of the file being asked about are left out: a viewer of a film
   * this host already makes joins what is made, and that costs it nothing new.
   *
   * @param {{ exceptFileKey?: string | null }} [options]
   * @returns {{ costSec: number, unpriced: number }}
   */
  occupiedCost({ exceptFileKey = null } = {}) {
    const { costSec, unpriced } = this.#occupied(null, exceptFileKey);
    return { costSec, unpriced: unpriced.length };
  }

  /**
   * How much room this machine has left for encoding, as the pool ranks it
   * BEFORE any film is chosen: the speed every output would run at with what
   * holds a place now, corrected for the share nobody has priced. At or below
   * realtime the machine has no room for one more encode of anything; the
   * pool's own proxy choice reads it to leave such a proxy out (roadmap item
   * 97, step 14). Null where nothing holds a place — all the room there is.
   *
   * @returns {{ encodeSpeedX: number | null, occupiedCostSec: number }}
   */
  headroom() {
    const { costSec, unpriced } = this.#occupied(null);
    const speed = this.#speedAt(costSec);
    return {
      // Unknown occupied work is not spare capacity. Zero here means that the
      // pool must not prefer this host while another reports usable headroom.
      encodeSpeedX: unpriced.length > 0 ? 0 : Number.isFinite(speed) ? Number(speed.toFixed(3)) : null,
      occupiedCostSec: Number(costSec.toFixed(4))
    };
  }

  /**
   * Every output that holds a place without an encoder running on it yet: one
   * a present viewer is being prepared onto, and one a present viewer watches
   * that still has something left to make.
   *
   * @returns {Set<string>}
   */
  #heldWithoutRun() {
    const held = new Set(this.#host.preparedAddresses());
    for (const address of this.#host.watchedAddresses?.() ?? []) {
      held.add(address);
    }
    return held;
  }

  /**
   * How many encoders this output may run, as far as the whole machine goes.
   *
   * Never fewer than already run — an admitted encoder is not taken away — and
   * never fewer than one where the output holds a place for a preparation,
   * because that place was promised when the preparation was admitted.
   * Otherwise as many as still leave every output at realtime.
   *
   * @param {string} address
   * @param {number} running - Encoders alive on it now.
   * @returns {{ runs: number, because: string }}
   */
  placesFor(address, running) {
    const floor = Math.max(
      running,
      this.#heldWithoutRun().has(address) ? 1 : 0
    );
    const load = this.#host.loadOf(address);
    if (!load || load.costSec === null) {
      // Nothing to price it with, so nothing to refuse it on: the per-output
      // limit decides, as it did before there was a machine-wide one.
      return { runs: Number.POSITIVE_INFINITY, because: "the output is not priced" };
    }
    const others = this.#occupied(address);
    let runs = 0;
    for (;;) {
      const next = runs + 1;
      if (this.#speedAt(others.costSec + EncodeAdmission.#added(load, others.files, next)) < 1) {
        break;
      }
      runs = next;
      if (!(load.costSec > 0)) {
        // Free to run: the per-output limit is the only bound.
        return { runs: Number.POSITIVE_INFINITY, because: "it costs nothing measurable" };
      }
    }
    if (runs >= floor) {
      return { runs, because: "the machine" };
    }
    return { runs: floor, because: runs < running ? "what already runs" : "a place held for a preparation" };
  }
}
