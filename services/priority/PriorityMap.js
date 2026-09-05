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

/** Where the viewer stands. Nothing outranks it. */
const AT_THE_VIEWER = 33;

/** In front of them, within reach while they watch what is already made. */
const IN_FRONT = 32;

/** The rest of the track: wanted, because the file is encoded whole. */
const THE_REST = 1;

/**
 * How many zones one viewer's map may hold.
 *
 * Below realtime the zones grow geometrically, so their number is the logarithm
 * of the film left over what the viewer holds — five on the addon host's worst
 * measured case, and it grows by one each time the speed halves. The bound is
 * not a policy about how many encoders may run (the machine's budget answers
 * that, and it is far smaller); it stops a speed measured at almost zero from
 * turning a film into thousands of slivers before anything reads the map.
 */
const MOST_ZONES = 32;

/**
 * One viewer's map, and every boundary in it is measured rather than chosen.
 *
 * The shape depends on one measured number — how fast this machine encodes this
 * track against realtime:
 *
 * - **at or above realtime** the encoder gains on the viewer everywhere, so one
 *   of them holds the whole film. Three zones: the measured allowance in front
 *   of the viewer, what the encoder reaches while they watch it, and the rest;
 * - **below realtime** the encoder loses `1 - speed` of a second for every
 *   second played, so one cannot hold the film and the map says how many can.
 *   An encoder starting at `q` stays ahead of a viewer at `p` for
 *   `(q - p) * s / (1 - s)`, which GROWS with its distance from them — so the
 *   zones grow, each is one encoder's share, and their number is the smallest
 *   that holds this viewer.
 *
 * The last zone is always the rest of the track, wanted because the file is
 * encoded whole and last because nobody is waiting on it.
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
  const allowance = Number.isFinite(allowanceSeconds) && allowanceSeconds > 0 ? allowanceSeconds : 0;
  const speed = Number.isFinite(encodeSpeedX) && encodeSpeedX > 0 ? encodeSpeedX : 0;

  /** @type {DemandZone[]} */
  const zones = [];

  // AT OR ABOVE REALTIME ONE ENCODER SUFFICES, whatever the film's length.
  //
  // From the condition below with `s >= 1`: the encoder gains on the viewer at
  // every point, so there is no distance at which they catch it. All that has
  // to exist in front of them is the allowance this file's own interruptions
  // have shown to be necessary.
  if (speed === 0 || speed >= 1) {
    const readyBy = Math.min(end, from + allowance);
    zones.push({ from, to: readyBy, priority: AT_THE_VIEWER });
    if (readyBy < end && speed > 0) {
      // While they watch what the first zone holds, the encoder makes `speed`
      // times as much again. Beyond that nobody is waiting yet.
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

  // BELOW REALTIME THE ZONES GROW, AND EACH IS ONE ENCODER'S SHARE.
  //
  // An encoder starting at `q` produces the point `q + y` after `y / s`, and the
  // viewer reaches it after `q + y - p`. It stays ahead while
  //
  //     y <= (q - p) * s / (1 - s)
  //
  // so the length one encoder can hold GROWS with its distance from the viewer:
  // the further off it starts, the later the viewer arrives. Equal shares are
  // therefore the wrong division, and by a wide margin — on the addon host with
  // 2400 s of film left, 120 s held and 0.5x, equal shares need twenty encoders
  // and growing ones need five (120, 240, 480, 960, 1920).
  //
  // Each zone is exactly as long as its bound allows, which makes the count the
  // smallest that can hold this viewer: any zone longer stalls them, and any
  // shorter leaves the next one starting nearer, where its own bound is tighter.
  // With nothing held, no partition holds this viewer: the first encoder can
  // stay ahead for `b * s / (1 - s)`, and that is zero. Saying so plainly beats
  // slicing the film into equal slivers that pretend otherwise — the whole of
  // what is left is urgent, and it will still not be enough.
  if (allowance <= 0) {
    return [{ from, to: end, priority: AT_THE_VIEWER }];
  }
  const growth = speed / (1 - speed);
  let at = from;
  let held = allowance;
  let priority = AT_THE_VIEWER;
  while (at < end && zones.length < MOST_ZONES) {
    const share = held * growth;
    const to = Math.min(end, at + share);
    zones.push({ from: at, to, priority });
    held += to - at;
    at = to;
    // The next zone is one step less urgent: the viewer meets the one before it
    // first. One scale for every viewer, or merging two maps would compare
    // numbers that mean different things.
    priority = Math.max(THE_REST + 1, priority - 1);
  }
  if (at < end) {
    zones.push({ from: at, to: end, priority: THE_REST });
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
