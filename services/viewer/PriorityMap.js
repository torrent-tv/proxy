/**
 * @file THE PRIORITY MAP — what one viewer needs, what all of them need
 * together, and in what order the work should be taken.
 *
 * A layer of its own, below both orchestrators and depending on nothing. It
 * knows ONLY priorities: what is downloaded is the download orchestrator's own
 * knowledge, what is encoded is the encoding orchestrator's, and neither is
 * visible from here. Both read this and recompute their own on every change.
 *
 * The shape, stated by the user 2026-09-05:
 *
 * > Usually you make a map for each viewer, then merge the maps, then decide
 * > the best way of filling it given the encoders available, where they are now
 * > and how many there are.
 *
 * Three questions, and this file answers the first two. The third — the filling
 * — belongs to whoever holds the encoders, and it is handed the merged map
 * instead of a list of windows.
 *
 * **ONE PRIORITISATION, TWO CONSUMERS.** Downloading and encoding keep
 * different STATES — made / being made / free for one; downloaded / arriving,
 * and which peers hold it at what speed, for the other — but they must agree
 * about what matters first, or the swarm fetches what the encoder will not
 * reach for another twenty minutes. That agreement is this map.
 *
 * **THE UNIT IS SECONDS OF FILM.** A map is a set of stretches with sizes and a
 * length of its own, so it needs a unit, and seconds are the only one every
 * term of the arithmetic is already stated in: encode speed is a ratio of
 * seconds to seconds, the measured allowance below which an interruption
 * reaches a viewer is seconds, the viewer's position is seconds, the film's
 * length is seconds. Bytes cannot serve — how many a second costs is not known
 * when a file is opened and is not constant across it, and a soundtrack in a
 * file of its own has bytes of its own. Segment numbers cannot serve either:
 * they exist only once a cut grid is read, and two outputs of one film number
 * differently.
 *
 * **What this file must NOT know**, and the boundary is the point: nothing about
 * containers, cut grids, pieces or bytes. Turning a stretch of seconds into the
 * bytes of one track is the container's and the track's business, by whatever
 * means suit that file — a Cues table, a sample table, or a walk when the file
 * carries neither, which is the same answer they already give in order to play
 * it at all. Getting those bytes is the downloader's business; making segments
 * out of them is the encoder's.
 */

/**
 * THE MAP ITSELF: what each viewer wants, kept as the rules that say it, and
 * answered for a second, for a stretch, or as the stretches of one value.
 *
 * The rules are the ones the map has had since 2026-09-06, when an array of one
 * number per second of film replaced a list of stretches: a priority for every
 * second, the time until a viewer plays it, and whether it lies behind every
 * viewer, is wanted before playback can continue, or has been yielded by a
 * viewer who stopped. What changed (torrent-tv/meta#178) is only how they are
 * held. Every one of those values is a step function of the distance from a
 * viewer, with steps the rules themselves place — where the viewer stands, the
 * end of the urgent allowance, the doubling bands of priority — and the time is
 * that distance. Built as arrays the length of the film, a map cost a pass over
 * every second for every viewer and again for the merge, on every move of a
 * viewer: on Home Assistant the main thread built them 21-61 times a minute
 * over a two-hour film (r26). Held as rules, a question costs what the viewers
 * and their steps cost, and nothing per second of film.
 *
 * Two different questions are asked of the map and only one of them can be
 * answered by a rank:
 *
 * - `priority` orders the work. Only the ORDER between values is meaningful;
 *   the scale below says what the numbers separate;
 * - the time until a second is played is a quantity, and it is what makes
 *   lateness computable at all: whoever fills the map compares "when is this
 *   needed" against "when would it arrive", and only the second half is theirs
 *   to work out. `Infinity` where nobody is on their way.
 *
 * The merge keeps what it always did: the highest priority and the soonest
 * time, taken separately — two viewers can tie on the coarse priority while one
 * is genuinely nearer; in front of ANYBODY is in front; a second is urgent if
 * any viewer needs it before playback can continue; and it is deferred only if
 * every viewer in front of it has yielded it.
 *
 * @typedef {object} MapPoint
 * @property {number} priority - Zero where nobody wants it.
 * @property {number} untilSeconds - Seconds until a viewer plays it.
 * @property {boolean} behind - Behind every viewer.
 * @property {boolean} urgent
 * @property {boolean} deferred
 */

