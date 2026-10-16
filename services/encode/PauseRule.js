/**
 * @file Whether an encoder making something less urgent runs beside the most
 * urgent one, from what running it was measured to do (torrent-tv/meta#180,
 * phase 4).
 *
 * Until this, everything less urgent than the leading band was stopped,
 * whatever the leader did with the processor and whatever it needed by its
 * deadline (`EncodeOrchestrator.shareTheMachine`). On a machine where the
 * leader does not take all the processor — libx264 thread scaling, a hardware
 * encoder whose work is on the device, a leader ahead of its deadline — the
 * paused work waited for nothing; and a one-piece soundtrack copy at 150x was
 * paused behind a picture it could not have slowed (Home Assistant r73).
 *
 * THE RULE. `L` is the leading run, `r` a less urgent one.
 *
 * 1. `L`'s need `s*` is the speed its deadlines ask for (film seconds per
 *    second); infinite where a viewer already waits for what `L` is making.
 * 2. `r` keeps running when, over the seconds it ran beside `L`, `L` still made
 *    at least `s*` (finite need), or neither `L`'s speed nor its cores fell
 *    below what they were without `r` by more than their own scatter (infinite
 *    need). Otherwise `r` is paused. Both are read: memory-bandwidth contention
 *    lowers the speed and not the cores, and on Home Assistant (r78, r79) a
 *    short run's speed scattered by as much as its median from second to second
 *    while its cores scattered by 0.02-0.2, so a slowdown is often visible in
 *    the cores first. No number of cores enters: a fraction of a core can be
 *    enough, and a free core does not cap what a new ffmpeg takes.
 * 3. A paused `r` is tried when the processor left free (`F`, cores) is
 *    unknown or exceeds what `r` drew when it last ran, or when `L` makes more
 *    than `s*` by more than its scatter. With an infinite need it is tried only
 *    once `L` has seconds without it to be compared against.
 * 4. A run whose whole remaining stretch costs less processor than `L`'s
 *    scatter over one second cannot be measured against `L` and is never
 *    paused.
 *
 * NO ALTERNATION UNDER UNCHANGED LOAD. A pause for a measured slowdown is
 * remembered for the pair with what it was measured under: `L`'s output and
 * band, the other runs running, and the processor other work took. `r` is not
 * tried beside `L` again until one of these changes — the others' draw by more
 * than `r`'s own — so under constant load there is at most one try and one
 * pause.
 *
 * WITHOUT READINGS NOTHING CHANGES. Where `L` has no per-second readings (no
 * `/proc` to read an ffmpeg's processor from), or `r` has run beside `L` since
 * before anything could be compared, the answer is null and the caller keeps
 * the urgency rule it had.
 *
 * Readings are the per-second ones of `storage/processor-report.js`: each
 * run's cores and the film it made per second of wall clock. Seconds in which
 * `L` waited for its input say nothing about `r` and are left out.
 */

/**
 * How many seconds of readings a run keeps. Enough for a baseline before a try
 * and the seconds beside after it; `L`'s cost changes from piece to piece, so
 * older seconds describe other pieces.
 */
const KEPT_SECONDS = 30;

/**
 * The fewest seconds a median and its scatter are taken from: with fewer,
 * the scatter of one or two values says nothing.
 */
const LEAST_SECONDS = 3;

/**
 * @typedef {object} RunSecond
 * @property {number} at - When the second ended, in milliseconds.
 * @property {number} cores - What the run's ffmpeg used over it.
 * @property {number | null} speed - Film made per second of wall clock.
 * @property {Set<object>} running - The runs running (not paused) beside it.
 * @property {boolean} waiting - Whether its input waited at the end of it.
 */

/**
 * @typedef {object} PairConditions
 * @property {string} address - `L`'s output.
 * @property {boolean} urgent - `L`'s band.
 * @property {number} priority
 * @property {Set<object>} running - The other runs running, `L` and `r` aside.
 * @property {number | null} others - Cores other work took.
 */

