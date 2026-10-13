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
 * Bytes covered by a list of inclusive ranges, each byte counted once: the
 * declarations and indexes every segment of an original file names are held
 * once by the run that reads them.
 *
 * @param {Array<[number, number]>} ranges
 * @returns {number}
 */
function coveredBytes(ranges) {
  let total = 0;
  let end = -1;
  for (const [start, last] of [...ranges].sort((left, right) => left[0] - right[0])) {
    if (last <= end) continue;
    total += last - Math.max(start, end + 1) + 1;
    end = last;
  }
  return total;
}

/**
 * The map's byte zones with each output's next run input raised to its first
 * segment's place.
 *
 * @template {{ outputKey: string, index: number, priority: number, urgent?: boolean, behind?: boolean, deferred?: boolean, byteStart: number, byteEnd: number }} Zone
 * @param {Zone[]} zones - One or more per segment, as the map's pass made them.
 * @param {(outputKey: string) => number | null} targetBytesOf - What the
 *   output's next run would be given to copy; nothing is raised without it.
 * @returns {Zone[]} In their order; raised zones are copies.
 */
export function expandToTargetInputs(zones, targetBytesOf) {
  /** @type {Map<string, Map<number, Zone[]>>} */
  const byOutput = new Map();
  for (const zone of zones) {
    let segments = byOutput.get(zone.outputKey);
    if (!segments) byOutput.set(zone.outputKey, segments = new Map());
    const list = segments.get(zone.index);
    if (list) list.push(zone);
    else segments.set(zone.index, [zone]);
  }
  /** @type {Map<Zone, Zone>} */
  const raised = new Map();
  for (const [outputKey, segments] of byOutput) {
    const target = targetBytesOf(outputKey);
    if (!(target > 0)) continue;
    let first = null;
    for (const [index, list] of segments) {
      const priority = Math.max(...list.map(zone => zone.priority));
      if (first === null || priority > first.priority || (priority === first.priority && index < first.index)) {
        first = { index, priority, zone: list.find(zone => zone.priority === priority) };
      }
    }
    if (first === null) continue;
    const held = segments.get(first.index).map(zone => [zone.byteStart, zone.byteEnd]);
    // The run's input is a stretch of consecutive segments: one already made,
    // or not yet worked out, ends it.
    for (let index = first.index + 1; segments.has(index); index++) {
      const list = segments.get(index);
      const ranges = [...held, ...list.map(zone => [zone.byteStart, zone.byteEnd])];
      if (coveredBytes(ranges) > target) break;
      held.push(...list.map(zone => [zone.byteStart, zone.byteEnd]));
      for (const zone of list) {
        raised.set(zone, { ...zone, priority: first.priority, urgent: first.zone.urgent,
          behind: first.zone.behind, deferred: first.zone.deferred });
      }
    }
  }
  return raised.size === 0 ? zones : zones.map(zone => raised.get(zone) ?? zone);
}
