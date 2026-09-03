/**
 * @file What has been made of one output, what is being made right now, and by
 * whom.
 *
 * One map per set of output parameters — never per session, never per viewer.
 * Every segment number is in exactly one of three states:
 *
 * 1. **ready** — a file that is closed and can be served to anybody;
 * 2. **being made** — claimed by a named live run, which has been given that
 *    stretch and is working forward through it;
 * 3. **free** — nobody has made it and nobody is making it.
 *
 * Two questions are asked of it constantly and both have to be cheap, because
 * one of them is on the path that answers a viewer:
 *
 * 1. is segment N ready — a set lookup;
 * 2. where is the first gap at or after N — a walk over numbers, never over the
 *    disk. The walk it replaces listed every run directory of a session on the
 *    thread carrying the data channel, 1350 files for a 90-minute film, on
 *    every segment request.
 *
 * **Claims are intervals, not heads.** A run says which stretch it was given,
 * so two runs on one output cannot be sent to the same numbers: the gap finder
 * skips what another run will reach. A run that only announced its current
 * position would leave the question "will anybody make #400" unanswerable
 * without guessing at its speed.
 *
 * **Nothing here touches a disk, a process or a clock**, so every decision it
 * makes can be exercised with numbers alone.
 */

/** @typedef {"ready" | "making" | "free"} SegmentState */

export class CoverageMap {
  /** Numbers whose file is closed and servable. @type {Set<number>} */
  #ready = new Set();

  /** Run id → the stretch it was given, both ends inclusive. @type {Map<string, {from: number, to: number}>} */
  #claims = new Map();

  /** How many segments this output has in total. @type {number} */
  #segmentCount;

  /**
   * @param {object} [params]
   * @param {number} [params.segmentCount=0] - The length of the output, in
   *   segments. Zero means it is not known yet, and then a gap search has to be
   *   given its own bound by the caller.
   */
  constructor({ segmentCount = 0 } = {}) {
    this.#segmentCount = Number.isInteger(segmentCount) && segmentCount > 0 ? segmentCount : 0;
  }

  /**
   * The length of the output, once the playlist is known.
   *
   * @param {number} count
   */
  setSegmentCount(count) {
    if (Number.isInteger(count) && count > 0) {
      this.#segmentCount = count;
    }
  }

  /** @returns {number} */
  get segmentCount() {
    return this.#segmentCount;
  }

  /**
   * Record that a segment is closed and can be served.
   *
   * Idempotent, and deliberately independent of who made it: a segment made by
   * a run that has since died is as good as one made by a run still going, and
   * a segment left by a previous life of this process is as good as either.
   *
   * @param {number} index
   */
  markReady(index) {
    if (Number.isInteger(index) && index >= 0) {
      this.#ready.add(index);
    }
  }

  /**
   * @param {Iterable<number>} indexes
   */
  markReadyAll(indexes) {
    for (const index of indexes) {
      this.markReady(index);
    }
  }

  /**
   * Forget a segment: its file has gone, or was never closed.
   *
   * @param {number} index
   */
  markGone(index) {
    this.#ready.delete(index);
  }

  /**
   * A run has been given a stretch to fill.
   *
   * Replaces whatever that run claimed before, because a run has one stretch at
   * a time: moved forward past ready material, it states the new one.
   *
   * @param {string} runId
   * @param {number} from - First segment number, inclusive.
   * @param {number} to - Last segment number, inclusive. May be
   *   `Number.POSITIVE_INFINITY` for a run with no end yet, which is what every
   *   run was before ends existed.
   */
  claim(runId, from, to) {
    if (!runId || !Number.isInteger(from) || from < 0) {
      return;
    }
    const end = Number.isFinite(to) ? Math.max(from, Math.trunc(to)) : Number.POSITIVE_INFINITY;
    this.#claims.set(runId, { from, to: end });
  }

  /**
   * A run has ended. Whatever it did not finish goes back to free.
   *
   * Nothing is un-marked: what it DID finish stays ready, because a closed file
   * is closed whoever made it and whatever became of them afterwards.
   *
   * @param {string} runId
   */
  release(runId) {
    this.#claims.delete(runId);
  }