export class PauseRule {
  /** @type {Map<object, RunSecond[]>} */
  #seconds = new Map();

  /** When the rule last let each run go. @type {Map<object, number>} */
  #triedAt = new Map();

  /** What the last run on each output drew, for the next run there. @type {Map<string, number>} */
  #lastDrawOn = new Map();

  /** Pauses for a measured slowdown, by leader, then by run. @type {Map<object, Map<object, PairConditions>>} */
  #pairs = new Map();

  /**
   * One second of one run.
   *
   * @param {object} run
   * @param {{ at: number, cores: number, speed: number | null }} reading
   * @param {Iterable<object>} running - Every run running at the time.
   * @param {boolean} [waiting]
   */
  noteSecond(run, { at, cores, speed }, running, waiting = false) {
    if (!Number.isFinite(cores)) return;
    const kept = this.#seconds.get(run) ?? [];
    kept.push({ at, cores, speed: Number.isFinite(speed) ? speed : null, running: new Set(running), waiting: waiting === true });
    while (kept.length > 0 && kept[0].at <= at - KEPT_SECONDS * 1000) kept.shift();
    this.#seconds.set(run, kept);
  }

  /**
   * A run that has ended: what it drew is kept for the next run on its output.
   *
   * @param {object} run
   * @param {string} address
   */
  forget(run, address) {
    const draw = this.#drawOf(run);
    if (draw !== null && typeof address === "string") this.#lastDrawOn.set(address, draw);
    this.#seconds.delete(run);
    this.#triedAt.delete(run);
    this.#pairs.delete(run);
    for (const pairs of this.#pairs.values()) pairs.delete(run);
  }

  /**
   * Whether `run` runs beside `leader` now.
   *
   * @param {object} params
   * @param {object} params.leader - The leading run.
   * @param {{ address: string, urgent: boolean, priority: number }} params.band - Where it leads.
   * @param {object} params.run - A run less urgent than it.
   * @param {string} params.address - `run`'s output.
   * @param {number} params.need - `L`'s `s*`: film seconds per second, `Infinity`
   *   where a viewer waits for what it is making, 0 where nothing is due.
   * @param {number} params.remainingFilm - Film seconds `run` has left to make.
   * @param {number | null} params.free - `F`: cores left free, or null.
   * @param {number | null} params.others - Cores other work took, or null.
   * @param {Iterable<object>} params.running - Every run running now.
   * @param {number} params.now
   * @returns {{ runs: boolean, because: string } | null} Null where nothing
   *   was measured to decide from.
   */
  judge({ leader, band, run, address, need, remainingFilm, free, others, running, now }) {
    const lead = (this.#seconds.get(leader) ?? []).filter((second) => !second.waiting && second.speed !== null);
    if (lead.length === 0) return null;
    const leadCores = middleAndScatter(lead.map((second) => second.cores));
    const draw = this.#drawOf(run) ?? this.#lastDrawOn.get(address) ?? null;
    const perFilm = this.#costPerFilm(run);
    if (perFilm !== null && Number.isFinite(remainingFilm) && remainingFilm * perFilm < leadCores.scatter) {
      return { runs: true, because: `its remaining ${remainingFilm.toFixed(1)}s of film cost ${(remainingFilm * perFilm).toFixed(3)} ` +
        `CPU-s, less than the leader's scatter of ${leadCores.scatter.toFixed(3)} cores over one second` };
    }
    const without = lead.filter((second) => !second.running.has(run));
    const otherRunning = new Set([...running].filter((other) => other !== leader && other !== run));
    if (run.isSuspended === true) {
      return this.#whetherToTry({ leader, band, run, need, lead, without, draw, free, others, otherRunning, now });
    }
    const since = this.#triedAt.get(run) ?? Number.NEGATIVE_INFINITY;
    const beside = lead.filter((second) => second.running.has(run) && second.at > since);
    if (beside.length < LEAST_SECONDS) {
      // Let go by this rule and not measured yet: it runs until it is.
      // Running since before anything could be compared: the urgency rule.
      return this.#triedAt.has(run) ? { runs: true, because: `being measured beside the leader (${beside.length}s so far)` } : null;
    }
    const besideSpeed = middleAndScatter(beside.map((second) => second.speed));
    if (Number.isFinite(need)) {
      if (besideSpeed.middle >= need) {
        return { runs: true, because: `the leader made ${besideSpeed.middle.toFixed(2)}x beside it over ${beside.length}s, ` +
          `needing ${need.toFixed(2)}x` };
      }
      this.#remember(leader, run, { band, otherRunning, others });
      return { runs: false, because: `the leader made ${besideSpeed.middle.toFixed(2)}x beside it over ${beside.length}s, ` +
        `below the ${need.toFixed(2)}x its deadlines need` };
    }
    if (without.length < LEAST_SECONDS) {
      return this.#triedAt.has(run) ? { runs: true, because: "nothing to compare the leader's speed with" } : null;
    }
    const alone = middleAndScatter(without.map((second) => second.speed));
    const besideCores = middleAndScatter(beside.map((second) => second.cores));
    const aloneCores = middleAndScatter(without.map((second) => second.cores));
    const measured = `the leader made ${besideSpeed.middle.toFixed(2)}x on ${besideCores.middle.toFixed(2)} cores beside it ` +
      `over ${beside.length}s, ${alone.middle.toFixed(2)}x (scatter ${alone.scatter.toFixed(2)}) on ` +
      `${aloneCores.middle.toFixed(2)} cores (scatter ${aloneCores.scatter.toFixed(2)}) without it over ${without.length}s, ` +
      "and a viewer waits for it";
    if (alone.middle - besideSpeed.middle > alone.scatter || aloneCores.middle - besideCores.middle > aloneCores.scatter) {
      this.#remember(leader, run, { band, otherRunning, others });
      return { runs: false, because: measured };
    }
    return { runs: true, because: measured };
  }

  /**
   * Whether a run not started yet, on `address` and less urgent than
   * `leader`, would be let go at once: a start the rule would pause is not
   * made (`EncodePlan` holds it). Without readings of the leader, it would.
   *
   * @param {object} params
   * @param {object} params.leader
   * @param {string} params.address
   * @param {number} params.need
   * @param {number | null} params.free
   * @returns {{ runs: boolean, because: string }}
   */
  wouldStart({ leader, address, need, free }) {
    const lead = (this.#seconds.get(leader) ?? []).filter((second) => !second.waiting && second.speed !== null);
    if (lead.length === 0) {
      return { runs: false, because: "nothing has measured what the leader does" };
    }
    const draw = this.#lastDrawOn.get(address) ?? null;
    return this.#tryCondition({ need, lead, without: lead, draw, free });
  }

  /**
   * Whether a paused run is let go to be measured beside the leader.
   *
   * @param {object} params
   * @returns {{ runs: boolean, because: string }}
   */
  #whetherToTry({ leader, band, run, need, lead, without, draw, free, others, otherRunning, now }) {
    const remembered = this.#pairs.get(leader)?.get(run);
    const changed = remembered ? changeOf(remembered, { band, otherRunning, others, draw }) : null;
    if (remembered) {
      if (changed === null) {
        return { runs: false, because: "it slowed the leader when last tried, and nothing it was tried under has changed" };
      }
      this.#pairs.get(leader)?.delete(run);
    }
    const verdict = this.#tryCondition({ need, lead, without, draw, free });
    if (!verdict.runs) return verdict;
    this.#triedAt.set(run, now);
    return { runs: true, because: `tried beside the leader: ${verdict.because}` +
      (remembered ? ` (${changed} changed since it was paused)` : "") };
  }

  /**
   * Rule 3: the conditions under which a run not running is let go.
   *
   * @param {{ need: number, lead: RunSecond[], without: RunSecond[], draw: number | null, free: number | null }} params
   * @returns {{ runs: boolean, because: string }}
   */
  #tryCondition({ need, lead, without, draw, free }) {
    if (!Number.isFinite(need) && without.length < LEAST_SECONDS) {
      return { runs: false, because: `a viewer waits for the leader, and it has run ${without.length}s without this one ` +
        "to be compared with" };
    }
    const leadSpeed = middleAndScatter(lead.map((second) => second.speed));
    if (free === null || !Number.isFinite(free)) {
      return { runs: true, because: "the processor left free is unknown" };
    }
    if (free > (draw ?? 0)) {
      return { runs: true, because: `${free.toFixed(2)} cores are free, more than the ` +
        `${draw === null ? "unmeasured draw" : `${draw.toFixed(2)} cores`} it draws` };
    }
    if (Number.isFinite(need) && leadSpeed.middle - need > leadSpeed.scatter) {
      return { runs: true, because: `the leader makes ${leadSpeed.middle.toFixed(2)}x, needing ${need.toFixed(2)}x` };
    }
    return { runs: false, because: `${free.toFixed(2)} cores are free, not more than the ` +
      `${draw === null ? "?" : draw.toFixed(2)} cores it draws, and the leader makes ${leadSpeed.middle.toFixed(2)}x` +
      (Number.isFinite(need) ? `, needing ${need.toFixed(2)}x` : " with a viewer waiting") };
  }

  /**
   * @param {object} leader
   * @param {object} run
   * @param {{ band: { address: string, urgent: boolean, priority: number }, otherRunning: Set<object>, others: number | null }} under
   */
  #remember(leader, run, { band, otherRunning, others }) {
    const pairs = this.#pairs.get(leader) ?? new Map();
    pairs.set(run, { address: band.address, urgent: band.urgent === true, priority: band.priority, running: otherRunning,
      others: Number.isFinite(others) ? others : null });
    this.#pairs.set(leader, pairs);
    this.#triedAt.delete(run);
  }

