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
  for (let index = 0; index + 1 < grid.length; index++) {
    const from = grid[index], to = grid[index + 1];
    if (!Number.isFinite(from) || !Number.isFinite(to) || !(to > from)) throw new Error("An output segment needs a valid interval.");
    const overlapping = zones.filter(zone => zone.priority > 0 && zone.from < to && zone.to > from);
    if (!overlapping.length) continue;
    // A zone states the deadline of its near edge. A later segment within it
    // is reached later, at one second of film per second of playback.
    const deadlineOf = zone => Number.isFinite(zone.deadlineAt)
      ? zone.deadlineAt + Math.max(0, from - zone.from) * 1000 : Infinity;
    const owner = overlapping.reduce((first, zone) => deadlineOf(zone) < deadlineOf(first) ? zone : first);
    demands.push({ index, from, to, tracks, owner,
      priority: Math.max(...overlapping.map(zone => zone.priority)),
      urgent: overlapping.some(zone => zone.urgent),
      behind: overlapping.every(zone => zone.behind),
      deferred: overlapping.every(zone => zone.deferred),
      deadlineAt: Math.min(...overlapping.map(deadlineOf)) });
  }
  return demands.sort((left, right) => left.deadlineAt - right.deadlineAt || right.priority - left.priority || left.index - right.index);
}

/** Source bytes must arrive before measured processing and delivery consume time. */
export function sourceDeadline(demand, { encodeSpeed, outputBytes, linkMbps }) {
  const span = demand.to - demand.from;
  const processing = Number.isFinite(encodeSpeed) && encodeSpeed > 0 ? span / encodeSpeed : 0;
  const delivery = Number.isFinite(outputBytes) && outputBytes > 0 && Number.isFinite(linkMbps) && linkMbps > 0
    ? outputBytes * 8 / (linkMbps * 1_000_000) : 0;
  return Number.isFinite(demand.deadlineAt) ? demand.deadlineAt - (processing + delivery) * 1000 : demand.deadlineAt;
}
