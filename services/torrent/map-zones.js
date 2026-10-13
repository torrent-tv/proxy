/**
 * @file What one zone of the priority map tells the torrent: the level of
 * urgency it is stated at, and the band the swarm ranks it by.
 *
 * Pure arithmetic over the zone's own fields, so the main thread can ask the
 * same question before a map is sent and the torrent thread when it is applied.
 */
import { isAtAWatchingViewer, isBehindEverybody, isNobodyComingNow } from "../viewer/PriorityMap.js";
import { Urgency } from "./demand/Urgency.js";
import { compareBands } from "./download/bands.js";

/**
 * Which level of urgency one zone is stated at, from the map's own number
 * and nothing else. The map's numbers are a scale as long as the film needs
 * — ten bands on a fifty-minute film — while the register has five levels,
 * and the fit is by meaning:
 *
 *  - the top of the scale is where a viewer is standing, so it is the
 *    cushion being built: {@link Urgency.NEAR}. Never BLOCKED — that level
 *    means a reader is stopped on those bytes right now, which only a read
 *    can say;
 *  - the bottom is what nobody is approaching: behind a viewer moving
 *    forward, and the whole film of a viewer who has stopped the picture.
 *    Wanted only if somebody seeks back, which is {@link Urgency.BEHIND};
 *  - one above the bottom is the far tail — wanted for certain if the
 *    viewer watches on, and not before: {@link Urgency.TAIL};
 *  - everything between is the lead being built: {@link Urgency.AHEAD}.
 *
 * Read from the scale's own ends rather than from the highest and lowest
 * number in THIS file's map. The two speculative levels are withheld across
 * every torrent at once while anything urgent is missing anywhere, so a
 * paused viewer's film has to compare as wanted-last against another film
 * somebody is watching — and relative to itself alone it would compare as
 * the most urgent thing there is.
 *
 * @param {{ priority?: number, behind?: boolean, deferred?: boolean, urgent?: boolean }} zone
 * @returns {number}
 */
export function levelOfMapZone(zone) {
  // Read through the map's own words rather than by comparing its numbers.
  // The scale is that layer's, and the numbers inside a band mean nothing
  // but their order.
  const priority = zone.priority ?? 0;
  if (zone.behind === true || (zone.behind === undefined && isBehindEverybody(priority))) {
    return Urgency.BEHIND;
  }
  if (zone.deferred === true || (zone.deferred === undefined && isNobodyComingNow(priority))) {
    // In front of somebody who has stopped the picture, and of nobody who is
    // watching. Wanted, and wanted after everyone who is on their way.
    return Urgency.TAIL;
  }
  return (zone.urgent === true || (zone.urgent === undefined && isAtAWatchingViewer(priority))) ? Urgency.NEAR : Urgency.AHEAD;
}

/** The priority a zone is stated at, within the register's scale. */
export function priorityOfMapZone(zone) {
  return Number.isFinite(zone.priority) ? Math.max(1, Math.min(100, zone.priority)) : 1;
}

/** When a zone's bytes are needed, as an instant; `now` reads `withinSeconds`. */
export function deadlineOfMapZone(zone, now = Date.now()) {
  return Number.isFinite(zone.deadlineAt) ? zone.deadlineAt :
    Number.isFinite(zone.withinSeconds) ? now + Math.max(0, zone.withinSeconds) * 1000 : Number.POSITIVE_INFINITY;
}

/**
 * The byte ranges a zone names: a segment's zone names all the ranges its
 * segment reads, and states its demand once for them (`ranges`); any other
 * zone names one (`byteStart`-`byteEnd`). Inclusive.
 *
 * @param {{ ranges?: Array<[number, number]>, byteStart?: number, byteEnd?: number }} zone
 * @returns {Array<[number, number]>}
 */
export function rangesOfZone(zone) {
  return Array.isArray(zone.ranges) ? zone.ranges : [[zone.byteStart, zone.byteEnd]];
}

/**
 * The zones with every repeat of the same bytes left out but the one the swarm
 * would rank first.
 *
 * Each piece is fetched in the band of the best zone that holds it
 * ({@link compareBands}), so a zone naming exactly the bytes of a better one
 * changes nothing the swarm is told. The ranges an AVI's picture reads at open
 * — its declarations and its indexes — are named again in the zone of every
 * segment: field 2026-10-10 (torrent-tv/meta#166), maps of 9700 zones, for a
 * film of 2035 segments, cost half a second each to deliver.
 *
 * @template {{ byteStart: number, byteEnd: number }} Zone
 * @param {Zone[]} zones
 * @param {number} [now]
 * @returns {Zone[]} In their order, without the repeats.
 */
export function withoutRepeatedZones(zones, now = Date.now()) {
  const bands = zones.map(zone => bandOf(zone, now));
  const best = bestOfRepeats(zones.length, index => zones[index].byteStart, index => zones[index].byteEnd, index => bands[index]);
  return zones.filter((_zone, index) => best.get(zones[index].byteStart).get(zones[index].byteEnd) === index);
}

