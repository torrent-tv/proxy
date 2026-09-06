/**
 * @file Flattening overlapping stretches into non-overlapping ones — arithmetic,
 * belonging to no layer.
 *
 * It is here rather than inside one of them because it is not a fact about
 * anything. It takes numbers and gives numbers back; it does not know whether a
 * stretch is measured in seconds of film or in segment numbers, who stated it,
 * or what the rank and the time mean. Two layers need this operation over their
 * own units — the priority map over seconds, the demand register over segment
 * numbers — and each importing the other to get at it is exactly the coupling
 * the layer rule forbids.
 *
 * Sharing arithmetic is not sharing a layer: a pure function cannot reach back
 * into its caller, cannot be stale, and can be exercised with plain values.
 */

/**
 * One stretch, half-open: `from` is included, `to` is not.
 *
 * @typedef {object} Stretch
 * @property {number} from
 * @property {number} to
 * @property {number} priority - Higher is more urgent. Only the ORDER between
 *   stretches is meaningful.
 * @property {number} [withinSeconds] - How long until the near edge is needed.
 *   `Infinity`, or absent, where nothing is waiting on it.
 */

/**
 * Flatten overlapping stretches into non-overlapping ones.
 *
 * Where several cover the same place, the result carries the HIGHEST rank and
 * the SOONEST time. Those are two readings of one thing and are taken
 * separately on purpose: ranks are coarse — a band covers a wide stretch of
 * distance — so two claimants tie on the rank while one of them is genuinely
 * nearer, and a scheduler comparing times must be given the nearer one.
 *
 * Neighbours that agree on both are joined, so the result is as few stretches as
 * describe it.
 *
 * Walked by BOUNDARIES rather than by unit: a film is thousands of them and this
 * is asked again on every change.
 *
 * @param {Stretch[][]} maps
 * @returns {Stretch[]} Ascending by position, no two overlapping.
 */
export function mergeStretches(maps) {
  const all = (maps ?? []).flat().filter((zone) => zone && zone.to > zone.from);
  if (all.length === 0) {
    return [];
  }
  const points = [...new Set(all.flatMap((zone) => [zone.from, zone.to]))].sort(
    (left, right) => left - right
  );
  /** @type {Stretch[]} */
  const merged = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    let priority = 0;
    let withinSeconds = Number.POSITIVE_INFINITY;
    for (const zone of all) {
      if (zone.from <= from && to <= zone.to) {
        if (zone.priority > priority) {
          priority = zone.priority;
        }
        const within = Number(zone.withinSeconds);
        if (Number.isFinite(within) && within < withinSeconds) {
          withinSeconds = within;
        }
      }
    }
    if (priority <= 0) {
      continue;
    }
    const previous = merged[merged.length - 1];
    if (
      previous
      && previous.priority === priority
      && previous.to === from
      && previous.withinSeconds === withinSeconds
    ) {
      previous.to = to;
      continue;
    }
    merged.push({ from, to, priority, withinSeconds });
  }
  return merged;
}
