/**
 * @file A whole-pass reference for translating priority maps into torrent
 * demand: each segment's demand, its deadline less making and delivery, and
 * the next run's input raised to its first segment's place. The projection is
 * compared against this simpler calculation, including non-final segment end
 * boundaries.
 */

/** Translate map demand to complete output intervals and selected source tracks. */
export function segmentDemands(output, fileIndex, zones) {
  const tracks = [];
  for (const type of ["video", "audio"]) {
    const spec = output.spec?.[type];
    if (spec?.fileIndex !== fileIndex) continue;
    tracks.push({ type, index: type === "video" ? 0 : spec.trackIndex,
      mode: type === "video" ? spec.encode ? "transcode" : "copy" : spec.transcode ? "transcode" : "copy" });
  }
  if (!tracks.length) return [];
  const grid = output.timeline?.published ?? output.timeline?.boundaries;
  if (!Array.isArray(grid)) return [];
  const demands = [];
  // THE ZONES ARE WALKED BESIDE THE SEGMENTS, not searched for each of them.
  // A map's zones come ascending and apart (`PriorityMap.runs`) and the grid is
  // ascending, so the zones a segment overlaps begin at or after those of the
  // segment before it. Every zone filtered for every segment was thousands of
  // segments by tens of zones on every pass over a film (r26,
  // torrent-tv/meta#178). Zones in any other order are filtered as before.
  const ordered = ascendingAndApart(zones);
  let first = 0;
  for (let index = 0; index + 1 < grid.length; index++) {
    const from = grid[index];
    const to = grid[index + 1];
    const reach = index + 2 < grid.length ? Math.max(to, Math.floor(to) + 1) : to;
    if (!Number.isFinite(from) || !Number.isFinite(to) || !(to > from)) throw new Error("An output segment needs a valid interval.");
    if (ordered) while (first < zones.length && zones[first].to <= from) first += 1;
    // The zones a segment overlaps are folded as they are met, into numbers:
    // a list of them, and the lists made of it for each field, were five
    // arrays for every segment of a film on every pass (r30,
    // torrent-tv/meta#178).
    let owner = null, ownerDeadline = Infinity, priority = 0, urgent = false, behind = true, deferred = true;
    for (let at = ordered ? first : 0; at < zones.length; at += 1) {
      const zone = zones[at];
      if (ordered && !(zone.from < reach)) break;
      if (!(zone.priority > 0) || !(zone.from < reach && zone.to > from)) continue;
      // A zone states the deadline of its near edge. A later segment within it
      // is reached later, at one second of film per second of playback.
      const deadline = Number.isFinite(zone.deadlineAt) ? zone.deadlineAt + Math.max(0, from - zone.from) * 1000 : Infinity;
      if (owner === null || deadline < ownerDeadline) { owner = zone; ownerDeadline = deadline; }
      if (zone.priority > priority) priority = zone.priority;
      if (zone.urgent) urgent = true;
      if (!zone.behind) behind = false;
      if (!zone.deferred) deferred = false;
    }
    if (owner === null) continue;
    demands.push({ index, from, to, tracks, owner, priority, urgent, behind, deferred, deadlineAt: ownerDeadline });
  }
  return demands.sort((left, right) => left.deadlineAt - right.deadlineAt || right.priority - left.priority || left.index - right.index);
}

/** Whether zones come ascending and without overlaps, as a map's runs do. */
function ascendingAndApart(zones) {
  for (let index = 1; index < zones.length; index += 1) {
    if (!(zones[index].from >= zones[index - 1].to)) return false;
  }
  return true;
}

/** Source bytes must arrive before measured processing and delivery consume time. */
export function sourceDeadline(demand, { encodeSpeed, outputBytes, linkMbps }) {
  const span = demand.to - demand.from;
  const processing = Number.isFinite(encodeSpeed) && encodeSpeed > 0 ? span / encodeSpeed : 0;
  const delivery = Number.isFinite(outputBytes) && outputBytes > 0 && Number.isFinite(linkMbps) && linkMbps > 0
    ? outputBytes * 8 / (linkMbps * 1_000_000) : 0;
  return Number.isFinite(demand.deadlineAt) ? demand.deadlineAt - (processing + delivery) * 1000 : demand.deadlineAt;
}

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
