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
 * THE MAP ITSELF: one number per second of film.
 *
 * Literally an array as long as the film, where the value at second `x` says how
 * urgently that second is wanted. Stated by the user 2026-09-06, and it replaced
 * a list of stretches each carrying two numbers.
 *
 * Two arrays rather than one, because two different questions are asked of the
 * map and only one of them can be answered by a rank:
 *
 * - `priority` orders the work. Only the ORDER between values is meaningful;
 *   the scale below says what the numbers separate;
 * - `secondsUntilPlayed` is a quantity, and it is what makes lateness
 *   computable at all: whoever fills the map compares "when is this needed"
 *   against "when would it arrive", and only the second half is theirs to work
 *   out. `Infinity` where nobody is on their way.
 *
 * @typedef {object} PriorityMap
 * @property {number} durationSeconds - The film's length, in whole seconds.
 * @property {Uint8Array} priority - One entry per second. Zero means nothing is
 *   wanted there, which happens only where nobody is watching at all.
 * @property {Float64Array} secondsUntilPlayed - One entry per second.
 * @property {Uint8Array} behind - One entry per second, 1 where the second lies
 *   behind EVERY viewer. Stated rather than worked out from the other two,
 *   because working it out means knowing this file's scale, and the consumers
 *   are in other layers. Inferred from the absence of a time, as it was, it was
 *   wrong for a stopped viewer: their whole film carries no time, so the film in
 *   front of them counted as behind them and the encoders wandered to the start
 *   of the file.
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
 * @property {boolean} behind - Whether this lies behind every viewer.
 */

/**
 * THE SCALE. Three bands, and the order between them is the whole of what the
 * numbers claim.
 *
 * 1. IN FRONT OF SOMEBODY WHO IS WATCHING — the top value at the second they
 *    are about to see, falling as the film gets further from them;
 * 2. IN FRONT OF SOMEBODY WHO HAS STOPPED — the same shape, and every value of
 *    it below every value of band 1. A stopped viewer will watch this film when
 *    they press play, so it is still in front of them; nobody is waiting for it
 *    now, so it yields to anybody who is;
 * 3. BEHIND EVERYBODY — reachable only by a seek back, and nothing measures how
 *    likely that is, so it is one value rather than a shape.
 *
 * IN FRONT ALWAYS OUTRANKS BEHIND, at any distance and whoever is stopped. The
 * bands make that true by construction rather than by a comparison somebody has
 * to remember to write.
 *
 * The values inside a band are AN ENCODING OF AN ORDER, not a measurement:
 * every consumer asks only which of two seconds comes first, so any strictly
 * decreasing shape does the same work, and none of these numbers claims
 * anything about the world.
 */
export const AT_A_WATCHING_VIEWER = 100;
const WATCHING_FLOOR = 70;
const AT_A_STOPPED_VIEWER = 69;
const STOPPED_FLOOR = 39;

/** Behind everybody. */
export const NOBODY_IS_COMING = 1;

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
  return priority > NOBODY_IS_COMING && priority <= AT_A_STOPPED_VIEWER;
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

/**
 * An empty map of the right length: nothing wanted anywhere.
 *
 * @param {number} durationSeconds
 * @returns {PriorityMap}
 */
export function emptyMap(durationSeconds) {
  const seconds = Number.isFinite(durationSeconds) && durationSeconds > 0
    ? Math.ceil(durationSeconds)
    : 0;
  return {
    durationSeconds: seconds,
    priority: new Uint8Array(seconds),
    secondsUntilPlayed: new Float64Array(seconds).fill(Number.POSITIVE_INFINITY),
    behind: new Uint8Array(seconds).fill(1)
  };
}

/**
 * One viewer's map.
 *
 * **The number is a reading of how soon they will be there.** A viewer watching
 * forward reaches second `x` after `x - p` seconds of film. That distance — not
 * a clock time — is what the value is derived from, and it is why two viewers
 * can be compared at all: the nearer one wins the second they both want.
 *
 * **A pause removes the time, not the direction.** A stopped viewer is still
 * standing somewhere, and the film in front of them is still the film they will
 * watch, so their map keeps its shape and moves into the band below. Collapsed
 * to one flat value over the whole film, as it was, their position disappeared
 * entirely — and with it the rule that what is in front is made first.
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
 * @returns {PriorityMap}
 */