  /**
   * The cores a run drew while it ran: the median of its seconds.
   *
   * @param {object} run
   * @returns {number | null}
   */
  #drawOf(run) {
    const seconds = this.#seconds.get(run) ?? [];
    return seconds.length === 0 ? null : middleAndScatter(seconds.map((second) => second.cores)).middle;
  }

  /**
   * CPU seconds per second of film, over the seconds in which it made film.
   *
   * @param {object} run
   * @returns {number | null}
   */
  #costPerFilm(run) {
    const costs = (this.#seconds.get(run) ?? []).filter((second) => second.speed > 0).map((second) => second.cores / second.speed);
    return costs.length === 0 ? null : middleAndScatter(costs).middle;
  }
}

/**
 * What has changed since a pause for a slowdown, or null.
 *
 * @param {PairConditions} remembered
 * @param {{ band: { address: string, urgent: boolean, priority: number }, otherRunning: Set<object>, others: number | null, draw: number | null }} now
 * @returns {string | null}
 */
function changeOf(remembered, { band, otherRunning, others, draw }) {
  if (remembered.address !== band.address || remembered.urgent !== (band.urgent === true) || remembered.priority !== band.priority) {
    return "the leader's band";
  }
  if (remembered.running.size !== otherRunning.size || [...otherRunning].some((other) => !remembered.running.has(other))) {
    return "the runs running";
  }
  if (remembered.others !== null && Number.isFinite(others) && draw !== null && remembered.others - others > draw) {
    return "the processor other work takes";
  }
  return null;
}

/**
 * The median and the median distance to it.
 *
 * @param {number[]} values
 * @returns {{ middle: number, scatter: number }}
 */
function middleAndScatter(values) {
  const median = (list) => {
    const sorted = [...list].sort((left, right) => left - right);
    const half = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[half - 1] + sorted[half]) / 2 : sorted[half];
  };
  const middle = median(values);
  return { middle, scatter: median(values.map((value) => Math.abs(value - middle))) };
}