/**
 * A stretch of the map with one value throughout — the same facts said as a
 * range instead of as a run of equal entries.
 *
 * @typedef {object} DemandZone
 * @property {number} from - First second, inclusive.
 * @property {number} to - Last second, exclusive.
 * @property {number} priority
 * @property {number} withinSeconds
 * @property {boolean} urgent - Required preparation before playback can continue.
 * @property {boolean} behind - Whether this lies behind every viewer.
 */


/**
 * Wanted seconds use priorities 1..100. Distance lowers priority relative to
 * the measured urgent allowance. Pause preserves the same priorities until
 * urgent outputs are ready. With competing viewers, elapsed pause time then
 * attenuates the excess above 1 before maps merge. Zero means no demand.
 * Direction, urgent preparation and attenuation are separate map fields;
 * priority alone cannot distinguish an attenuated second from a passed one.
 */
const AT_A_WATCHING_VIEWER = 100;

/** Behind everybody. */
const NOBODY_IS_COMING = 1;

/** Nothing is wanted here at all. */
const NOTHING = 0;

/**
 * Does this value mean "behind every viewer"?
 *
 * A read of the scale, so that nobody has to infer the side from the absence of
 * a deadline. Inferred that way it was wrong for a stopped viewer, whose whole
 * film carries no deadline: the film in front of them then counted as behind
 * them, and the encoders were free to wander to the start of the file.
 *
 * @param {number} priority
 * @returns {boolean}
 */
export function isBehindEverybody(priority) {
  return priority <= NOBODY_IS_COMING;
}

/**
 * Is this second the one a viewer is about to watch?
 *
 * The top step of the watching band: the film under their feet and the measured
 * allowance in front of it, which is the depth below which an interruption
 * reaches them.
 *
 * @param {number} priority
 * @returns {boolean}
 */
export function isAtAWatchingViewer(priority) {
  return priority >= AT_A_WATCHING_VIEWER;
}

/**
 * Is this second in front of somebody who has STOPPED, and of nobody who is
 * watching?
 *
 * Wanted, and wanted after everything anybody is walking towards: they will see
 * it when they press play, and nothing here knows when that is.
 *
 * @param {number} priority
 * @returns {boolean}
 */
export function isNobodyComingNow(priority) {
  return priority === NOBODY_IS_COMING;
}

/**
 * How far into its band a second sits, given its distance from the viewer.
 *
 * The step doubles: near the viewer the difference between now and ten seconds
 * away decides what is made first, while twenty minutes out the difference
 * between twenty and twenty-one minutes changes nothing. The first step is the
 * MEASURED allowance for this file on this swarm — the depth below which an
 * interruption reaches the viewer — so how finely the map divides comes from a
 * measurement rather than from a number chosen here.
 *
 * @param {number} distanceSeconds
 * @param {number} allowanceSeconds
 * @returns {number} Zero at the viewer, growing with distance.
 */
function stepsAway(distanceSeconds, allowanceSeconds) {
  if (!(distanceSeconds > 0)) {
    return 0;
  }
  return Math.floor(Math.log2(1 + distanceSeconds / allowanceSeconds));
}

/** Where nothing is wanted. */
const NO_DEMAND = Object.freeze({ priority: NOTHING, untilSeconds: Number.POSITIVE_INFINITY, behind: true, urgent: false, deferred: false });

/**
 * The first whole distance whose step is at least `step`, worked out by the
 * same arithmetic the step is read with, so a boundary is exactly where the
 * value changes.
 *
 * @param {number} step
 * @param {number} allowanceSeconds
 * @returns {number}
 */
function firstDistanceOfStep(step, allowanceSeconds) {
  let distance = Math.ceil(allowanceSeconds * (2 ** step - 1));
  while (distance > 0 && stepsAway(distance - 1, allowanceSeconds) >= step) distance -= 1;
  while (stepsAway(distance, allowanceSeconds) < step) distance += 1;
  return distance;
}