export function mapForViewer({ atSeconds, durationSeconds, allowanceSeconds, playing = true }) {
  const map = emptyMap(durationSeconds);
  if (map.durationSeconds === 0) {
    return map;
  }
  const at = Number.isFinite(atSeconds) && atSeconds > 0 ? Math.floor(atSeconds) : 0;
  const allowance = Number.isFinite(allowanceSeconds) && allowanceSeconds > 0
    ? allowanceSeconds
    : 1;
  const watching = playing !== false;
  const top = watching ? AT_A_WATCHING_VIEWER : AT_A_STOPPED_VIEWER;
  const floor = watching ? WATCHING_FLOOR : STOPPED_FLOOR;
  for (let second = 0; second < map.durationSeconds; second += 1) {
    if (second < at) {
      map.priority[second] = NOBODY_IS_COMING;
      continue;
    }
    map.behind[second] = 0;
    const distance = second - at;
    map.priority[second] = Math.max(floor, top - stepsAway(distance, allowance));
    // A viewer who has stopped is on their way nowhere, so there is no second by
    // which any of this must exist. The direction survives the pause, in the
    // priority above; the time does not, because there is none to state.
    map.secondsUntilPlayed[second] = watching ? distance : Number.POSITIVE_INFINITY;
  }
  return map;
}

/**
 * Every viewer's map as one.
 *
 * The highest priority per second wins, and the soonest time: film two people
 * want is as urgent as the more urgent of them, and making it once serves both.
 * The two are taken separately on purpose — the priority is coarse, so two
 * viewers can tie on it while one is genuinely nearer, and whoever schedules
 * against the time must be given the nearer one.
 *
 * In front of ANYBODY is in front, and the third array says so directly.
 *
 * @param {PriorityMap[]} maps
 * @returns {PriorityMap}
 */
export function mergeMaps(maps) {
  const all = (maps ?? []).filter((map) => map && map.durationSeconds > 0);
  if (all.length === 0) {
    return emptyMap(0);
  }
  const merged = emptyMap(Math.max(...all.map((map) => map.durationSeconds)));
  for (const map of all) {
    for (let second = 0; second < map.durationSeconds; second += 1) {
      if (map.priority[second] > merged.priority[second]) {
        merged.priority[second] = map.priority[second];
      }
      if (map.secondsUntilPlayed[second] < merged.secondsUntilPlayed[second]) {
        merged.secondsUntilPlayed[second] = map.secondsUntilPlayed[second];
      }
      // In front of ANYBODY is in front: a stretch one viewer has passed is
      // still the film another is walking towards.
      if (map.behind[second] === 0) {
        merged.behind[second] = 0;
      }
    }
  }
  return merged;
}

/**
 * The map as stretches: runs of seconds that agree on both numbers.
 *
 * A VIEW of the map, never a second copy of it. Consumers that work in ranges —
 * the swarm is asked for byte ranges, an encoder is given a stretch of pieces —
 * would otherwise each write this walk for themselves.
 *
 * @param {PriorityMap} map
 * @returns {DemandZone[]} Ascending, without gaps or overlaps. Seconds nobody
 *   wants are left out.
 */
export function runsOf(map) {
  /** @type {DemandZone[]} */
  const runs = [];
  if (!map || !(map.durationSeconds > 0)) {
    return runs;
  }
  for (let second = 0; second < map.durationSeconds; second += 1) {
    const priority = map.priority[second];
    if (priority === NOTHING) {
      continue;
    }
    const behind = map.behind[second] === 1;
    const previous = runs[runs.length - 1];
    if (
      previous
      && previous.to === second
      && previous.priority === priority
      && previous.behind === behind
    ) {
      previous.to = second + 1;
      continue;
    }
    // THE TIME OF A STRETCH IS THE TIME OF ITS NEAR EDGE. A stretch is met at
    // its beginning, so its beginning is when it must exist; whoever needs the
    // time of a second inside it walks forward from there, at a second of film
    // per second, which is the same arithmetic that put the number here.
    //
    // Merging on the exact time as well would merge nothing at all: the time is
    // the distance, so it differs at every second, and the map came back as one
    // stretch per second of film.
    const withinSeconds = map.secondsUntilPlayed[second];
    runs.push({
      from: second,
      to: second + 1,
      priority,
      withinSeconds,
      behind
    });
  }
  return runs;
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
