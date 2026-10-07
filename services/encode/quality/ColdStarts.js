/**
 * @file How long each output took from the request that created it to its
 * first segment being served — measured once per output, said in the log, and
 * kept nowhere else.
 *
 * This is what is left of `HostTimings` (torrent-tv/meta#3). That class also
 * kept the median of recent first-segment and creation times in
 * `host-timings.json`, so a restarted proxy would not quote an assumed figure.
 * It was to go once the time could be computed instead of remembered, and it
 * can: a fresh output's first piece takes what this host was measured to need
 * for a first output (`RunCosts`) or one piece at this output's own measured
 * speed, whichever is longer. The remembered median could never say that —
 * measured on the addon host on 2026-10-06 it ran from 0.4 to 184 times the
 * startup figure, because most of it was the swarm.
 */

export class ColdStarts {
  /**
   * Output → when the request that created it arrived, until its first segment
   * is served. Taken out on that first segment, so each output is measured once
   * and an output nobody created in this process (adopted at startup) is never
   * measured at all.
   *
   * @type {WeakMap<object, number>}
   */
  #createdAt = new WeakMap();

  /**
   * An output was created by a request that arrived at `at`.
   *
   * @param {object} output
   * @param {number} at
   * @returns {void}
   */
  noteOutputCreated(output, at) {
    if (Number.isFinite(at) && at > 0) {
      this.#createdAt.set(output, at);
    }
  }

  /**
   * A segment of this output has just been served. The first one closes the
   * measurement; every later one is nothing.
   *
   * @param {object} output
   * @param {number} [now]
   * @returns {number | null} The cold-start latency when this was the first.
   */
  noteSegmentServed(output, now = Date.now()) {
    const at = this.#createdAt.get(output);
    if (at === undefined) {
      return null;
    }
    this.#createdAt.delete(output);
    return now - at;
  }
}

/**
 * How long a fresh output of this mode takes to have its first piece on this
 * host, in seconds: the measured wait for a first output, or one piece at the
 * output's own speed, whichever is longer.
 *
 * The same arithmetic the encode plan prices a fresh encoder with
 * (`EncodePlan.js`): the measured wait already contains one piece, so the spawn
 * overhead is the wait less one piece, and overhead plus piece is the larger of
 * the two. Null where the speed is not known.
 *
 * @param {{ firstByteWaitSec: number, segmentDurationSec: number, speed: number }} params
 * @returns {number | null}
 */
export function secondsToFirstPiece({ firstByteWaitSec, segmentDurationSec, speed }) {
  if (!(speed > 0) || !(segmentDurationSec > 0)) {
    return null;
  }
  const pieceSec = segmentDurationSec / speed;
  return Math.max(Number.isFinite(firstByteWaitSec) ? firstByteWaitSec : 0, pieceSec);
}