/**
 * One viewer's demand: the rules of their map, with where they stand.
 *
 * **The number is a reading of how soon they will be there.** A viewer watching
 * forward reaches second `x` after `x - p` seconds of film. That distance — not
 * a clock time — is what the value is derived from, and it is why two viewers
 * can be compared at all: the nearer one wins the second they both want.
 *
 * Pause retains urgent preparation first. Once that work is ready, the
 * allowance / (allowance + pauseSeconds) coefficient gradually reduces this
 * viewer's priorities if others consume the file. Resume restores them.
 */
class ViewerDemand {
  /**
   * @param {{ atSeconds: number, durationSeconds: number, allowanceSeconds: number, playing?: boolean,
   *   pauseSeconds?: number, urgentReady?: boolean, viewerCount?: number }} params
   */
  constructor({ atSeconds, durationSeconds, allowanceSeconds, playing = true, pauseSeconds = 0, urgentReady = false, viewerCount = 1 }) {
    this.durationSeconds = Number.isFinite(durationSeconds) && durationSeconds > 0 ? Math.ceil(durationSeconds) : 0;
    this.at = Number.isFinite(atSeconds) && atSeconds > 0 ? Math.floor(atSeconds) : 0;
    this.allowance = Number.isFinite(allowanceSeconds) && allowanceSeconds > 0 ? allowanceSeconds : this.durationSeconds;
    // The measured urgent span is the time scale. There is no chosen decay
    // period: one span on pause halves the excess above minimum priority.
    this.attenuate = playing === false && urgentReady && viewerCount > 1;
    this.elapsed = Number.isFinite(pauseSeconds) ? Math.max(0, pauseSeconds) : 0;
    this.coefficient = pauseCoefficient({ playing, urgentReady, viewerCount, pauseSeconds: this.elapsed, allowanceSeconds: this.allowance });
  }

  /** The priority at a whole distance in front of the viewer. @param {number} distance */
  priorityAt(distance) {
    const priority = Math.max(NOBODY_IS_COMING, AT_A_WATCHING_VIEWER - stepsAway(distance, this.allowance));
    return Math.max(NOBODY_IS_COMING, 1 + Math.floor((priority - 1) * this.coefficient));
  }

  /**
   * @param {number} second
   * @returns {MapPoint | null} Null where the film does not reach.
   */
  pointAt(second) {
    if (!(second >= 0 && second < this.durationSeconds)) return null;
    if (second < this.at) {
      return { priority: NOBODY_IS_COMING, untilSeconds: Number.POSITIVE_INFINITY, behind: true, urgent: false, deferred: false };
    }
    const distance = second - this.at;
    // Urgent preparation keeps its deadline during pause. After completion,
    // pause duration defers this viewer's work without altering other viewers.
    return { priority: this.priorityAt(distance), untilSeconds: distance + (this.attenuate ? this.elapsed : 0), behind: false,
      urgent: distance < this.allowance && !this.attenuate, deferred: this.attenuate };
  }

  /** Every second where one of this viewer's values may change, inside the film. @returns {number[]} */
  breaks() {
    const breaks = [this.at, this.durationSeconds, this.at + Math.ceil(this.allowance)];
    for (let step = 1; step < AT_A_WATCHING_VIEWER - NOBODY_IS_COMING; step += 1) {
      const second = this.at + firstDistanceOfStep(step, this.allowance);
      if (second >= this.durationSeconds) break;
      breaks.push(second);
    }
    return breaks.filter(second => second > 0 && second <= this.durationSeconds);
  }
}

/**
 * Every viewer's demand on one film, merged: the map.
 */
export class PriorityMap {
  /** @type {ViewerDemand[]} */
  #viewers;
  /** The film between the breaks, each stretch with its value at its start; worked out once. */
  #pieces = null;

  /** @param {ViewerDemand[]} [viewers] */
  constructor(viewers = []) {
    this.#viewers = viewers.filter(viewer => viewer.durationSeconds > 0);
    /** The film's length, in whole seconds. */
    this.durationSeconds = this.#viewers.reduce((longest, viewer) => Math.max(longest, viewer.durationSeconds), 0);
  }

  /** The viewers' demands, for a merge. */
  get viewers() {
    return this.#viewers;
  }

