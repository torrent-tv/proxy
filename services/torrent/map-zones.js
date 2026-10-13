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
  const keys = zones.map(zone => `${zone.byteStart}:${zone.byteEnd}`);
  const best = new Map();
  zones.forEach((zone, index) => {
    const kept = best.get(keys[index]);
    const band = { urgency: levelOfMapZone(zone), priority: priorityOfMapZone(zone), deadlineAt: deadlineOfMapZone(zone, now) };
    if (!kept || compareBands(band, kept.band) < 0) best.set(keys[index], { index, band });
  });
  return zones.filter((_zone, index) => best.get(keys[index]).index === index);
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
 * @template {{ byteStart: number, byteEnd: number }} Zone
 * @param {Zone[]} zones
 * @param {number} [now]
 * @returns {object[]}
 */
export function coalescedZones(zones, now = Date.now()) {
  const kept = [];
  const groups = new Map();
  for (const zone of withoutRepeatedZones(zones, now)) {
    if (zone.requestId !== undefined || zone.downloadOnly || (Number.isSafeInteger(zone.order) && zone.order > 0)) {
      kept.push(zone);
      continue;
    }
    const urgency = levelOfMapZone(zone);
    const priority = priorityOfMapZone(zone);
    const key = `${urgency}:${priority}`;
    let group = groups.get(key);
    if (!group) groups.set(key, group = { urgency, priority, parts: [] });
    group.parts.push({ start: zone.byteStart, end: zone.byteEnd, deadlineAt: deadlineOfMapZone(zone, now) });
  }
  for (const { urgency, priority, parts } of groups.values()) {
    parts.sort((left, right) => left.start - right.start);
    let window = null;
    const close = () => {
      if (!window) return;
      kept.push({ byteStart: window.start, byteEnd: window.end, priority, urgent: urgency === Urgency.NEAR,
        behind: urgency === Urgency.BEHIND, deferred: urgency === Urgency.TAIL,
        ...(Number.isFinite(window.deadlineAt) ? { deadlineAt: window.deadlineAt } : {}) });
    };
    for (const part of parts) {
      if (window && part.start <= window.end + 1) {
        window.end = Math.max(window.end, part.end);
        window.deadlineAt = Math.min(window.deadlineAt, part.deadlineAt);
      } else {
        close();
        window = { ...part };
      }
    }
    close();
  }
  return kept;
}
