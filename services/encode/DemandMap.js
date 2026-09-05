/**
 * @file What one viewer needs of an output, and what all of them need together.
 *
 * The shape, stated by the user 2026-09-05:
 *
 * > Usually you make a map for each viewer, then merge the maps, then decide
 * > the best way of filling it given the encoders available, where they are now
 * > and how many there are.
 *
 * So there are three separate questions and this file answers the first two.
 * The third — the filling — is `EncodePlan`, and it is given the merged map
 * rather than a list of windows.
 *
 * **A viewer's map is a priority per segment number.** Highest where they are
 * watching from, falling away in front of them. Nothing is zero-priority
 * because it is far away: the track is encoded whole, and distance decides only
 * what is done FIRST.
 *
 * **The zone sizes come from a measurement, never from a constant.** How much
 * film one encoder makes in a second is measured at startup and corrected per
 * track while it runs, so "how far ahead is the urgent zone" is answered by how
 * far this machine can actually get. A host encoding at 0.5x has a shorter
 * urgent zone than one encoding at 4x, because the same seconds of wall clock
 * buy less film.
 *
 * **Merging takes the highest priority per number**, because a segment two
 * people want is as urgent as the more urgent of them, and no more work than
 * making it once.
 *
 * Nothing here knows about ffmpeg, sessions, the disk or the torrent. It is
 * numbers in, numbers out, so every rule can be exercised without any of them.
 */

/**
 * How urgently a stretch of an output is wanted. Higher is sooner.
 *
 * @typedef {object} DemandZone
 * @property {number} from - First segment number, inclusive.
 * @property {number} to - Last segment number, inclusive.
 * @property {number} priority - Higher is more urgent.
 */

/**
 * The priority a viewer's own position carries. Every other zone is a fraction
 * of it, so the number itself means nothing in isolation and only the ORDER
 * between zones is used.
 */
const AT_THE_VIEWER = 1000;

/**
 * One viewer's map: what they need, in the order they need it.
 *
 * Three zones, and the boundaries are measured rather than chosen:
 *
 * 1. **where they are** — the segment they are watching from, and the cushion
 *    that must exist before an interruption reaches them. That is
 *    `minimumBufferSeconds`, which this proxy already measures for every
 *    (source, file): one whole segment plus the worst delay observed on this
 *    swarm. Nothing above it protects the viewer any better;
 * 2. **what this machine can reach while they watch it** — from the cushion out
 *    to as far as the encoder gets in the time the film itself takes. At 2x the
 *    machine stays ahead of the viewer, so this zone is long; at 0.5x it cannot
 *    keep up at all and the zone is short, which is the honest statement that
 *    the rest will be late whatever order it is done in;
 * 3. **the rest of the track** — still wanted, because the file is encoded
 *    whole, and still lowest, because nobody is waiting for it yet.
 *
 * @param {object} params
 * @param {number} params.at - The segment they are watching from.
 * @param {number} params.segmentCount - How many segments the output has.
 * @param {number} params.segmentSeconds - How much film one segment holds.
 * @param {number} params.cushionSeconds - The measured cushion below which an
 *   interruption reaches this viewer (`minimumBufferSeconds`).
 * @param {number} params.encodeSpeedX - Measured encode speed against realtime
 *   for this track on this machine. Zero or less means nothing has measured it
 *   yet, and then the reachable zone is left out rather than guessed at.
 * @returns {DemandZone[]} Highest priority first, no overlaps, ascending.
 */