  /**
   * What is wanted at one second.
   *
   * @param {number} second
   * @returns {MapPoint}
   */
  at(second) {
    let priority = NOTHING;
    let untilSeconds = Number.POSITIVE_INFINITY;
    let behind = true;
    let urgent = false;
    let yieldedByAll = true;
    for (const viewer of this.#viewers) {
      const point = viewer.pointAt(second);
      if (!point) continue;
      if (point.priority > priority) priority = point.priority;
      if (point.untilSeconds < untilSeconds) untilSeconds = point.untilSeconds;
      if (!point.behind) {
        // In front of ANYBODY is in front: a stretch one viewer has passed is
        // still the film another is walking towards.
        behind = false;
        // Deferred only if every viewer needing this second has yielded it.
        if (!point.deferred) yieldedByAll = false;
      }
      if (point.urgent) urgent = true;
    }
    if (priority === NOTHING) return NO_DEMAND;
    return { priority, untilSeconds, behind, urgent, deferred: !behind && yieldedByAll };
  }

  /**
   * What a stretch of seconds wants as a whole, taken as a piece made or not
   * made whole is wanted: as much as its strongest second, as soon as its
   * soonest one, in front of somebody if any second of it is, urgent if any
   * second of it is.
   *
   * A viewer's priority does not rise with distance and their time rises a
   * second a second, so the second of the stretch nearest to them answers both.
   *
   * @param {number} from - First second, inclusive.
   * @param {number} to - Last second, exclusive.
   * @returns {{ priority: number, withinSeconds: number, behind: boolean, urgent: boolean }}
   *   Priority zero where nobody wants any of it.
   */
  on(from, to) {
    let priority = NOTHING;
    let withinSeconds = Number.POSITIVE_INFINITY;
    let behind = true;
    let urgent = false;
    const pieces = this.#piecesOfFilm();
    // The first stretch that ends after `from`.
    let low = 0;
    let high = pieces.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (pieces[middle].to <= from) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < pieces.length && pieces[index].from < to; index += 1) {
      const { from: start, point } = pieces[index];
      if (point.priority === NOTHING) continue;
      if (point.priority > priority) priority = point.priority;
      // Inside a stretch every viewer in front stays in front and their time
      // rises a second a second, so the soonest time rises with it.
      const until = point.untilSeconds + (Math.max(from, start) - start);
      if (until < withinSeconds) withinSeconds = until;
      if (!point.behind) behind = false;
      if (point.urgent) urgent = true;
    }
    return { priority, withinSeconds, behind, urgent };
  }

  /** @returns {Array<{ from: number, to: number, point: MapPoint }>} */
  #piecesOfFilm() {
    if (this.#pieces) return this.#pieces;
    const breaks = this.#breaks();
    const pieces = [];
    for (let index = 0; index + 1 < breaks.length; index += 1) {
      pieces.push({ from: breaks[index], to: breaks[index + 1], point: this.at(breaks[index]) });
    }
    this.#pieces = pieces;
    return pieces;
  }

  /** Every second where a merged value may change, with 0 and the end, ascending. */
  #breaks() {
    const breaks = new Set([0, this.durationSeconds]);
    for (const viewer of this.#viewers) for (const second of viewer.breaks()) breaks.add(second);
    return [...breaks].filter(second => second >= 0 && second <= this.durationSeconds).sort((left, right) => left - right);
  }

  /**
   * The map as stretches: runs of seconds that agree on everything but the
   * time, ascending, without gaps or overlaps. Seconds nobody wants are left
   * out.
   *
   * THE TIME OF A STRETCH IS THE TIME OF ITS NEAR EDGE. A stretch is met at its
   * beginning, so its beginning is when it must exist; whoever needs the time
   * of a second inside it walks forward from there, at a second of film per
   * second, which is the same arithmetic that put the number here. Merging on
   * the exact time as well would merge nothing at all: the time is the
   * distance, so it differs at every second.
   *
   * @returns {DemandZone[]}
   */
  runs() {
    /** @type {DemandZone[]} */
    const runs = [];
    for (const { from, to, point } of this.#piecesOfFilm()) {
      if (point.priority === NOTHING) continue;
      const previous = runs[runs.length - 1];
      if (previous && previous.to === from && previous.priority === point.priority && previous.behind === point.behind &&
        previous.urgent === point.urgent && previous.deferred === point.deferred) {
        previous.to = to;
        continue;
      }
      runs.push({ from, to, priority: point.priority, withinSeconds: point.untilSeconds, behind: point.behind,
        urgent: point.urgent, deferred: point.deferred });
    }
    return runs;
  }

  /**
   * Where viewers stand, read off the map: every second whose priority rises
   * above the second before it.
   *
   * A viewer's own map is highest where they stand and falls away in front of
   * them, so in a merged map each viewer's position is a step UP — the one place
   * a value is higher than the value just behind it. A viewer standing inside the
   * stretch somebody else is walking towards adds nothing that map does not
   * already ask for, and is not a step; neither is somebody behind everybody.
   *
   * Read by whoever orders work by where people are and must not know what a
   * viewer is — the subtitle walk reads the clusters at these times first.
   *
   * @returns {number[]} Seconds, ascending.
   */
  viewerStarts() {
    const starts = [];
    for (const second of this.#breaks()) {
      if (second >= this.durationSeconds) continue;
      const value = this.at(second).priority;
      const before = second === 0 ? NOBODY_IS_COMING : this.at(second - 1).priority;
      if (value > before && value > NOBODY_IS_COMING) starts.push(second);
    }
    return starts;
  }
}

