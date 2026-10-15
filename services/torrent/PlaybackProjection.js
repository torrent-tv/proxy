/**
 * @file The priority map projected onto a file's bytes, KEPT from map to map
 * and brought up to date by what changed (torrent-tv/meta#178, stage C).
 *
 * What the torrent is told about a file being played is worked out from the
 * viewers' map: each output segment takes the map zones it overlaps — the
 * highest priority, its level, and a deadline — its source ranges take the band
 * of the best segment that names them, and the ranges of one band that touch
 * are told as one window. That used to be worked out whole on every map: a
 * pass a second over the 2500-3500 segments of a two-hour film, every segment
 * made into a demand and a zone again, the expansion of the next run's input
 * walked over all of them, and ten thousand ranges packed afresh — while the
 * viewer had moved by a second and a handful of segments had anything new to
 * say (r30: 60 of 60 passes a minute worked out whole).
 *
 * Here the projection is held. Each segment keeps its demand and its ranges,
 * each range knows the segments naming it, each band keeps its ranges in byte
 * order, and the windows are a product of them. A new map changes only what
 * it changes:
 *
 * 1. THE TIME BASE. A deadline is `B + relative`, where `B` is when the viewer
 *    would reach the film's start at the rate they play — `now - floor(at)`,
 *    read off the map's own zones — and `relative` is where the segment lies.
 *    A viewer playing on moves `B` and nothing else, so a map that only moved
 *    `B` reworks no segment: the windows' deadlines are `B` plus the earliest
 *    relative deadline each of them already holds. Every report of the viewer
 *    is taken: nothing is held at an old position for a tolerance's sake. A
 *    map whose zones state no single base — two viewers playing apart — is
 *    worked out in absolute time, segment by segment, as it always was.
 * 2. THE BANDS. Only where the old and the new map say something different of
 *    the film — another priority, level or deadline — is a segment worked out
 *    again: the stretches a band boundary crossed, and the segment where the
 *    viewer stands.
 * 3. THE REST, each where it happens: a segment made leaves the demand, one
 *    lost joins it again; a change of how long a segment takes to make and
 *    deliver moves that output's deadlines; the next run's input is raised
 *    again when its first segment or its size changes; a segment's ranges join
 *    when they are worked out.
 *
 * The rules are the ones the whole pass had — each segment's demand, its
 * deadline less making and delivery, the next run's input raised, the ranges
 * packed (`coalescedZones`) — and the windows are the same:
 * `test/no-torrent/playback-projection.test.js` holds the projection beside
 * that pass (`test/no-torrent/support/whole-pass.js`) on every map of random
 * sequences.
 */

import { Urgency } from "./demand/Urgency.js";

/** A segment's band as one number: the level, then the priority within it (as `coalescedZones` keys it). */
function bandKeyOf(level, priority) {
  return level * 1000 + priority;
}

/** Whether band `left` is fetched before band `right`: the level, then the higher priority. */
function before(left, right) {
  const leftLevel = Math.floor(left / 1000), rightLevel = Math.floor(right / 1000);
  return leftLevel !== rightLevel ? leftLevel < rightLevel : left % 1000 > right % 1000;
}

/** The level of a demand, from its own words (`levelOfMapZone` for a zone that states all three). */
function levelOf(behind, deferred, urgent) {
  return behind ? Urgency.BEHIND : deferred ? Urgency.TAIL : urgent ? Urgency.NEAR : Urgency.AHEAD;
}

/** The priority a demand is stated at, within the register's scale (`priorityOfMapZone`). */
function clampPriority(priority) {
  return Number.isFinite(priority) ? Math.max(1, Math.min(100, priority)) : 1;
}

