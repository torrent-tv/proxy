/**
 * @file The one owner of what this machine's processor gives the encoders
 * (torrent-tv/meta#180, phase 2: one owner, results unchanged).
 *
 * Before it, the same two readings reached the processor's decisions by six
 * routes: the share of the machine other work leaves (`HostLoad`'s latest
 * reading) was read separately by the admission, the quality offer, the cost
 * model and the download share, and the contention penalties measured at
 * startup were handed separately to the cost model, the runs and the plan. A
 * reading that changes, or a new one (the processor's bound and measured free
 * amount, `storage/machine-processor.js`), would have had to be threaded to
 * each of them again. Now each asks this object, and the arithmetic stays in
 * the two files that define it (`available-share.js`, `contention.js`).
 *
 * It lives in the encoding component because every question it answers is the
 * encoders', and that component may import nothing outside itself; it is
 * assembled beside the machine budget in `server/wire-outputs.js`. Its unit is
 * today's: shares of the whole machine and seconds of the whole machine per
 * second of film. Nothing here changes an answer.
 */

import { correctForAvailability, leftForEncoders } from "./available-share.js";
import { contentionPenalty } from "./contention.js";

export class ProcessorBudget {
  /** @type {() => ({ share: number, forEncoders?: number, known: boolean, freeCores?: number | null, otherCores?: number | null } | null | undefined)} */
  #reading;

  /** @type {import("./contention.js").ContentionPenalties | null} */
  #penalties;

  /**
   * @param {object} params
   * @param {() => ({ share: number, forEncoders?: number, known: boolean } | null | undefined)} params.reading -
   *   The latest share of the machine other work leaves, as `HostLoad` keeps it.
   * @param {import("./contention.js").ContentionPenalties | null} [params.penalties] -
   *   How much slower one job runs beside others, measured at startup.
   */
  constructor({ reading, penalties = null }) {
    if (typeof reading !== "function") {
      throw new TypeError("ProcessorBudget requires reading");
    }
    this.#reading = reading;
    this.#penalties = penalties instanceof Map ? penalties : null;
  }

  /**
   * The latest share of the machine other work leaves, or null before the
   * first reading.
   *
   * @returns {{ share: number, forEncoders?: number, known: boolean } | null}
   */
  availability() {
    return this.#reading() ?? null;
  }

  /**
   * The share of the machine an encoder gets now; 1 where the host does not
   * report its load.
   *
   * @returns {number}
   */
  left() {
    return leftForEncoders(this.availability());
  }

  /**
   * A speed measured alone on a quiet machine, as it would run now.
   *
   * @param {number} aloneSpeed
   * @returns {number}
   */
  speedOf(aloneSpeed) {
    return correctForAvailability(aloneSpeed, this.availability());
  }

  /**
   * The processor left free over the latest reading, in cores, or null where
   * it was not read (torrent-tv/meta#180, phase 4).
   *
   * @returns {number | null}
   */
  freeCores() {
    const free = this.availability()?.freeCores;
    return Number.isFinite(free) ? free : null;
  }

  /**
   * The processor other work took over the latest reading, in cores, or null.
   *
   * @returns {number | null}
   */
  otherCores() {
    const others = this.availability()?.otherCores;
    return Number.isFinite(others) ? others : null;
  }

  /**
   * The measured penalties, as the plan and the runs read them.
   *
   * @returns {import("./contention.js").ContentionPenalties | null}
   */
  get penalties() {
    return this.#penalties;
  }

  /**
   * Replace the penalties, as a new measurement of them does.
   *
   * @param {import("./contention.js").ContentionPenalties | null} penalties
   */
  set penalties(penalties) {
    this.#penalties = penalties instanceof Map ? penalties : null;
  }

  /**
   * How much slower one job runs with `others` beside it.
   *
   * @param {number} others
   * @returns {{ penalty: number, measured: boolean, from: number }}
   */
  penaltyFor(others) {
    return contentionPenalty(others, this.#penalties);
  }
}