/**
 * A map with nothing in it, which says the same as nobody watching.
 *
 * @returns {PriorityMap}
 */
export function emptyMap() {
  return new PriorityMap([]);
}

/**
 * How far a viewer's priorities are lowered while they pause beside other
 * viewers: allowance / (allowance + pauseSeconds), once their urgent work is
 * ready; 1 otherwise.
 *
 * @param {{ playing?: boolean, urgentReady?: boolean, viewerCount: number, pauseSeconds?: number, allowanceSeconds?: number }} params
 * @returns {number}
 */
export function pauseCoefficient({ playing, urgentReady, viewerCount, pauseSeconds, allowanceSeconds }) {
  if (playing !== false || !urgentReady || viewerCount <= 1) return 1;
  const allowance = Number.isFinite(allowanceSeconds) && allowanceSeconds > 0 ? allowanceSeconds : 1;
  const elapsed = Number.isFinite(pauseSeconds) ? Math.max(0, pauseSeconds) : 0;
  return allowance / (allowance + elapsed);
}

/**
 * One viewer's map.
 *
 * **What must NOT be here**, and the boundary is the point: how fast this
 * machine encodes, how many encoders that takes, what a second weighs in bytes,
 * where a piece boundary falls, and what has already been made. Those are
 * answers the encoding and the downloading work out for themselves, from this
 * map and from what each knows about itself.
 *
 * @param {object} params
 * @param {number} params.atSeconds - Where they are watching from.
 * @param {number} params.durationSeconds - How long the film is.
 * @param {number} params.allowanceSeconds - The measured depth below which an
 *   interruption reaches this viewer. The width of the first step.
 * @param {boolean} [params.playing] - Whether the picture is moving.
 * @param {number} [params.pauseSeconds]
 * @param {boolean} [params.urgentReady]
 * @param {number} [params.viewerCount]
 * @returns {PriorityMap}
 */
export function mapForViewer(params) {
  return new PriorityMap([new ViewerDemand(params)]);
}

/**
 * Every viewer's map as one.
 *
 * @param {PriorityMap[]} maps
 * @returns {PriorityMap}
 */
export function mergeMaps(maps) {
  return new PriorityMap((maps ?? []).filter(Boolean).flatMap(map => map.viewers));
}

/**
 * The map as stretches (`PriorityMap.runs`).
 *
 * @param {PriorityMap | null | undefined} map
 * @returns {DemandZone[]}
 */
export function runsOf(map) {
  return map ? map.runs() : [];
}

/**
 * Where viewers stand on a map (`PriorityMap.viewerStarts`).
 *
 * @param {PriorityMap | null | undefined} map
 * @returns {number[]}
 */
export function viewerStartsOn(map) {
  return map ? map.viewerStarts() : [];
}

/**
 * The map in the order the work is taken: most urgent first, and within one
 * priority the earliest film first — that is where somebody is stopped.
 *
 * @param {DemandZone[]} runs
 * @returns {DemandZone[]}
 */
export function inWorkingOrder(runs) {
  return [...(runs ?? [])].sort(
    (left, right) => right.priority - left.priority || left.from - right.from
  );
}