export function mapForViewer({ at, segmentCount, segmentSeconds, cushionSeconds, encodeSpeedX }) {
  const first = Number.isInteger(at) && at > 0 ? at : 0;
  const last = Number.isInteger(segmentCount) && segmentCount > 0 ? segmentCount - 1 : -1;
  if (last < first) {
    return [];
  }
  const perSegment = Number.isFinite(segmentSeconds) && segmentSeconds > 0 ? segmentSeconds : 0;
  /** @type {DemandZone[]} */
  const zones = [];

  // 1. WHAT MUST BE READY SO THE VIEWER NEVER STOPS. Not a cushion against the
  //    swarm and not a chosen number of seconds: it is what this machine's own
  //    measured speed says it will fail to deliver in time.
  //
  //    While the viewer watches, film is consumed at 1x and produced at
  //    `encodeSpeedX`. Above realtime the encoder gains on them and the only
  //    thing needed in front is the measured allowance for the unevenness of
  //    the swarm and of production — `minimumBufferSeconds`, which this proxy
  //    already computes per (source, file). Below realtime it LOSES `1 - speed`
  //    of a second for every second played, so over the `remaining` seconds of
  //    film in front of them the shortfall is `remaining × (1 - speed)`, and
  //    that much has to exist before they set off. That is the whole zone: at
  //    0.5x on twenty minutes of film ahead, ten minutes must be ready.
  const remainingSeconds = (last - first + 1) * perSegment;
  const measuredCushion = Number.isFinite(cushionSeconds) && cushionSeconds > 0 ? cushionSeconds : 0;
  const shortfall = Number.isFinite(encodeSpeedX) && encodeSpeedX > 0 && encodeSpeedX < 1
    ? remainingSeconds * (1 - encodeSpeedX)
    : 0;
  const neededSeconds = measuredCushion + shortfall;
  const neededSegments = perSegment > 0 && neededSeconds > 0 ? Math.ceil(neededSeconds / perSegment) : 1;
  const cushionEnd = Math.min(last, first + Math.max(1, neededSegments) - 1);
  zones.push({ from: first, to: cushionEnd, priority: AT_THE_VIEWER });

  // 2. What this machine reaches WHILE they watch what zone 1 holds. Beyond it
  //    nobody is waiting yet, but it is still in front of a viewer who is
  //    moving, so it outranks the rest of the track.
  if (cushionEnd < last && Number.isFinite(encodeSpeedX) && encodeSpeedX > 0) {
    const watchedSeconds = (cushionEnd - first + 1) * perSegment;
    const reachable = perSegment > 0 ? Math.floor((watchedSeconds * encodeSpeedX) / perSegment) : 0;
    if (reachable > 0) {
      zones.push({
        from: cushionEnd + 1,
        to: Math.min(last, cushionEnd + reachable),
        priority: Math.round(AT_THE_VIEWER / 2)
      });
    }
  }

  // 3. The rest of the track, wanted last and still wanted.
  const covered = zones.length > 0 ? zones[zones.length - 1].to : first - 1;
  if (covered < last) {
    zones.push({ from: covered + 1, to: last, priority: 1 });
  }
  return zones;
}

/**
 * Every viewer's map as one.
 *
 * The highest priority per number wins: a segment two people want is as urgent
 * as the more urgent of them, and making it once serves both. What comes back
 * is a set of non-overlapping stretches in ascending order, so the filling can
 * walk it without asking about any individual viewer — which is the rule this
 * layer exists to keep: which viewer asked never reaches the encoders.
 *
 * @param {DemandZone[][]} maps
 * @returns {DemandZone[]}
 */
export function mergeMaps(maps) {
  /** @type {DemandZone[]} */
  const all = [];
  for (const map of maps ?? []) {
    for (const zone of map ?? []) {
      if (Number.isInteger(zone?.from) && Number.isInteger(zone?.to) && zone.to >= zone.from) {
        all.push(zone);
      }
    }
  }
  if (all.length === 0) {
    return [];
  }
  // Every number that any map mentions, at the highest priority anybody gives
  // it. Walked by BOUNDARIES rather than by number: a film is tens of thousands
  // of segments and this is asked on every change.
  const edges = new Set();
  for (const zone of all) {
    edges.add(zone.from);
    edges.add(zone.to + 1);
  }
  const points = [...edges].sort((left, right) => left - right);
  /** @type {DemandZone[]} */
  const merged = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1] - 1;
    if (to < from) {
      continue;
    }
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
    if (previous && previous.priority === priority && previous.to + 1 === from) {
      previous.to = to;
      continue;
    }
    merged.push({ from, to, priority });
  }
  return merged;
}

/**
 * The merged map in the order the work should be taken: most urgent first, and
 * within one priority, lowest number first — that is where a viewer is
 * stopped.
 *
 * @param {DemandZone[]} merged
 * @returns {DemandZone[]}
 */
export function inWorkingOrder(merged) {
  return [...(merged ?? [])].sort(
    (left, right) => right.priority - left.priority || left.from - right.from
  );
}
