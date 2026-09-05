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
 * How urgently a stretch of film is wanted. Higher is sooner.
 *
 * @typedef {object} DemandZone
 * @property {number} from - First second of film, inclusive.
 * @property {number} to - Last second of film, inclusive.
 * @property {number} priority - Higher is more urgent. Only the ORDER between
 *   zones is meaningful; the numbers themselves are not a scale.
 */

/**
 * The number a stretch gets when nobody is heading towards it.
 *
 * Behind a viewer, and everywhere for a viewer who has stopped the picture: the
 * film is still wanted — a seek back must be cheap — but nobody is on their way
 * there, so it yields to everything anybody is approaching.
 */
export const NOBODY_IS_COMING = 1;

/**
 * The number the second a viewer is about to watch gets. Everything else ahead
 * of them counts down from here.
 *
 * One scale for every viewer, because the maps are merged by taking the highest
 * number per second: two viewers must be comparable, and they are, because the
 * number depends only on how far each of them still has to travel.
 */
export const AT_THE_VIEWER = 32;

/**
 * One viewer's map: seconds of film against a number, and nothing else.
 *
 * **The number is a reading of how soon they will be there.** A viewer moving
 * forward reaches the second `x` after `x - p` seconds of film. That distance —
 * not a clock time, not a deadline — is what the number is derived from, and it
 * is why two viewers can be compared at all: the nearer one wins the second
 * they both want.
 *
 * **The bands widen as they go.** Near the viewer the difference between now
 * and ten seconds away decides what is made first; twenty minutes out, the
 * difference between twenty and twenty-one changes nothing. So the first band
 * is the measured allowance — the depth below which an interruption reaches
 * this viewer — and each next band is twice the last. A film of any length is
 * then described by a handful of bands, fine where it matters.
 *
 * **What must NOT be here**, and the boundary is the point: how fast this
 * machine encodes, how many encoders that takes, what a second weighs in bytes,
 * where a piece boundary falls. Those are answers the encoding and the
 * downloading work out for themselves, from this map and from what each knows
 * about itself.
 *
 * @param {object} params
 * @param {number} params.atSeconds - Where they are watching from.
 * @param {number} params.durationSeconds - How long the film is.
 * @param {number} params.allowanceSeconds - The measured depth below which an
 *   interruption reaches this viewer. The width of the first band.
 * @param {boolean} [params.playing] - Whether the picture is moving. A viewer
 *   who has stopped it is going nowhere, so nothing is nearer to them than
 *   anything else.
 * @returns {DemandZone[]} Ascending by position, without gaps or overlaps.
 */
export function mapForViewer({ atSeconds, durationSeconds, allowanceSeconds, playing = true }) {
  const from = Number.isFinite(atSeconds) && atSeconds > 0 ? atSeconds : 0;
  const end = Number.isFinite(durationSeconds) ? durationSeconds : 0;
  if (!(end > 0)) {
    return [];
  }
  const allowance = Number.isFinite(allowanceSeconds) && allowanceSeconds > 0 ? allowanceSeconds : 0;
  if (!playing || allowance <= 0) {
    // Nobody is on their way anywhere: the film is wanted and nothing in it is
    // wanted sooner than the rest.
    return [{ from: 0, to: end, priority: NOBODY_IS_COMING }];
  }

  /** @type {DemandZone[]} */
  const zones = [];
  if (from > 0) {
    zones.push({ from: 0, to: from, priority: NOBODY_IS_COMING });
  }
  let at = from;
  let width = allowance;
  let priority = AT_THE_VIEWER;
  while (at < end && priority > NOBODY_IS_COMING + 1) {
    const to = Math.min(end, at + width);
    zones.push({ from: at, to, priority });
    at = to;
    width *= 2;
    priority -= 1;
  }
  if (at < end) {
    // Everything left is equally far off: at this distance one more band would
    // not change any decision.
    zones.push({ from: at, to: end, priority: NOBODY_IS_COMING + 1 });
  }
  return zones;
}

/**
 * Every viewer's map as one.
 *
 * The highest priority per second wins: film two people want is as urgent as
 * the more urgent of them, and making it once serves both. What comes back has
 * no overlaps, so the filling can walk it without asking about any individual
 * viewer — which is the rule this layer exists to keep, that which viewer asked
 * never reaches the encoders.
 *
 * @param {DemandZone[][]} maps
 * @returns {DemandZone[]} Ascending by position.
 */
export function mergeMaps(maps) {
  /** @type {DemandZone[]} */
  const all = [];
  for (const map of maps ?? []) {
    for (const zone of map ?? []) {
      if (Number.isFinite(zone?.from) && Number.isFinite(zone?.to) && zone.to > zone.from) {
        all.push(zone);
      }
    }
  }
  if (all.length === 0) {
    return [];
  }
  // Walked by BOUNDARIES rather than by second: a film is thousands of them and
  // this is asked again on every change.
  const points = [...new Set(all.flatMap((zone) => [zone.from, zone.to]))].sort(
    (left, right) => left - right
  );
  /** @type {DemandZone[]} */
  const merged = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    let priority = 0;
    for (const zone of all) {
      if (zone.from <= from && to <= zone.to && zone.priority > priority) {
        priority = zone.priority;
      }
    }
    if (priority <= 0) {
      continue;
    }
    const previous = merged[merged.length - 1];
    if (previous && previous.priority === priority && previous.to === from) {
      previous.to = to;
      continue;
    }
    merged.push({ from, to, priority });
  }
  return merged;
}

/**
 * The merged map in the order the work is taken: most urgent first, and within
 * one priority the earliest film first — that is where somebody is stopped.
 *
 * @param {DemandZone[]} merged
 * @returns {DemandZone[]}
 */
export function inWorkingOrder(merged) {
  return [...(merged ?? [])].sort(
    (left, right) => right.priority - left.priority || left.from - right.from
  );
}
