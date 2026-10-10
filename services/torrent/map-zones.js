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
  const bandOf = zone => ({ urgency: levelOfMapZone(zone), priority: priorityOfMapZone(zone), deadlineAt: deadlineOfMapZone(zone, now) });
  const best = new Map();
  zones.forEach((zone, index) => {
    const key = `${zone.byteStart}:${zone.byteEnd}`;
    const kept = best.get(key);
    if (!kept || compareBands(bandOf(zone), kept.band) < 0) best.set(key, { index, band: bandOf(zone) });
  });
  return zones.filter((zone, index) => best.get(`${zone.byteStart}:${zone.byteEnd}`).index === index);
}
