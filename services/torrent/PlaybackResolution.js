/**
 * @file The download map's pass: what the torrent is told about the file a
 * viewer plays, worked out from the viewers' map (torrent-tv/meta#270, #273).
 *
 * `DownloadMaps` hands it a file's map; it answers the windows of source bytes
 * the swarm is to fetch. It owns what that pass keeps from map to map: the
 * projection of each played file (`PlaybackProjection`), what each segment of
 * each output reads and the bytes it was worked out to read, the cost of the
 * passes. Everything it reads of the world comes in by a port: the file's
 * parameters, the resolver of a segment's source ranges, the rule of what a
 * segment reads, the outputs somebody watches, the piece length, the table of
 * what each segment reads, the wait-trace and the log.
 */

import { performance } from "node:perf_hooks";
import { takeTurns } from "../../utils/take-turns.js";
import { joinedWithinPieces } from "./demand/pieces.js";
import { PlaybackProjection } from "./PlaybackProjection.js";

export class PlaybackResolution {
  #paramsFor;
  #sourceRanges;
  #segmentReading;
  #playedOutputsOf;
  #pieceLengthOf;
  #noteSegmentInput;
  #refresh;
  #observeWait;
  #log;
  #warn;
  #now;
  #clock;
  #turns;
  /** What the torrent is told of each played file, kept from map to map (`PlaybackProjection`); forgotten with the source. */
  #projections = new Map();
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
  #segmentReadings = new Map();
  /** The choices of one output's tracks as a key, worked out once for the list of them a pass shares. */
  #choicesKeys = new WeakMap();
  /** An output's cut grid, checked once for each timeline. */
  #checkedGrids = new WeakMap();
  /**
   * How many bytes a second of an output's film takes, from what it has made,
   * read again only when what it has made changes (`SegmentStore.revisionOf`):
   * summed over every made segment on every pass, it was a walk of the whole
   * film a second (torrent-tv/meta#178).
   */
  #madeRates = new Map();
  // WHAT THE PASSES COST, said once a minute: how many maps were taken, how
  // many segments a map made the projection work out again and how many of
  // those maps it worked out whole, how many segments had their ranges worked
  // out, the windows told, and the time from a pass's start to its result —
  // which includes waits for reads, so it bounds the main thread's share
  // rather than measuring it (torrent-tv/meta#178).
  #passCosts;
  // A container whose packet table a pass did not wait for builds the map
  // again once, when the table is built or refused (`directSegmentInput`).
  #refreshAfterTable = new WeakSet();

  /**
   * @param {object} ports
   * @param {(request: { sourceKey: string, fileIndex: number, requestId?: string, packetInterval?: object, demand?: object }) => Promise<object | null>} ports.paramsFor
   * @param {object} ports.sourceRanges - `SegmentSourceRanges`.
   * @param {(trackList: object[], choices: object[], sourceInterval: object) => object | null} ports.segmentReading
   * @param {(sourceKey: string, fileIndex: number) => object[]} ports.playedOutputsOf
   * @param {(sourceKey: string) => number} ports.pieceLengthOf - NaN when the torrent is not known.
   * @param {(sourceKey: string, fileIndex: number, outputKey: string, index: number, joined: Array<[number, number]>) => void} ports.noteSegmentInput
   * @param {(sourceKey: string, fileIndex: number) => Promise<unknown>} ports.refresh
   * @param {(sourceKey: string, event: string, fields: object) => void} ports.observeWait
   * @param {(line: string) => void} ports.log
   * @param {(line: string) => void} ports.warn
   * @param {() => number} [ports.now] - The clock of the once-a-minute reading.
   * @param {() => number} [ports.clock] - Pass and P4.1 timing.
   * @param {() => (() => Promise<unknown>)} [ports.turns]
   */
  constructor({ paramsFor, sourceRanges, segmentReading, playedOutputsOf, pieceLengthOf, noteSegmentInput, refresh,
    observeWait, log, warn, now = Date.now, clock = () => performance.now(), turns = takeTurns }) {
    this.#paramsFor = paramsFor;
    this.#sourceRanges = sourceRanges;
    this.#segmentReading = segmentReading;
    this.#playedOutputsOf = playedOutputsOf;
    this.#pieceLengthOf = pieceLengthOf;
    this.#noteSegmentInput = noteSegmentInput;
    this.#refresh = refresh;
    this.#observeWait = observeWait;
    this.#log = log;
    this.#warn = warn;
    this.#now = now;
    this.#clock = clock;
    this.#turns = turns;
    this.#passCosts = { since: now(), passes: 0, whole: 0, reworked: 0, resolved: 0, windows: 0, ms: 0, maxMs: 0 };
  }

