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
    const from = grid[index], to = grid[index + 1];
    if (!Number.isFinite(from) || !Number.isFinite(to) || !(to > from)) throw new Error("An output segment needs a valid interval.");
    if (ordered) while (first < zones.length && zones[first].to <= from) first += 1;
    // The zones a segment overlaps are folded as they are met, into numbers:
    // a list of them, and the lists made of it for each field, were five
    // arrays for every segment of a film on every pass (r30,
    // torrent-tv/meta#178).
    let owner = null, ownerDeadline = Infinity, priority = 0, urgent = false, behind = true, deferred = true;
    for (let at = ordered ? first : 0; at < zones.length; at += 1) {
      const zone = zones[at];
      if (ordered && !(zone.from < to)) break;
      if (!(zone.priority > 0) || !(zone.from < to && zone.to > from)) continue;
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
