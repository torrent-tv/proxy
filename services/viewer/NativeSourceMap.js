import { mapForViewer, mergeMaps, runsOf } from "./PriorityMap.js";

/** Price original-file cluster ranges without requiring a packet index. */
export async function nativeOriginalSourceMap({ container, viewers, durationSeconds, startTimeSeconds = 0,
  allowanceSeconds, urgentReadyFor, now = Date.now() }) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
  const maps = viewers.map(viewer => mapForViewer({
    atSeconds: viewer.positionSeconds(now) ?? 0, durationSeconds, allowanceSeconds,
    playing: viewer.playing || viewer.waiting, viewerCount: viewers.length,
    pauseSeconds: viewer.pausedAt === null ? 0 : (now - viewer.pausedAt) / 1000,
    urgentReady: urgentReadyFor(viewer)
  }));
  const zones = [];
  for (const zone of runsOf(mergeMaps(maps))) {
    const input = await container.readMappedSourceRanges({ from: zone.from + startTimeSeconds,
      to: Math.min(durationSeconds, zone.to) + startTimeSeconds });
    if (input.kind !== "result") continue;
    const links = viewers.filter((_viewer, index) => maps[index].priority[zone.from] === zone.priority)
      .map(viewer => viewer.linkReading()?.linkMbps).filter(rate => Number.isFinite(rate) && rate > 0);
    const bytes = input.ranges.reduce((sum, [start, end]) => sum + end - start + 1, 0);
    const deliverySeconds = links.length ? bytes * 8 / (Math.min(...links) * 1_000_000) : 0;
    for (const [byteStart, byteEnd] of input.ranges) zones.push({ ...zone, byteStart, byteEnd,
      deadlineAt: Number.isFinite(zone.withinSeconds) ? now + (zone.withinSeconds - deliverySeconds) * 1000 : Infinity });
  }
  return zones;
}

/** Price native source packets with the same viewer map as encoded outputs. */
export function nativeSourceMap({ index, tracks, viewers, durationSeconds, startTimeSeconds = 0,
  allowanceSeconds, urgentReadyFor, now = Date.now() }) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
  const maps = viewers.map(viewer => mapForViewer({
    atSeconds: viewer.positionSeconds(now) ?? 0, durationSeconds, allowanceSeconds,
    playing: viewer.playing || viewer.waiting, viewerCount: viewers.length,
    pauseSeconds: viewer.pausedAt === null ? 0 : (now - viewer.pausedAt) / 1000,
    urgentReady: urgentReadyFor(viewer)
  }));
  const zones = [];
  for (const zone of runsOf(mergeMaps(maps))) {
    for (const track of tracks.filter(track => ["video", "audio"].includes(track.type))) {
      const bounds = index.boundsOf(track.trackNumber);
      if (!bounds) continue;
      const from = Math.max(bounds.start, zone.from + startTimeSeconds);
      const to = Math.min(bounds.end, durationSeconds + startTimeSeconds, zone.to + startTimeSeconds);
      if (!(to > from)) continue;
      const input = index.inputFor({ trackId: track.trackNumber, from, to });
      if (input.kind === "needs-index") continue;
      if (input.kind !== "result") throw new Error(`Native source input refused: ${input.reason}`);
      const links = viewers.filter((_viewer, viewerIndex) => maps[viewerIndex].priority[zone.from] === zone.priority)
        .map(viewer => viewer.linkReading()?.linkMbps).filter(rate => Number.isFinite(rate) && rate > 0);
      const bytes = input.ranges.reduce((sum, [start, end]) => sum + end - start + 1, 0);
      const deliverySeconds = links.length ? bytes * 8 / (Math.min(...links) * 1_000_000) : 0;
      for (const [byteStart, byteEnd] of input.ranges) zones.push({ ...zone, byteStart, byteEnd,
        deadlineAt: Number.isFinite(zone.withinSeconds) ? now + (zone.withinSeconds - deliverySeconds) * 1000 : Infinity });
    }
  }
  return zones;
}