  /** The file has no playback zones: what is told of it is emptied. */
  clear(sourceKey, fileIndex) {
    this.#projections.get(`${sourceKey}:${fileIndex}`)?.clear();
  }

  /** The source is forgotten: its projections, records and made rates go. */
  forget(sourceKey) {
    for (const key of this.#segmentReadings.keys()) if (key.startsWith(`${sourceKey}:`)) this.#segmentReadings.delete(key);
    for (const key of this.#projections.keys()) if (key.startsWith(`${sourceKey}:`)) this.#projections.delete(key);
    for (const key of this.#madeRates.keys()) if (key.startsWith(`${sourceKey}:`)) this.#madeRates.delete(key);
  }

  /** One output's segments, by index. */
  #segmentRecordsOf(map, output) {
    const key = `${map.sourceKey}:${map.fileIndex}:${output.outputKey}`;
    let records = this.#segmentReadings.get(key);
    if (!records) this.#segmentReadings.set(key, records = new Map());
    return records;
  }

  #choicesKeyOf(choices) {
    let key = this.#choicesKeys.get(choices);
    if (key === undefined) this.#choicesKeys.set(choices, key = choices.map(choice => `${choice.type}/${choice.index}/${choice.mode}`).join(","));
    return key;
  }

  #segmentRecordOf(records, demand, { timeline, trackList, shift, map }) {
    const choicesKey = this.#choicesKeyOf(demand.tracks);
    const kept = records.get(demand.index);
    if (kept && kept.timeline === timeline && kept.trackList === trackList && kept.shift === shift && kept.choicesKey === choicesKey) return kept;
    const sourceInterval = timeline.sourceInterval(demand.index, demand.index, shift);
    const found = this.#segmentReading(trackList, demand.tracks, sourceInterval);
    const reading = found && { ...found, rangesKey: this.#sourceRanges.keyOf(map.sourceKey, map.fileIndex, found.interval) };
    // `joined` is the segment's ranges as the torrent is told them, made from
    // the list `ranges` at `pieceLength`; `registered` is the list the input
    // table was last given.
    const record = { timeline, trackList, shift, choicesKey, sourceInterval, reading,
      ranges: null, pieceLength: Number.NaN, joined: null, registered: null };
    records.set(demand.index, record);
    return record;
  }

  #gridOf(timeline) {
    if (!timeline || typeof timeline !== "object") return null;
    if (this.#checkedGrids.has(timeline)) return this.#checkedGrids.get(timeline);
    const grid = timeline.published ?? timeline.boundaries;
    if (!Array.isArray(grid)) {
      this.#checkedGrids.set(timeline, null);
      return null;
    }
    for (let index = 0; index + 1 < grid.length; index++) {
      if (!Number.isFinite(grid[index]) || !Number.isFinite(grid[index + 1]) || !(grid[index + 1] > grid[index])) {
        throw new Error("An output segment needs a valid interval.");
      }
    }
    this.#checkedGrids.set(timeline, grid);
    return grid;
  }

  #bytesPerSecondOf(entry) {
    const kept = this.#madeRates.get(entry.outputKey);
    if (kept && kept.revision === entry.revision && kept.timeline === entry.timeline) return kept.bytesPerSecond;
    let bytes = 0, seconds = 0;
    for (const [index, size] of entry.sizes()) {
      const span = entry.timeline.publishedStartOf(index + 1) - entry.timeline.publishedStartOf(index);
      if (span > 0) { bytes += size; seconds += span; }
    }
    const bytesPerSecond = seconds > 0 ? bytes / seconds : null;
    this.#madeRates.set(entry.outputKey, { revision: entry.revision, timeline: entry.timeline, bytesPerSecond });
    return bytesPerSecond;
  }