/**
 * What the torrent is told, as few windows as say the same thing: every stretch
 * of bytes once, in the best band that names it, and the stretches of one
 * level and priority that touch or overlap joined into one window, wanted by
 * the earliest deadline among them.
 *
 * A map names every range of every segment — three of an AVI's segment, two of
 * them the header and index all its segments read — and a film is thousands of
 * segments: 10 000 zones, built, compared, copied to the torrent thread and
 * stated there every three seconds a viewer plays on, about 70 s of the main
 * thread in ten minutes on Home Assistant (torrent-tv/meta#178). The swarm acts
 * on the band of a piece and nothing else, and within one band the pieces of
 * consecutive segments are consecutive bytes. A zone a metadata read states
 * keeps its own request and order, and is left as it is.
 *
 * A segment's zone states its demand once for all its ranges
 * ({@link rangesOfZone}); each range is a part of its own here, so a repeat is
 * found range by range, and the band and deadline every range is packed with
 * are the zone's current ones.
 *
 * @param {Array<{ byteStart?: number, byteEnd?: number, ranges?: Array<[number, number]> }>} zones
 * @param {number} [now]
 * @returns {object[]}
 */
export function coalescedZones(zones, now = Date.now()) {
  // Every range of every zone is a part, kept in numbers rather than objects:
  // a film's map is ten thousand of them (r26, torrent-tv/meta#178).
  let count = 0;
  for (const zone of zones) count += Array.isArray(zone.ranges) ? zone.ranges.length : 1;
  const starts = new Float64Array(count);
  const ends = new Float64Array(count);
  const owners = new Int32Array(count);
  const bands = zones.map(zone => bandOf(zone, now));
  let at = 0;
  zones.forEach((zone, index) => {
    for (const [start, end] of rangesOfZone(zone)) {
      starts[at] = start;
      ends[at] = end;
      owners[at] = index;
      at += 1;
    }
  });
  const best = bestOfRepeats(count, part => starts[part], part => ends[part], part => bands[owners[part]]);
  const kept = [];
  /** Band key → the band and its parts, in the order the bands first appear. */
  const groups = new Map();
  for (let part = 0; part < count; part++) {
    if (best.get(starts[part]).get(ends[part]) !== part) continue;
    const zone = zones[owners[part]];
    if (zone.requestId !== undefined || zone.downloadOnly || (Number.isSafeInteger(zone.order) && zone.order > 0)) {
      kept.push(zone);
      continue;
    }
    const band = bands[owners[part]];
    const key = band.urgency * 1000 + band.priority;
    let group = groups.get(key);
    if (!group) groups.set(key, group = { band, parts: [] });
    group.parts.push(part);
  }
  for (const { band: { urgency, priority }, parts } of groups.values()) {
    parts.sort((left, right) => starts[left] - starts[right]);
    let windowStart = 0;
    let windowEnd = -1;
    let windowDeadline = Number.POSITIVE_INFINITY;
    let open = false;
    const close = () => {
      if (!open) return;
      kept.push({ byteStart: windowStart, byteEnd: windowEnd, priority, urgent: urgency === Urgency.NEAR,
        behind: urgency === Urgency.BEHIND, deferred: urgency === Urgency.TAIL,
        ...(Number.isFinite(windowDeadline) ? { deadlineAt: windowDeadline } : {}) });
    };
    for (const part of parts) {
      const deadlineAt = bands[owners[part]].deadlineAt;
      if (open && starts[part] <= windowEnd + 1) {
        windowEnd = Math.max(windowEnd, ends[part]);
        windowDeadline = Math.min(windowDeadline, deadlineAt);
      } else {
        close();
        open = true;
        windowStart = starts[part];
        windowEnd = ends[part];
        windowDeadline = deadlineAt;
      }
    }
    close();
  }
  return kept;
}

/** The band a zone's bytes are fetched in. */
function bandOf(zone, now) {
  return { urgency: levelOfMapZone(zone), priority: priorityOfMapZone(zone), deadlineAt: deadlineOfMapZone(zone, now) };
}

/**
 * Which of the parts naming each exact byte range is the best: by band
 * ({@link compareBands}), the first of equals. Kept by the range's two numbers
 * rather than a string made of them: making a key of each of a film's ten
 * thousand ranges was most of what packing its map cost (r26,
 * torrent-tv/meta#178).
 *
 * @returns {Map<number, Map<number, number>>} start → end → the best part.
 */
function bestOfRepeats(count, startOf, endOf, bandOfPart) {
  const best = new Map();
  for (let part = 0; part < count; part++) {
    const start = startOf(part);
    const end = endOf(part);
    let byEnd = best.get(start);
    if (!byEnd) best.set(start, byEnd = new Map());
    const kept = byEnd.get(end);
    if (kept === undefined || compareBands(bandOfPart(part), bandOfPart(kept)) < 0) byEnd.set(end, part);
  }
  return best;
}