/** The first entry of a list in byte order that begins at or after `start`. */
function lowerBound(list, start) {
  let low = 0, high = list.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (list[middle].start < start) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Whether zones come ascending and without overlaps, as a map's runs do. */
function ascendingAndApart(zones) {
  for (let index = 1; index < zones.length; index += 1) {
    if (!(zones[index].from >= zones[index - 1].to)) return false;
  }
  return true;
}

/**
 * The time base the zones share — `deadlineAt - from` — or null when they do
 * not share one, or state no deadline at all.
 */
function timeBaseOf(zones) {
  let base = null;
  for (const zone of zones) {
    if (!(zone.priority > 0) || !Number.isFinite(zone.deadlineAt)) continue;
    const own = zone.deadlineAt - zone.from * 1000;
    if (base === null) base = own;
    else if (base !== own) return null;
  }
  return base;
}

/** The first zone that ends after `at`, in ascending zones. */
function firstEndingAfter(zones, at) {
  let low = 0, high = zones.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (zones[middle].to <= at) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The first segment that ends after `at` on a grid of starts. */
function segmentAt(grid, at) {
  let low = 0, high = grid.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (grid[middle + 1] <= at) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * What one stretch of film is told by one map: whether a zone covers it, and
 * the zone's priority, words and deadline offset — the deadline of a second
 * `s` in it being `offset + s * 1000` past the time base.
 */
function stateAt(zones, ordered, at) {
  let zone = null;
  if (ordered) {
    const index = firstEndingAfter(zones, at);
    if (index < zones.length && zones[index].from <= at) zone = zones[index];
  } else {
    zone = zones.find(candidate => candidate.priority > 0 && candidate.from <= at && candidate.to > at) ?? null;
  }
  return zone && zone.priority > 0 ? zone : null;
}

/** Whether two zones say the same of a second they both cover. */
function sameStatement(left, right, leftBase, rightBase) {
  if (left === null || right === null) return left === right;
  if (left.priority !== right.priority || Boolean(left.urgent) !== Boolean(right.urgent) ||
    Boolean(left.behind) !== Boolean(right.behind) || Boolean(left.deferred) !== Boolean(right.deferred)) return false;
  const leftOffset = Number.isFinite(left.deadlineAt) ? left.deadlineAt - leftBase - left.from * 1000 : Infinity;
  const rightOffset = Number.isFinite(right.deadlineAt) ? right.deadlineAt - rightBase - right.from * 1000 : Infinity;
  return leftOffset === rightOffset;
}

/**
 * The stretches of film where two maps say something different, ascending.
 * Both are read in their own time base, so a map that only moved its base
 * differs nowhere.
 */
function differences(previous, next, previousBase, nextBase) {
  const points = new Set();
  for (const zone of previous) { points.add(zone.from); points.add(zone.to); }
  for (const zone of next) { points.add(zone.from); points.add(zone.to); }
  const sorted = [...points].filter(Number.isFinite).sort((left, right) => left - right);
  const previousOrdered = ascendingAndApart(previous), nextOrdered = ascendingAndApart(next);
  const stretches = [];
  for (let index = 0; index + 1 < sorted.length; index += 1) {
    const from = sorted[index], to = sorted[index + 1];
    if (!(to > from)) continue;
    const left = stateAt(previous, previousOrdered, from);
    const right = stateAt(next, nextOrdered, from);
    if (sameStatement(left, right, previousBase, nextBase)) continue;
    const last = stretches.at(-1);
    if (last && last.to === from) last.to = to;
    else stretches.push({ from, to });
  }
  return stretches;
}

/**
 * Ranges a run's input holds, each counted once:
 * merged, ascending, searched rather than sorted again.
 */
class HeldBytes {
  /** @type {Array<[number, number]>} */
  #ranges = [];
  total = 0;

  #from(at) {
    let low = 0, high = this.#ranges.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.#ranges[middle][1] < at) low = middle + 1;
      else high = middle;
    }
    return low;
  }

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

  add(ranges) {
    for (const [start, end] of merged(ranges)) {
      this.total += this.adds([[start, end]]);
      const first = this.#from(start - 1);
      let last = first, joinedStart = start, joinedEnd = end;
      while (last < this.#ranges.length && this.#ranges[last][0] <= end + 1) {
        joinedStart = Math.min(joinedStart, this.#ranges[last][0]);
        joinedEnd = Math.max(joinedEnd, this.#ranges[last][1]);
        last++;
      }
      this.#ranges.splice(first, last - first, [joinedStart, joinedEnd]);
    }
  }
}

/** Inclusive ranges merged where they overlap or touch, ascending. */
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
 * One exact byte range of the file and every active segment naming it: it is
 * told once, in the best band among them, at the earliest deadline among the
 * segments in that band (`coalescedZones`, `bestOfRepeats`).
 */
class RangeEntry {
  constructor(start, end) {
    this.start = start;
    this.end = end;
    /** Band key → the active segments in that band naming this range. @type {Map<number, Set<Segment>>} */
    this.byBand = new Map();
    /** The band it is told in, or null while nobody active names it. */
    this.placed = null;
  }

  /** The best band among the segments naming it. */
  best() {
    let best = null;
    for (const key of this.byBand.keys()) if (best === null || before(key, best)) best = key;
    return best;
  }

  /** The earliest relative deadline among the segments of the band it is told in. */
  deadline() {
    let earliest = Infinity;
    for (const segment of this.byBand.get(this.placed) ?? []) if (segment.deadline < earliest) earliest = segment.deadline;
    return earliest;
  }
}

/** One output segment as the projection holds it. */
class Segment {
  constructor(output, index, from, to, reach = to) {
    this.output = output;
    this.index = index;
    this.from = from;
    this.to = to;
    /**
     * Up to which second the map's zones are read for it: its end, and for a
     * piece that copies a stream the second its end falls in as well, as the
     * encode plan reads it (`Timeline.inSegments`): the player asks a viewer
     * standing at its end for this piece, and its bytes are fetched for them.
     */
    this.reach = reach;
    /** Whether a zone of the map overlaps it. */
    this.demanded = false;
    /** Whether the output has it made. */
    this.ready = false;
    this.priority = 0;
    this.urgent = false;
    this.behind = true;
    this.deferred = true;
    /** The map zone its deadline is reckoned from. */
    this.owner = null;
    /** Its deadline past the time base before its making and delivery are taken off. */
    this.reached = Infinity;
    /** How long its making and delivery take, in seconds, as `sourceDeadline` reckons it. */
    this.leadSeconds = 0;
    /** Its deadline past the time base: when its source bytes are needed. */
    this.deadline = Infinity;
    /** Its band, and the band it is told in once the next run's input is raised. */
    this.band = null;
    this.told = null;
    /** Its source ranges as the torrent fetches them, once worked out. @type {Array<[number, number]> | null} */
    this.ranges = null;
    /** @type {RangeEntry[]} */
    this.entries = [];
    /** Whether it is in its ranges' entries now. */
    this.active = false;
    /** Whether the file lacks a track it reads: it has no ranges to work out. */
    this.unreadable = false;
  }
}

/** One output: its grid, how long its segments take to make and deliver, what is made, and its next input. */
class OutputState {
  constructor(outputKey, grid, runsPastEnd = false) {
    this.outputKey = outputKey;
    this.grid = grid;
    this.runsPastEnd = runsPastEnd;
    /** @type {Segment[]} */
    this.segments = [];
    for (let index = 0; index + 1 < grid.length; index++) {
      const end = grid[index + 1];
      this.segments.push(new Segment(this, index, grid[index], end,
        runsPastEnd && index + 2 < grid.length ? Math.max(end, Math.floor(end) + 1) : end));
    }
    this.encodeSpeed = undefined;
    this.bytesPerSecond = undefined;
    this.linkMbps = undefined;
    this.readyRevision = undefined;
    this.target = null;
    /** The segments told in the band of the first one, as the next run's input. @type {Set<Segment>} */
    this.raised = new Set();
    this.raisedFrom = null;
    this.raisedBand = null;
    /** Its own priority → its active segments: where the next run's input starts. @type {Map<number, Set<Segment>>} */
    this.byPriority = new Map();
  }
}

export class PlaybackProjection {
  /** @type {Map<string, OutputState>} */
  #outputs = new Map();
  /** Byte start → byte end → its entry. @type {Map<number, Map<number, RangeEntry>>} */
  #entries = new Map();
  /** Band key → its entries in byte order. @type {Map<number, RangeEntry[]>} */
  #bands = new Map();
  /** Bands whose windows must be made again. @type {Set<number>} */
  #dirty = new Set();
  /** Band key → its windows, relative deadlines. @type {Map<number, Array<{ byteStart: number, byteEnd: number, deadline: number }>>} */
  #bandWindows = new Map();
  #zones = [];
  #ordered = true;
  /** The segments wanted whose ranges are not worked out yet. @type {Set<Segment>} */
  #unresolved = new Set();
  /**
   * Outputs whose next run's input is to be raised again before the windows
   * are told: worked out once for everything a map or a pass changed, not at
   * each segment that changed — on a cold start that was once for each of
   * 4500 segments worked out (r34, torrent-tv/meta#178).
   * @type {Set<OutputState>}
   */
  #raiseAgain = new Set();
  /** The time base of the last map, or 0 for a map stated in absolute time. */
  #base = 0;
  #absolute = true;
  /** The windows last handed out, kept while nothing they show has changed. */
  #told = null;
  /** What the last update reworked, for the per-minute reading. */
  lastUpdate = { segments: 0, bands: 0, whole: false };

  /** Forget everything: the file has no viewer. */
  clear() {
    for (const output of [...this.#outputs.values()]) this.#dropOutput(output);
    this.#zones = [];
    this.#told = null;
  }

  /**
   * Bring the projection to a new map.
   *
   * @param {object} params
   * @param {Array<{ from: number, to: number, priority: number, urgent?: boolean, behind?: boolean, deferred?: boolean,
   *   deadlineAt?: number }>} params.zones - The file's map zones, deadlines as instants.
   * @param {Array<{ outputKey: string, grid: number[], runsPastEnd?: boolean, encodeSpeed?: number, bytesPerSecond?: number | null,
   *   linkMbps?: number | null, readyRevision: unknown, ready: () => Map<number, number>,
   *   target: number | null }>} params.outputs - Every output of the file somebody is watching, with
   *   what decides how long its segments take to make and deliver (`sourceDeadline`), what it has made
   *   — read again only when its revision moves — and how many bytes its next run would copy.
   * @returns {void}
   */
  update({ zones, outputs }) {
    const base = timeBaseOf(zones);
    const absolute = base === null;
    const nextBase = absolute ? 0 : base;
    // A map in absolute time moves every deadline with the clock: worked out
    // whole, as before this projection existed.
    const whole = absolute || this.#absolute;
    const stretches = whole ? null : differences(this.#zones, zones, this.#base, nextBase);
    const ordered = ascendingAndApart(zones);
    let reworked = 0;
    const seen = new Set();
    for (const info of outputs) {
      seen.add(info.outputKey);
      let output = this.#outputs.get(info.outputKey);
      if (output && (output.grid !== info.grid || output.runsPastEnd !== Boolean(info.runsPastEnd))) {
        this.#dropOutput(output);
        output = undefined;
      }
      const fresh = !output;
      if (fresh) {
        output = new OutputState(info.outputKey, info.grid, Boolean(info.runsPastEnd));
        this.#outputs.set(info.outputKey, output);
      }
      // How long a segment of it takes to make and deliver.
      const leadMoved = fresh || output.encodeSpeed !== info.encodeSpeed || output.bytesPerSecond !== info.bytesPerSecond ||
        output.linkMbps !== info.linkMbps;
      output.encodeSpeed = info.encodeSpeed;
      output.bytesPerSecond = info.bytesPerSecond;
      output.linkMbps = info.linkMbps;
      // What it has made.
      if (fresh || output.readyRevision !== info.readyRevision) {
        output.readyRevision = info.readyRevision;
        const ready = info.ready();
        for (const segment of output.segments) {
          const now = ready.has(segment.index);
          if (now !== segment.ready) {
            segment.ready = now;
            this.#activate(segment);
            this.#track(segment);
            this.#raiseAgain.add(output);
            reworked++;
          }
        }
      }
      // What the map says of each segment, where it says something new.
      if (fresh || whole) {
        for (const segment of output.segments) if (this.#demand(segment, zones, ordered, nextBase, leadMoved)) reworked++;
      } else {
        for (const { from, to } of stretches) {
          // A piece reaching past its end is read for the stretch after it too.
          for (let index = Math.max(0, segmentAt(output.grid, from) - (output.runsPastEnd ? 1 : 0));
            index < output.segments.length && output.segments[index].from < to; index++) {
            if (this.#demand(output.segments[index], zones, ordered, nextBase, false)) reworked++;
          }
        }
        if (leadMoved) for (const segment of output.segments) if (this.#reckon(segment)) reworked++;
      }
      if (fresh || output.target !== (info.target ?? null)) this.#raiseAgain.add(output);
      output.target = info.target ?? null;
    }
    for (const output of [...this.#outputs.values()]) if (!seen.has(output.outputKey)) this.#dropOutput(output);
    if (nextBase !== this.#base || absolute !== this.#absolute) this.#told = null;
    this.#zones = zones;
    this.#ordered = ordered;
    this.#base = nextBase;
    this.#absolute = absolute;
    this.lastUpdate = { segments: reworked, bands: this.#dirty.size, whole };
  }

  /**
   * A segment's source ranges, worked out: they join the bands now.
   *
   * @param {string} outputKey
   * @param {number} index
   * @param {Array<[number, number]>} ranges - Inclusive, as the torrent fetches them.
   * @returns {void}
   */
  setRanges(outputKey, index, ranges) {
    const segment = this.#outputs.get(outputKey)?.segments[index];
    if (!segment || segment.ranges === ranges) return;
    this.#deactivate(segment);
    segment.ranges = ranges;
    segment.entries = [];
    const named = new Set();
    for (const [start, end] of ranges) {
      // A range a segment names twice is one range.
      const key = `${start}:${end}`;
      if (named.has(key)) continue;
      named.add(key);
      let byEnd = this.#entries.get(start);
      if (!byEnd) this.#entries.set(start, byEnd = new Map());
      let entry = byEnd.get(end);
      if (!entry) byEnd.set(end, entry = new RangeEntry(start, end));
      segment.entries.push(entry);
    }
    this.#activate(segment);
    this.#track(segment);
    this.#raiseAgain.add(segment.output);
  }

  /**
   * A segment that reads a track the file does not have: nothing to work out,
   * and nothing told for it.
   *
   * @param {string} outputKey
   * @param {number} index
   * @returns {void}
   */
  setUnreadable(outputKey, index) {
    const segment = this.#outputs.get(outputKey)?.segments[index];
    if (!segment) return;
    segment.unreadable = true;
    this.#track(segment);
  }

  /**
   * The demands whose ranges are not worked out yet, in the order the swarm is
   * to fetch them: by deadline, then the higher priority, then the segment.
   *
   * @returns {Array<{ outputKey: string, index: number, from: number, to: number, priority: number, urgent: boolean,
   *   behind: boolean, deferred: boolean, deadlineAt: number, leadSeconds: number, owner: object }>}
   */
  unresolved() {
    const waiting = [];
    for (const segment of this.#unresolved) {
      waiting.push({ outputKey: segment.output.outputKey, index: segment.index, from: segment.from, to: segment.to,
        priority: segment.priority, urgent: segment.urgent, behind: segment.behind, deferred: segment.deferred,
        deadlineAt: this.#base + segment.deadline, leadSeconds: segment.leadSeconds, owner: this.#ownerOf(segment) });
    }
    return waiting.sort((left, right) => left.deadlineAt - right.deadlineAt || right.priority - left.priority || left.index - right.index);
  }

  /**
   * What the torrent is told: each band's windows, the bands in the order they
   * are fetched, a window's deadline the earliest of the ranges it holds.
   * The same array while nothing in it has changed.
   *
   * @returns {Array<{ byteStart: number, byteEnd: number, priority: number, urgent: boolean, behind: boolean,
   *   deferred: boolean, deadlineAt?: number, standing: true }>}
   */
  windows() {
    for (const output of this.#raiseAgain) if (this.#outputs.get(output.outputKey) === output) this.#raise(output);
    this.#raiseAgain.clear();
    if (this.#told && this.#dirty.size === 0) return this.#told;
    for (const key of this.#dirty) this.#makeWindows(key);
    this.#dirty.clear();
    const keys = [...this.#bandWindows.keys()].sort((left, right) => before(left, right) ? -1 : before(right, left) ? 1 : 0);
    const told = [];
    for (const key of keys) {
      const level = Math.floor(key / 1000), priority = key % 1000;
      for (const window of this.#bandWindows.get(key)) {
        told.push({ byteStart: window.byteStart, byteEnd: window.byteEnd, priority, urgent: level === Urgency.NEAR,
          behind: level === Urgency.BEHIND, deferred: level === Urgency.TAIL,
          ...(Number.isFinite(window.deadline) ? { deadlineAt: this.#base + window.deadline } : {}),
          // Kept current by this projection: a new map does not withdraw or
          // reprice it in the meantime (`DownloadMaps.playback`).
          standing: true });
      }
    }
    this.#told = told;
    return told;
  }

  /** The demand of one segment, read off the map again; whether anything about it changed. */
  #demand(segment, zones, ordered, base, leadMoved) {
    // The zones it overlaps, folded as they are met.
    let owner = null, ownerDeadline = Infinity, priority = 0, urgent = false, behind = true, deferred = true;
    const { from, reach: to } = segment;
    for (let at = ordered ? firstEndingAfter(zones, from) : 0; at < zones.length; at += 1) {
      const zone = zones[at];
      if (ordered && !(zone.from < to)) break;
      if (!(zone.priority > 0) || !(zone.from < to && zone.to > from)) continue;
      const deadline = Number.isFinite(zone.deadlineAt) ? zone.deadlineAt - base + Math.max(0, from - zone.from) * 1000 : Infinity;
      if (owner === null || deadline < ownerDeadline) { owner = zone; ownerDeadline = deadline; }
      if (zone.priority > priority) priority = zone.priority;
      if (zone.urgent) urgent = true;
      if (!zone.behind) behind = false;
      if (!zone.deferred) deferred = false;
    }
    const demanded = owner !== null;
    const band = demanded ? bandKeyOf(levelOf(behind, deferred, urgent), clampPriority(priority)) : null;
    const changed = demanded !== segment.demanded || band !== segment.band || ownerDeadline !== segment.reached ||
      priority !== segment.priority || urgent !== segment.urgent || behind !== segment.behind || deferred !== segment.deferred;
    segment.owner = owner;
    if (!changed && !leadMoved) return false;
    this.#deactivate(segment);
    segment.demanded = demanded;
    segment.priority = priority;
    segment.urgent = urgent;
    segment.behind = behind;
    segment.deferred = deferred;
    segment.band = band;
    segment.reached = ownerDeadline;
    this.#lead(segment);
    this.#activate(segment);
    this.#track(segment);
    this.#raiseAgain.add(segment.output);
    return true;
  }

  /** Whether a segment waits for its ranges to be worked out. */
  #track(segment) {
    if (segment.demanded && !segment.ready && segment.ranges === null && !segment.unreadable) this.#unresolved.add(segment);
    else this.#unresolved.delete(segment);
  }

  /**
   * The zone of the current map a segment's deadline is reckoned from. A
   * segment the new map says nothing new of keeps its demand, and the zone it
   * names is looked up only for one still to be worked out, whose read is
   * asked for under it.
   */
  #ownerOf(segment) {
    const zones = this.#zones;
    let owner = null, ownerDeadline = Infinity;
    for (let at = this.#ordered ? firstEndingAfter(zones, segment.from) : 0; at < zones.length; at += 1) {
      const zone = zones[at];
      if (this.#ordered && !(zone.from < segment.reach)) break;
      if (!(zone.priority > 0) || !(zone.from < segment.reach && zone.to > segment.from)) continue;
      const deadline = Number.isFinite(zone.deadlineAt) ? zone.deadlineAt + Math.max(0, segment.from - zone.from) * 1000 : Infinity;
      if (owner === null || deadline < ownerDeadline) { owner = zone; ownerDeadline = deadline; }
    }
    return owner;
  }

  /** How long one segment takes to make and deliver moved: its deadline again. */
  #reckon(segment) {
    if (!segment.demanded) return false;
    const was = segment.deadline;
    const active = segment.active;
    this.#lead(segment);
    if (segment.deadline === was) return false;
    if (active) for (const entry of segment.entries) if (entry.placed === segment.told) this.#dirty.add(entry.placed);
    return true;
  }

  /**
   * Its making and delivery taken off its deadline, as `sourceDeadline` does
   * on the instant: the reckoning is done on the relative deadline, so it does
   * not move with the time base.
   */
  #lead(segment) {
    const { output } = segment;
    const span = segment.to - segment.from;
    const processing = Number.isFinite(output.encodeSpeed) && output.encodeSpeed > 0 ? span / output.encodeSpeed : 0;
    const outputBytes = Number.isFinite(output.bytesPerSecond) && output.bytesPerSecond > 0 ? output.bytesPerSecond * span : null;
    const delivery = Number.isFinite(outputBytes) && outputBytes > 0 && Number.isFinite(output.linkMbps) && output.linkMbps > 0
      ? outputBytes * 8 / (output.linkMbps * 1_000_000) : 0;
    if (Number.isFinite(segment.reached)) {
      segment.deadline = segment.reached - (processing + delivery) * 1000;
      segment.leadSeconds = Math.max(0, (segment.reached - segment.deadline) / 1000);
    } else {
      segment.deadline = segment.reached;
      segment.leadSeconds = 0;
    }
  }

  /** The band a segment is told in: its own, or the first one's while it is the next run's input. */
  #toldBand(segment) {
    const first = segment.output.raisedFrom;
    return first && segment.output.raised.has(segment) ? first.band : segment.band;
  }

  /** Put an active segment into the entries of its ranges. */
  #activate(segment) {
    const active = segment.demanded && !segment.ready && segment.ranges !== null;
    if (!active) {
      this.#deactivate(segment);
      return;
    }
    if (segment.active) this.#deactivate(segment);
    segment.active = true;
    let same = segment.output.byPriority.get(segment.priority);
    if (!same) segment.output.byPriority.set(segment.priority, same = new Set());
    same.add(segment);
    segment.told = this.#toldBand(segment);
    for (const entry of segment.entries) {
      let named = entry.byBand.get(segment.told);
      if (!named) entry.byBand.set(segment.told, named = new Set());
      named.add(segment);
      this.#place(entry);
      if (entry.placed === segment.told) this.#dirty.add(entry.placed);
    }
  }

  /** Take a segment out of the entries of its ranges. */
  #deactivate(segment) {
    if (!segment.active) return;
    segment.active = false;
    const same = segment.output.byPriority.get(segment.priority);
    same?.delete(segment);
    if (same && same.size === 0) segment.output.byPriority.delete(segment.priority);
    for (const entry of segment.entries) {
      const named = entry.byBand.get(segment.told);
      named?.delete(segment);
      if (named && named.size === 0) entry.byBand.delete(segment.told);
      if (entry.placed === segment.told) this.#dirty.add(segment.told);
      this.#place(entry);
    }
    segment.told = null;
  }

  /** Tell an entry in its best band, moving it there if that changed. */
  #place(entry) {
    const best = entry.best();
    if (best === entry.placed) return;
    if (entry.placed !== null) {
      const list = this.#bands.get(entry.placed);
      let at = lowerBound(list, entry.start);
      while (at < list.length && list[at] !== entry) at++;
      if (at < list.length) list.splice(at, 1);
      if (list.length === 0) {
        this.#bands.delete(entry.placed);
        this.#bandWindows.delete(entry.placed);
      } else this.#dirty.add(entry.placed);
    }
    entry.placed = best;
    if (best === null) return;
    let list = this.#bands.get(best);
    if (!list) this.#bands.set(best, list = []);
    let at = lowerBound(list, entry.start);
    while (at < list.length && list[at].start === entry.start) at++;
    list.splice(at, 0, entry);
    this.#dirty.add(best);
  }

  /** The windows of one band: its ranges that touch or overlap joined, each at its earliest deadline. */
  #makeWindows(key) {
    const list = this.#bands.get(key);
    if (!list || list.length === 0) {
      this.#bandWindows.delete(key);
      return;
    }
    const windows = [];
    let open = null;
    for (const entry of list) {
      const deadline = entry.deadline();
      if (open && entry.start <= open.byteEnd + 1) {
        open.byteEnd = Math.max(open.byteEnd, entry.end);
        open.deadline = Math.min(open.deadline, deadline);
      } else {
        open = { byteStart: entry.start, byteEnd: entry.end, deadline };
        windows.push(open);
      }
    }
    this.#bandWindows.set(key, windows);
  }

  /**
   * The next run's input raised to its first segment's place
   * — the swarm told it as one group with its first segment, since WebTorrent
   * keeps no order between several selections: the first segment is the output's highest
   * priority, then lowest index, among the segments whose ranges are known,
   * and the segments after it are raised one by one while the bytes held stay
   * within what the run would copy, up to the first that is made or not yet
   * worked out.
   */
  #raise(output) {
    let first = null;
    let top = -Infinity;
    for (const priority of output.byPriority.keys()) if (priority > top) top = priority;
    for (const segment of output.byPriority.get(top) ?? []) if (!first || segment.index < first.index) first = segment;
    const next = new Set();
    if (first && output.target > 0) {
      const holding = new HeldBytes();
      holding.add(first.ranges);
      for (let index = first.index + 1; index < output.segments.length; index++) {
        const segment = output.segments[index];
        if (!segment.active) break;
        if (holding.total + holding.adds(segment.ranges) > output.target) break;
        holding.add(segment.ranges);
        next.add(segment);
      }
    }
    const firstMoved = output.raisedFrom !== first || (first && output.raisedBand !== first.band);
    const changed = new Set();
    for (const segment of output.raised) if (!next.has(segment) || firstMoved) changed.add(segment);
    for (const segment of next) if (!output.raised.has(segment) || firstMoved) changed.add(segment);
    output.raised = next;
    output.raisedFrom = first;
    output.raisedBand = first?.band ?? null;
    for (const segment of changed) if (segment.active) this.#activate(segment);
  }

  #dropOutput(output) {
    for (const segment of output.segments) {
      this.#deactivate(segment);
      this.#unresolved.delete(segment);
    }
    this.#outputs.delete(output.outputKey);
    this.#raiseAgain.delete(output);
    this.#told = null;
  }
}