  /**
   * @param {number} index
   * @returns {boolean}
   */
  isReady(index) {
    return this.#ready.has(index);
  }

  /**
   * The run that was given this number, if any.
   *
   * @param {number} index
   * @returns {string | null}
   */
  makerOf(index) {
    for (const [runId, span] of this.#claims) {
      if (index >= span.from && index <= span.to) {
        return runId;
      }
    }
    return null;
  }

  /**
   * @param {number} index
   * @returns {SegmentState}
   */
  stateOf(index) {
    if (this.#ready.has(index)) {
      return "ready";
    }
    return this.makerOf(index) === null ? "free" : "making";
  }

  /**
   * The first number at or after `index` that nobody has made and nobody is
   * making — where a new run belongs.
   *
   * @param {number} index
   * @param {number} [bound] - Search no further than this number, inclusive.
   *   Defaults to the last segment of the output; required while the length is
   *   unknown.
   * @param {string} [exceptRunId] - The run asking. Its own claim does not make
   *   a number taken as far as it is concerned: a run looking for where to move
   *   would otherwise be blocked by the very stretch it is trying to leave, and
   *   a run that had claimed the rest of the film could never move at all.
   * @returns {number | null} Null when there is no gap in range, which is what
   *   "everything ahead is already covered" looks like.
   */
  firstGapFrom(index, bound = undefined, exceptRunId = "") {
    const start = Number.isInteger(index) && index > 0 ? index : 0;
    const last = Number.isInteger(bound) ? bound : this.#segmentCount - 1;
    if (!Number.isInteger(last) || last < start) {
      return null;
    }
    for (let at = start; at <= last; at += 1) {
      if (this.#ready.has(at)) {
        continue;
      }
      const maker = this.makerOf(at);
      if (maker === null || maker === exceptRunId) {
        return at;
      }
    }
    return null;
  }

  /**
   * How many numbers from `index` onwards are already covered — ready, or
   * claimed by a run other than `exceptRunId`.
   *
   * This is what prices a decision: a run that has arrived at covered material
   * either drives through it, paying its own encode time for every one of these
   * numbers, or is moved to the gap beyond them, paying one restart. Both terms
   * are measured elsewhere; this is the length.
   *
   * @param {number} index
   * @param {string} [exceptRunId] - The run asking. Its own claim does not
   *   count as somebody else's coverage.
   * @returns {number}
   */
  coveredRunFrom(index, exceptRunId = "") {
    const start = Number.isInteger(index) && index > 0 ? index : 0;
    const last = this.#segmentCount > 0 ? this.#segmentCount - 1 : Number.MAX_SAFE_INTEGER;
    let at = start;
    while (at <= last) {
      if (this.#ready.has(at)) {
        at += 1;
        continue;
      }
      const maker = this.makerOf(at);
      if (maker !== null && maker !== exceptRunId) {
        at += 1;
        continue;
      }
      break;
    }
    return at - start;
  }

  /**
   * How many numbers from `index` onwards are free — nobody has made them and
   * nobody is making them.
   *
   * This is what gives a run its END. A run handed the whole rest of the film
   * would drive straight through the next stretch somebody else is making; a
   * run handed exactly the free stretch stops where the covered material
   * begins, which is also where it would have been moved to anyway.
   *
   * @param {number} index
   * @param {string} [exceptRunId] - The run asking, whose own claim does not
   *   make a number unfree for it.
   * @returns {number} Zero when `index` itself is not free.
   */
  freeRunFrom(index, exceptRunId = "") {
    const start = Number.isInteger(index) && index > 0 ? index : 0;
    const last = this.#segmentCount > 0 ? this.#segmentCount - 1 : Number.MAX_SAFE_INTEGER;
    let at = start;
    while (at <= last) {
      if (this.#ready.has(at)) {
        break;
      }
      const maker = this.makerOf(at);
      if (maker !== null && maker !== exceptRunId) {
        break;
      }
      at += 1;
    }
    return at - start;
  }

  /**
   * What this map holds, for a log line.
   *
   * @returns {{ ready: number, claims: number, segmentCount: number }}
   */
  stats() {
    return {
      ready: this.#ready.size,
      claims: this.#claims.size,
      segmentCount: this.#segmentCount
    };
  }
}
