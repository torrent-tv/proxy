// TEMPORARY (torrent-tv/meta#273): remove with playback-resolution-equivalence.test.js
// in the commit after #273 is merged.
//
// The download map's `resolvePlayback`, copied verbatim from `server.js` at
// origin/main c7102db (the closure and the state around it, lines 529-866), so
// that the class that replaces it can be run beside it. Only the free variables
// of the `startProxyServer` closure are parameters.
import { performance } from "node:perf_hooks";
import { takeTurns } from "../../../utils/take-turns.js";
import { joinedWithinPieces } from "../../../services/torrent/demand/pieces.js";
import { PlaybackProjection } from "../../../services/torrent/PlaybackProjection.js";
import { trackChoicesOf } from "../../../services/viewer/segment-demands.js";
import { segmentReading } from "../../../services/media/segment-reading.js";

export function resolvePlaybackBefore270({ mediaParams, sourceRanges, outputParts, torrentPool, waitTrace, segmentInputs, downloadMaps, logger }) {
  /**
   * WHAT ONE SEGMENT OF AN OUTPUT IS, kept from pass to pass: where it lies in
   * the source, what it reads — its tracks and the key its bytes are kept under
   * — and, once known, those bytes joined at the precision the torrent fetches,
   * by output and segment. Worked out again only when the output's timeline,
   * the tracks, the file's start time or the output's choices change; forgotten
   * with the source. None of it depends on where a viewer stands, and a pass is
   * made every time one moves: looked up, made and joined again for each of a
   * film's 3500 segments on every pass, they were 6 s of the 40 s the passes
   * cost the main thread in fifteen minutes on Home Assistant (r30,
   * torrent-tv/meta#178).
   */
  const segmentReadings = new Map();
  /** One output's segments, by index. */
  const segmentRecordsOf = (map, output) => {
    const key = `${map.sourceKey}:${map.fileIndex}:${output.outputKey}`;
    let records = segmentReadings.get(key);
    if (!records) segmentReadings.set(key, records = new Map());
    return records;
  };
  /** The choices of one output's tracks as a key, worked out once for the list of them a pass shares. */
  const choicesKeys = new WeakMap();
  const choicesKeyOf = (choices) => {
    let key = choicesKeys.get(choices);
    if (key === undefined) choicesKeys.set(choices, key = choices.map(choice => `${choice.type}/${choice.index}/${choice.mode}`).join(","));
    return key;
  };
  const segmentRecordOf = (records, demand, { timeline, trackList, shift, map }) => {
    const choicesKey = choicesKeyOf(demand.tracks);
    const kept = records.get(demand.index);
    if (kept && kept.timeline === timeline && kept.trackList === trackList && kept.shift === shift && kept.choicesKey === choicesKey) return kept;
    const sourceInterval = timeline.sourceInterval(demand.index, demand.index, shift);
    const found = segmentReading(trackList, demand.tracks, sourceInterval);
    const reading = found && { ...found, rangesKey: `${map.sourceKey}:${map.fileIndex}:${JSON.stringify(found.interval)}` };
    // `joined` is the segment's ranges as the torrent is told them, made from
    // the list `ranges` at `pieceLength`; `registered` is the list the input
    // table was last given.
    const record = { timeline, trackList, shift, choicesKey, sourceInterval, reading,
      ranges: null, pieceLength: Number.NaN, joined: null, registered: null };
    records.set(demand.index, record);
    return record;
  };
  /** What the torrent is told of each played file, kept from map to map (`PlaybackProjection`); forgotten with the source. */
  const playbackProjections = new Map();
  /** An output's cut grid, checked once for each timeline. */
  const checkedGrids = new WeakMap();
  const gridOf = (output) => {
    const timeline = output.timeline;
    if (!timeline || typeof timeline !== "object") return null;
    if (checkedGrids.has(timeline)) return checkedGrids.get(timeline);
    const grid = timeline.published ?? timeline.boundaries;
    if (!Array.isArray(grid)) {
      checkedGrids.set(timeline, null);
      return null;
    }
    for (let index = 0; index + 1 < grid.length; index++) {
      if (!Number.isFinite(grid[index]) || !Number.isFinite(grid[index + 1]) || !(grid[index + 1] > grid[index])) {
        throw new Error("An output segment needs a valid interval.");
      }
    }
    checkedGrids.set(timeline, grid);
    return grid;
  };
  /**
   * How many bytes a second of an output's film takes, from what it has made,
   * read again only when what it has made changes (`SegmentStore.revisionOf`):
   * summed over every made segment on every pass, it was a walk of the whole
   * film a second (torrent-tv/meta#178).
   */
  const madeRates = new Map();
  const bytesPerSecondOf = (output, revision) => {
    const kept = madeRates.get(output.outputKey);
    if (kept && kept.revision === revision && kept.timeline === output.timeline) return kept.bytesPerSecond;
    let bytes = 0, seconds = 0;
    for (const [index, size] of outputParts.segmentStore.sizesOf(output.outputKey)) {
      const span = output.timeline.publishedStartOf(index + 1) - output.timeline.publishedStartOf(index);
      if (span > 0) { bytes += size; seconds += span; }
    }
    const bytesPerSecond = seconds > 0 ? bytes / seconds : null;
    madeRates.set(output.outputKey, { revision, timeline: output.timeline, bytesPerSecond });
    return bytesPerSecond;
  };
  // WHAT THE PASSES COST, said once a minute: how many maps were taken, how
  // many segments a map made the projection work out again and how many of
  // those maps it worked out whole, how many segments had their ranges worked
  // out, the windows told, and the time from a pass's start to its result —
  // which includes waits for reads, so it bounds the main thread's share
  // rather than measuring it (torrent-tv/meta#178).
  const passCosts = { since: Date.now(), passes: 0, whole: 0, reworked: 0, resolved: 0, windows: 0, ms: 0, maxMs: 0 };
  const notePass = ({ whole = false, reworked = 0, resolved = 0, windows = 0, ms = 0 }) => {
    passCosts.passes += 1;
    if (whole) passCosts.whole += 1;
    passCosts.reworked += reworked; passCosts.resolved += resolved; passCosts.windows += windows;
    passCosts.ms += ms; passCosts.maxMs = Math.max(passCosts.maxMs, ms);
    const now = Date.now();
    if (now - passCosts.since < 60_000) return;
    logger.info(`download map passes in ${((now - passCosts.since) / 1000).toFixed(1)}s: ${passCosts.passes} map(s), ` +
      `${passCosts.whole} worked out whole, ${passCosts.reworked} segment(s) worked out again, ` +
      `${passCosts.resolved} segment(s) had their ranges worked out, ${passCosts.windows} window(s) told; ` +
      `${Math.round(passCosts.ms)}ms from start to result in all, longest ${Math.round(passCosts.maxMs)}ms`);
    Object.assign(passCosts, { since: now, passes: 0, whole: 0, reworked: 0, resolved: 0, windows: 0, ms: 0, maxMs: 0 });
  };
  // A container whose packet table a pass did not wait for builds the map
  // again once, when the table is built or refused (`directSegmentInput`).
  const refreshAfterTable = new WeakSet();
  const refreshWhenBuilt = (container, built, { sourceKey, fileIndex }) => {
    if (refreshAfterTable.has(container)) return;
    refreshAfterTable.add(container);
    void built.then(() => {
      refreshAfterTable.delete(container);
      return downloadMaps.refresh(sourceKey, fileIndex);
    }).catch(error => logger.warn(`download map after a packet table: ${error?.message ?? error}`));
  };
  const resolvePlayback = async (map) => {
      const fileKey = `${map.sourceKey}:${map.fileIndex}`;
      if (map.zones.length === 0) {
        playbackProjections.get(fileKey)?.clear();
        return [];
      }
      const params = await mediaParams.paramsFor(map);
      if (!params || !map.isCurrent()) return [];
      const tracks = await sourceRanges.tracksOf(params, () => map.isCurrent());
      if (tracks.kind !== "result") return [];
      const container = tracks.container;
      const media = await sourceRanges.shiftOf(params, () => map.isCurrent());
      if (media.kind !== "result") return [];
      const shift = media.shift;
      // A zone's ranges are stated to the torrent at the precision it fetches:
      // ranges closer than a piece hold the same pieces as one.
      const pieceLength = Number(torrentPool.knownTorrent(map.sourceKey)?.pieceLength);
      const passStartedAt = performance.now();
      // THE PROJECTION IS KEPT while what it was made from stands: the file's
      // tracks, where its clock starts and how the torrent fetches. Any of them
      // changed, every segment's ranges are other ranges.
      let projection = playbackProjections.get(fileKey);
      if (!projection || projection.trackList !== tracks.trackList || projection.shift !== shift ||
        !Object.is(projection.pieceLength, pieceLength)) {
        projection?.clear();
        projection = new PlaybackProjection();
        Object.assign(projection, { trackList: tracks.trackList, shift, pieceLength });
        playbackProjections.set(fileKey, projection);
      }
      // Every output of this file somebody is watching, with what decides how
      // long its segments take to make and deliver, what it has made, and what
      // its next run would copy.
      const played = [];
      /** By output: what its segments read and how they are looked up. */
      const readers = new Map();
      for (const output of outputParts.outputs.values()) {
        if (output.file.sourceKey !== map.sourceKey) continue;
        const consumers = [...outputParts.viewers.forOutput(output).values()].filter(viewer =>
          viewer.isPresent() && !outputParts.outputs.supersededBy(output, viewer.activeVariantId ?? null));
        if (consumers.length === 0) continue;
        const choices = trackChoicesOf(output, map.fileIndex);
        if (choices.length === 0) continue;
        const grid = gridOf(output);
        if (!grid) continue;
        const revision = outputParts.segmentStore.revisionOf(output.outputKey);
        const links = consumers.map(viewer => viewer.linkReading()?.linkMbps)
          .filter(value => Number.isFinite(value) && value > 0);
        // Every piece answers for its exact ending boundary, as the encode
        // plan reads it: the player may request the preceding piece there.
        played.push({ outputKey: output.outputKey, grid,
          encodeSpeed: outputParts.encodeCost.latestSpeedReadingOf(output)?.speed,
          bytesPerSecond: bytesPerSecondOf(output, revision), linkMbps: links.length ? Math.min(...links) : null,
          readyRevision: revision, ready: () => outputParts.segmentStore.sizesOf(output.outputKey),
          target: outputParts.encodeInputs?.targetInputBytes?.(output) ?? null });
        readers.set(output.outputKey, { records: segmentRecordsOf(map, output), choices,
          facts: { timeline: output.timeline, trackList: tracks.trackList, shift, map } });
      }
      // WHAT THE MAP CHANGED, and only that, is worked out again here.
      projection.update({ zones: map.zones, outputs: played });
      const reworked = projection.lastUpdate;
      let resolved = 0;
      // A container that names the bytes of an interval from an index it holds
      // answers every segment by arithmetic: once that index is read
      // ("source-navigation"), the ranges are computed here directly instead of
      // through the file's queue of reads, three steps per segment. On Home
      // Assistant those steps made a pass over a two-hour AVI take minutes while
      // the arithmetic takes milliseconds (torrent-tv/meta#151).
      const navigated = await sourceRanges.navigable(params, () => map.isCurrent());
      if (navigated.kind === "stale") return [];
      const direct = navigated.kind === "result" && navigated.value === true &&
        typeof container?.readSourceRanges === "function" ? container : null;
      // An output whose file-level reading is not there in this pass — the
      // index or Cues that say where a segment is, not yet downloaded, or the
      // table its segments read, refused memory — answers its other segments
      // the same way. One unanswered request is kept to be retried when the
      // bytes or the memory change, and the map is built again when it
      // answers; asking every segment held the main thread for 3.3 s on a cold
      // two-hour AVI (torrent-tv/meta#178).
      const waiting = new Set();
      const turn = takeTurns();
      // ONLY THE SEGMENTS WHOSE RANGES ARE NOT KNOWN are worked out, in the
      // order the swarm is to fetch them. Range resolution can use either a
      // direct source index or the fallback reads below; yield between zones
      // in both cases so a large map cannot hold the main thread across its
      // full projection.
      for (const zone of projection.unresolved()) {
        if (!map.isCurrent()) return [];
        await turn();
        if (!map.isCurrent()) return [];
        const resolutionStartedAt = performance.now();
        const resolution = { outcome: "unresolved", method: null, trackCount: null, rangeCount: null, rangeBytes: null };
        const resolutionId = `${map.fileIndex}:${zone.outputKey}:${zone.index}:${passStartedAt.toFixed(3)}`;
        waitTrace.source(map.sourceKey, "process", { process: "P4.1", phase: "begin", resolutionId,
          sourceId: `${map.sourceKey}:${map.fileIndex}`, fileIndex: map.fileIndex, outputKey: zone.outputKey,
          segment: zone.index, priority: zone.priority, deadlineAt: zone.deadlineAt });
        try {
          const reader = readers.get(zone.outputKey);
          if (!reader) {
            resolution.outcome = "reader-missing";
            continue;
          }
        // WHAT A SEGMENT READS IS WORKED OUT ONCE (`segmentRecordOf`). Rebuilt
        // for every segment of the film on every map, this pass held the main
        // thread up to 1.5 s at a time on Home Assistant (torrent-tv/meta#178).
          const record = segmentRecordOf(reader.records, { index: zone.index, tracks: reader.choices }, reader.facts);
          const reading = record.reading;
          if (!reading) {
            resolution.outcome = "segment-reading-unavailable";
            projection.setUnreadable(zone.outputKey, zone.index);
            continue;
          }
          const { wanted, modes, interval, rangesKey } = reading;
          resolution.trackCount = wanted.length;
          resolution.trackIds = wanted.map(track => track.trackNumber);
          resolution.sourceInterval = { from: interval.from, to: interval.to };
          const convert = (ranges, method) => {
            if (record.ranges !== ranges || record.pieceLength !== pieceLength) {
              record.ranges = ranges;
              record.pieceLength = pieceLength;
              record.joined = joinedWithinPieces(ranges, pieceLength);
            }
            const joined = record.joined;
            resolution.method = method;
            resolution.rangeCount = joined.length;
            resolution.rangeBytes = joined.reduce((total, [start, end]) => total + end - start + 1, 0);
            // What the segment reads is kept for the forecast in a table of its
            // own, whatever form the torrent is told it in.
            if (record.registered !== joined) {
              segmentInputs.set(map.sourceKey, map.fileIndex, zone.outputKey, zone.index, joined);
              record.registered = joined;
            }
            projection.setRanges(zone.outputKey, zone.index, joined);
            resolution.outcome = "resolved";
            resolved += 1;
          };
        // The bytes one segment needs are a fact of the file and the output, so
        // they are worked out once. A whole film is thousands of segments and
        // the map changes every few seconds; worked out afresh on every change,
        // a pass over a two-hour AVI never finished and the next segment's bytes
        // were never asked for (Home Assistant 2026-10-08, torrent-tv/meta#151).
          const known = record.ranges ? { ranges: record.ranges, method: "segment-record-cache" } : sourceRanges.cached(rangesKey);
          if (known) { convert(known.ranges, known.method); continue; }
          if (waiting.has(zone.outputKey)) {
            resolution.outcome = "waiting-for-output-input";
            continue;
          }
        // What is resolved so far is stated before a lower zone is worked out
        // (DownloadMaps, torrent-tv/meta#178).
          map.workingOut?.(zone.priority, () => projection.windows());
          const found = await sourceRanges.resolve({ rangesKey, direct, interval, tracks: wanted, modes,
            isCurrent: () => map.isCurrent(),
            whenBuilt: built => refreshWhenBuilt(direct, built, map),
            intervalParams: () => {
              resolution.method = "container-index-fallback";
              return mediaParams.paramsFor({ ...map, packetInterval: interval,
                requestId: `download:${map.sourceKey}:${map.fileIndex}:${zone.outputKey}:${zone.index}`,
                demand: { ...zone.owner, leadSeconds: zone.leadSeconds } });
            } });
          if (found.kind === "result") { convert(found.ranges, found.method); continue; }
          resolution.method = found.method;
          if (found.kind === "stale") {
            resolution.outcome = "map-replaced";
            return [];
          }
          if (found.kind === "pending") {
          // A table still being built holds this output's segments, and only
          // this output's: the map is built again when it is.
            resolution.outcome = "source-index-pending";
            waiting.add(zone.outputKey);
            continue;
          }
          if (found.kind === "needs-source") {
            resolution.outcome = "source-file-unavailable";
            continue;
          }
          if (found.step === "navigation") {
            resolution.outcome = `source-navigation-${found.kind}`;
            if (found.kind === "needs-ranges" || found.kind === "needs-memory") waiting.add(zone.outputKey);
            continue;
          }
          if (found.kind === "needs-memory") waiting.add(zone.outputKey);
          resolution.outcome = found.step === "packets" ? `source-packets-${found.kind}` : `segment-input-${found.kind}`;
        } catch (error) {
          resolution.outcome = "error";
          resolution.error = error?.message ?? String(error);
          throw error;
        } finally {
          const resolutionEndedAt = performance.now();
          waitTrace.source(map.sourceKey, "process", { process: "P4.1", phase: "end", resolutionId,
            sourceId: `${map.sourceKey}:${map.fileIndex}`, fileIndex: map.fileIndex, outputKey: zone.outputKey,
            segment: zone.index, priority: zone.priority,
            startedAt: resolutionStartedAt, endedAt: resolutionEndedAt, durationMs: resolutionEndedAt - resolutionStartedAt,
            ...resolution });
        }
      }
      const result = projection.windows();
      notePass({ whole: reworked.whole, reworked: reworked.segments, resolved, windows: result.length,
        ms: performance.now() - passStartedAt });
      return result;
  };
  return { resolvePlayback };
}
