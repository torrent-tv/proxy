/**
 * @file The next run's whole input, asked of the swarm as one group.
 *
 * While anything urgent is missing, the swarm is told only the first class
 * (`torrent/download/SwarmSelection.js`), and at a cold start the map's first
 * class is one segment's input. A peer holding none of its pieces then has
 * nothing to send, and a run is admitted only as far as its input has arrived
 * (`encode/EncodeInputs.js`), so it opens again a few seconds of film later.
 *
 * WebTorrent 2.8.5 keeps no order between several non-zero selections — it
 * rotates them (`shufflePriority`) — so the run's input is not stated as a
 * second group behind the first: the segments it covers take the first
 * segment's place in the map, and the swarm is told them as one group. How
 * far that reaches is what `EncodeInputs` would copy for the run, from its
 * copy rate, its open and the memory allowed; it is not worked out again here.
 * A read stopped on its bytes is stated at a level of its own above any of
 * this, and a seek, which moves the map's first segment, moves this with it
 * (torrent-tv/meta#178).
 */

/**
 * The bytes a run's input holds, each counted once: the declarations and
 * indexes every segment of an original file names are held once by the run
 * that reads them. Kept merged and in order, so a segment's ranges are
 * counted against it by search rather than by sorting everything held again —
 * a soundtrack's segments add a few bytes each, and its stretch is walked far.
 */
class HeldBytes {
  /** Inclusive [start, end], merged, ascending. @type {Array<[number, number]>} */
  #ranges = [];
  total = 0;

  /** @param {Array<[number, number]>} ranges */
  constructor(ranges = []) {
    this.add(ranges);
  }

  /** The first held range that ends at or after `at`. */
  #from(at) {
    let low = 0;
    let high = this.#ranges.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.#ranges[middle][1] < at) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  /**
   * What these ranges would add, without adding them.
   *
   * @param {Array<[number, number]>} ranges
   * @returns {number}
   */
  adds(ranges) {
    let added = 0;
    for (const [start, end] of merged(ranges)) {
      let at = start;
      for (let index = this.#from(start); at <= end && index < this.#ranges.length && this.#ranges[index][0] <= end; index++) {
        const [heldStart, heldEnd] = this.#ranges[index];
        if (heldStart > at) added += heldStart - at;
        at = Math.max(at, heldEnd + 1);
      }
      if (at <= end) added += end - at + 1;
    }
    return added;
  }

  /** @param {Array<[number, number]>} ranges */
  add(ranges) {
    for (const [start, end] of merged(ranges)) {
      this.total += this.adds([[start, end]]);
      // Joined with every held range it touches or overlaps.
      const first = this.#from(start - 1);
      let last = first;
      let joinedStart = start;
      let joinedEnd = end;
      while (last < this.#ranges.length && this.#ranges[last][0] <= end + 1) {
        joinedStart = Math.min(joinedStart, this.#ranges[last][0]);
        joinedEnd = Math.max(joinedEnd, this.#ranges[last][1]);
        last++;
      }
      this.#ranges.splice(first, last - first, [joinedStart, joinedEnd]);
    }
  }
}

/** Inclusive ranges merged where they overlap or touch, ascending. @param {Array<[number, number]>} ranges */
function merged(ranges) {
  const sorted = [...ranges].sort((left, right) => left[0] - right[0]);
  const out = [];
  for (const [start, end] of sorted) {
    const previous = out.at(-1);
    if (previous && start <= previous[1] + 1) previous[1] = Math.max(previous[1], end);
    else out.push([start, end]);
  }
  return out;
}

/**
 * The map's byte zones with each output's next run input raised to its first
 * segment's place.
 *
 * @template {{ outputKey: string, index: number, priority: number, urgent?: boolean, behind?: boolean, deferred?: boolean,
 *   ranges?: Array<[number, number]>, byteStart?: number, byteEnd?: number }} Zone
 * @param {Zone[]} zones - One or more per segment, as the map's pass made
 *   them: a segment's zone names all its ranges (`ranges`), any other one
 *   range (`byteStart`-`byteEnd`).
 * @param {(outputKey: string) => number | null} targetBytesOf - What the
 *   output's next run would be given to copy; nothing is raised without it.
 * @returns {Zone[]} In their order; raised zones are copies.
 */
export function expandToTargetInputs(zones, targetBytesOf) {
  // ONE WALK FOR EACH OUTPUT'S FIRST SEGMENT, and the segments after it only
  // as far as the run's input reaches. The map names every segment of a film,
  // and each pass used to group all of them and work out each one's highest
  // priority before looking at the few the run copies: 26 s of the main thread
  // in fifteen minutes of a two-hour AVI on Home Assistant (r24,
  // torrent-tv/meta#178).
  /** @type {Map<string, { index: number, priority: number, zone: Zone }>} */
  const first = new Map();
  for (const zone of zones) {
    const best = first.get(zone.outputKey);
    if (!best || zone.priority > best.priority || (zone.priority === best.priority && zone.index < best.index)) {
      first.set(zone.outputKey, { index: zone.index, priority: zone.priority, zone });
    }
  }
  /** @type {Map<string, { first: { index: number, priority: number, zone: Zone }, target: number, after: Map<number, Zone[]> }>} */
  const runs = new Map();
  for (const [outputKey, best] of first) {
    const target = targetBytesOf(outputKey);
    if (target > 0) runs.set(outputKey, { first: best, target, after: new Map() });
  }
  if (runs.size === 0) return zones;
  /** @type {Map<string, Array<[number, number]>>} */
  const held = new Map();
  for (const zone of zones) {
    const run = runs.get(zone.outputKey);
    if (!run) continue;
    if (zone.index === run.first.index) {
      let ranges = held.get(zone.outputKey);
      if (!ranges) held.set(zone.outputKey, ranges = []);
      ranges.push(...rangesOf(zone));
    } else if (zone.index > run.first.index) {
      const list = run.after.get(zone.index);
      if (list) list.push(zone);
      else run.after.set(zone.index, [zone]);
    }
  }
  /** @type {Map<Zone, Zone>} */
  const raised = new Map();
  for (const [outputKey, run] of runs) {
    const holding = new HeldBytes(held.get(outputKey) ?? []);
    // The run's input is a stretch of consecutive segments: one already made,
    // or not yet worked out, ends it.
    for (let index = run.first.index + 1; run.after.has(index); index++) {
      const list = run.after.get(index);
      const ranges = list.flatMap(rangesOf);
      if (holding.total + holding.adds(ranges) > run.target) break;
      holding.add(ranges);
      for (const zone of list) {
        raised.set(zone, { ...zone, priority: run.first.priority, urgent: run.first.zone.urgent,
          behind: run.first.zone.behind, deferred: run.first.zone.deferred });
      }
    }
  }
  return raised.size === 0 ? zones : zones.map(zone => raised.get(zone) ?? zone);
}

/** The ranges a zone names, inclusive. */
function rangesOf(zone) {
  return Array.isArray(zone.ranges) ? zone.ranges : [[zone.byteStart, zone.byteEnd]];
}