  #notePass({ whole = false, reworked = 0, resolved = 0, windows = 0, ms = 0 }) {
    const passCosts = this.#passCosts;
    passCosts.passes += 1;
    if (whole) passCosts.whole += 1;
    passCosts.reworked += reworked; passCosts.resolved += resolved; passCosts.windows += windows;
    passCosts.ms += ms; passCosts.maxMs = Math.max(passCosts.maxMs, ms);
    const now = this.#now();
    if (now - passCosts.since < 60_000) return;
    this.#log(`download map passes in ${((now - passCosts.since) / 1000).toFixed(1)}s: ${passCosts.passes} map(s), ` +
      `${passCosts.whole} worked out whole, ${passCosts.reworked} segment(s) worked out again, ` +
      `${passCosts.resolved} segment(s) had their ranges worked out, ${passCosts.windows} window(s) told; ` +
      `${Math.round(passCosts.ms)}ms from start to result in all, longest ${Math.round(passCosts.maxMs)}ms`);
    Object.assign(passCosts, { since: now, passes: 0, whole: 0, reworked: 0, resolved: 0, windows: 0, ms: 0, maxMs: 0 });
  }

  #refreshWhenBuilt(container, built, { sourceKey, fileIndex }) {
    if (this.#refreshAfterTable.has(container)) return;
    this.#refreshAfterTable.add(container);
    void built.then(() => {
      this.#refreshAfterTable.delete(container);
      return this.#refresh(sourceKey, fileIndex);
    }).catch(error => this.#warn(`download map after a packet table: ${error?.message ?? error}`));
  }

  /**
   * One pass over a file's map.
   *
   * @param {{ sourceKey: string, fileIndex: number, zones: object[], isCurrent: () => boolean,
   *   workingOut?: (priority: number, zonesOf: () => object[]) => void }} map
   * @returns {Promise<object[]>} The windows to tell the torrent; empty when the map was replaced meanwhile.
   */
  async resolve(map) {
    const fileKey = `${map.sourceKey}:${map.fileIndex}`;
    if (map.zones.length === 0) {
      this.#projections.get(fileKey)?.clear();
      return [];
    }
    const params = await this.#paramsFor({ sourceKey: map.sourceKey, fileIndex: map.fileIndex });
    if (!params || !map.isCurrent()) return [];
    const tracks = await this.#sourceRanges.tracksOf(params, () => map.isCurrent());
    if (tracks.kind !== "result") return [];
    const container = tracks.container;
    const media = await this.#sourceRanges.shiftOf(params, () => map.isCurrent());
    if (media.kind !== "result") return [];
    const shift = media.shift;
    // A zone's ranges are stated to the torrent at the precision it fetches:
    // ranges closer than a piece hold the same pieces as one.
    const pieceLength = this.#pieceLengthOf(map.sourceKey);
    const passStartedAt = this.#clock();
    // THE PROJECTION IS KEPT while what it was made from stands: the file's
    // tracks, where its clock starts and how the torrent fetches. Any of them
    // changed, every segment's ranges are other ranges.
    let projection = this.#projections.get(fileKey);
    if (!projection || projection.trackList !== tracks.trackList || projection.shift !== shift ||
      !Object.is(projection.pieceLength, pieceLength)) {
      projection?.clear();
      projection = new PlaybackProjection();
      Object.assign(projection, { trackList: tracks.trackList, shift, pieceLength });
      this.#projections.set(fileKey, projection);
    }
    // Every output of this file somebody is watching, with what decides how
    // long its segments take to make and deliver, what it has made, and what
    // its next run would copy.
    const played = [];
    /** By output: what its segments read and how they are looked up. */
    const readers = new Map();
    for (const entry of this.#playedOutputsOf(map.sourceKey, map.fileIndex)) {
      const grid = this.#gridOf(entry.timeline);
      if (!grid) continue;
      // Every piece answers for its exact ending boundary, as the encode
      // plan reads it: the player may request the preceding piece there.
      played.push({ outputKey: entry.outputKey, grid, encodeSpeed: entry.encodeSpeed,
        bytesPerSecond: this.#bytesPerSecondOf(entry), linkMbps: entry.linkMbps,
        readyRevision: entry.revision, ready: entry.sizes, target: entry.target });
      readers.set(entry.outputKey, { records: this.#segmentRecordsOf(map, entry), choices: entry.choices,
        facts: { timeline: entry.timeline, trackList: tracks.trackList, shift, map } });
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
    const navigated = await this.#sourceRanges.navigable(params, () => map.isCurrent());
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
    const turn = this.#turns();
    // ONLY THE SEGMENTS WHOSE RANGES ARE NOT KNOWN are worked out, in the
    // order the swarm is to fetch them. Range resolution can use either a
    // direct source index or the fallback reads below; yield between zones
    // in both cases so a large map cannot hold the main thread across its
    // full projection.
    for (const zone of projection.unresolved()) {
      if (!map.isCurrent()) return [];
      await turn();
      if (!map.isCurrent()) return [];
      const resolutionStartedAt = this.#clock();
      const resolution = { outcome: "unresolved", method: null, trackCount: null, rangeCount: null, rangeBytes: null };
      const resolutionId = `${map.fileIndex}:${zone.outputKey}:${zone.index}:${passStartedAt.toFixed(3)}`;
      this.#observeWait(map.sourceKey, "process", { process: "P4.1", phase: "begin", resolutionId,
        sourceId: `${map.sourceKey}:${map.fileIndex}`, fileIndex: map.fileIndex, outputKey: zone.outputKey,
        segment: zone.index, priority: zone.priority, deadlineAt: zone.deadlineAt });
      try {
        const reader = readers.get(zone.outputKey);
        if (!reader) {
          resolution.outcome = "reader-missing";
          continue;
        }
        // WHAT A SEGMENT READS IS WORKED OUT ONCE (`#segmentRecordOf`). Rebuilt
        // for every segment of the film on every map, this pass held the main
        // thread up to 1.5 s at a time on Home Assistant (torrent-tv/meta#178).
        const record = this.#segmentRecordOf(reader.records, { index: zone.index, tracks: reader.choices }, reader.facts);
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
            this.#noteSegmentInput(map.sourceKey, map.fileIndex, zone.outputKey, zone.index, joined);
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
        const known = record.ranges ? { ranges: record.ranges, method: "segment-record-cache" } : this.#sourceRanges.cached(rangesKey);
        if (known) { convert(known.ranges, known.method); continue; }
        if (waiting.has(zone.outputKey)) {
          resolution.outcome = "waiting-for-output-input";
          continue;
        }
        // What is resolved so far is stated before a lower zone is worked out
        // (DownloadMaps, torrent-tv/meta#178).
        map.workingOut?.(zone.priority, () => projection.windows());
        const found = await this.#sourceRanges.resolve({ rangesKey, direct, interval, tracks: wanted, modes,
          isCurrent: () => map.isCurrent(),
          whenBuilt: built => this.#refreshWhenBuilt(direct, built, map),
          intervalParams: () => {
            resolution.method = "container-index-fallback";
            return this.#paramsFor({ sourceKey: map.sourceKey, fileIndex: map.fileIndex, packetInterval: interval,
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
        const resolutionEndedAt = this.#clock();
        this.#observeWait(map.sourceKey, "process", { process: "P4.1", phase: "end", resolutionId,
          sourceId: `${map.sourceKey}:${map.fileIndex}`, fileIndex: map.fileIndex, outputKey: zone.outputKey,
          segment: zone.index, priority: zone.priority,
          startedAt: resolutionStartedAt, endedAt: resolutionEndedAt, durationMs: resolutionEndedAt - resolutionStartedAt,
          ...resolution });
      }
    }
    const result = projection.windows();
    this.#notePass({ whole: reworked.whole, reworked: reworked.segments, resolved, windows: result.length,
      ms: this.#clock() - passStartedAt });
    return result;
  }
}
