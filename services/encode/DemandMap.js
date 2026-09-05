/**
 * @file What one viewer needs, what all of them need together, and in what
 * order the work should be taken.
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

/** Where the viewer stands. Nothing outranks it. */
const AT_THE_VIEWER = 3;

/** In front of them, within reach while they watch what is already made. */
const IN_FRONT = 2;

/** The rest of the track: wanted, because the file is encoded whole. */
const THE_REST = 1;

/**
 * One viewer's map.
 *
 * Three zones, and the two boundaries between them are measured rather than
 * chosen:
 *
 * 1. **what must be ready before they set off, so that they never stop.** While
 *    they watch, film is consumed at one second per second and produced at
 *    `encodeSpeedX`. Above realtime the encoder gains on them, and all that is
 *    needed in front is the measured allowance for unevenness in the swarm and
 *    in production. Below realtime it LOSES `1 - speed` of a second for every
 *    second played, so over the film in front of them the shortfall is
 *    `remaining × (1 - speed)` — at 0.5x on twenty minutes ahead, ten minutes
 *    must exist before they start, or they meet a stall partway through;
 * 2. **what the machine reaches while they watch zone 1** — in front of a
 *    moving viewer, so ahead of the rest, and nobody is waiting for it yet, so
 *    behind zone 1;
 * 3. **the rest of the track.**
 *
 * @param {object} params
 * @param {number} params.atSeconds - Where they are watching from.
 * @param {number} params.durationSeconds - How long the film is.
 * @param {number} params.allowanceSeconds - The measured depth below which an
 *   interruption reaches this viewer (`minimumBufferSeconds`).
 * @param {number} params.encodeSpeedX - Measured encode speed against realtime
 *   for this track on this machine. Zero or less means nothing has measured it
 *   yet, and then zone 2 is left out rather than invented.
 * @returns {DemandZone[]} Ascending, without gaps or overlaps, covering
 *   everything from where they are to the end of the film.
 */
export function mapForViewer({ atSeconds, durationSeconds, allowanceSeconds, encodeSpeedX }) {
  const from = Number.isFinite(atSeconds) && atSeconds > 0 ? atSeconds : 0;
  const end = Number.isFinite(durationSeconds) ? durationSeconds : 0;
  if (!(end > from)) {
    return [];
  }
  const remaining = end - from;
  const allowance = Number.isFinite(allowanceSeconds) && allowanceSeconds > 0 ? allowanceSeconds : 0;
  const speed = Number.isFinite(encodeSpeedX) && encodeSpeedX > 0 ? encodeSpeedX : 0;
  const shortfall = speed > 0 && speed < 1 ? remaining * (1 - speed) : 0;

  /** @type {DemandZone[]} */
  const zones = [];
  const readyBy = Math.min(end, from + allowance + shortfall);
  zones.push({ from, to: readyBy, priority: AT_THE_VIEWER });

  if (readyBy < end && speed > 0) {
    // While they watch what zone 1 holds, the encoder makes `speed` times that
    // much. Beyond it nobody is waiting yet.
    const reach = Math.min(end, readyBy + (readyBy - from) * speed);
    if (reach > readyBy) {
      zones.push({ from: readyBy, to: reach, priority: IN_FRONT });
    }
  }

  const covered = zones[zones.length - 1].to;
  if (covered < end) {
    zones.push({ from: covered, to: end, priority: THE_REST });
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
