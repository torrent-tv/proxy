/**
 * Predict the minimum delay before playback can run to the end without
 * exhausting the continuous media available for the required tracks.
 *
 * This module contains the playback decision's only model. Its inputs are
 * measurements and physical limits: mapped whole-piece arrivals, encoded
 * media and encoder rate, segment sizes and client-link rate, existing
 * continuous media, and measured supply interruptions. Each service integral
 * extends its latest measured rate until the next observation. The forecast
 * is conditional on these measured services continuing. Browser storage
 * capacity is not an admission condition. There are no fitted weights or
 * rate multipliers, and no search over candidate start times.
 *
 * Whether media is continuous is decided in exact time ({@link ./media-time.js}):
 * the ticks the served pieces declare, the binary fractions the page reports,
 * and the rule by which every browser this player runs on joins buffered
 * ranges. Seconds are used for rates, schedules and the answer.
 */

import {
  add,
  compare,
  contains,
  contiguousEnd,
  earliest,
  fromSeconds,
  latest,
  mediaTime,
  nearest,
  REPORTED_TIME_ERROR,
  rescale,
  addRange as addMediaRange,
  commonTimescale,
  subtract,
  toSeconds,
  ZERO
} from "./media-time.js";

// Match the media element's allowance for a range that starts a few frames
// after its current position (see server/public/domain/buffer-metrics.js).
const CLIENT_RANGE_START_TOLERANCE_SECONDS = 0.25;

/**
 * The mean rate predicted over a horizon by the integral of the measured rate.
 * Polling does not change the last measured service rate.
 *
 * @param {Array<{ at: number, value: number }>} readings
 * @param {number} now
 * @param {number} horizonSeconds
 * @returns {number | null}
 */
export function forecastRate(readings, now = Date.now(), horizonSeconds = 0, weighting = "last") {
  const curve = rateCurve(readings, now, weighting);
  if (!curve) {
    return null;
  }
  const horizon = Number.isFinite(horizonSeconds) ? Math.max(0, horizonSeconds) : 0;
  return horizon > 0 ? curve.workBy(horizon) / horizon : curve.rateAt(0);
}

/**
 * The summary the forecast reads, of a window of readings taken in any order:
 * ordered by when each was taken, readings taken in the same millisecond kept
 * apart. Null for no reading.
 *
 * @param {Array<{ at: number, speed?: number, value?: number }>} readings
 * @returns {object | null}
 */
export function rateSummaryOf(readings) {
  const ordered = (Array.isArray(readings) ? readings : [])
    .map(reading => ({ at: reading?.at, value: reading?.value ?? reading?.speed }))
    .filter(reading => Number.isFinite(reading.at) && Number.isFinite(reading.value) && reading.value >= 0)
    .sort((left, right) => left.at - right.at);
  return ordered.length > 0 ? summarizeRate(ordered) : null;
}

/**
 * Measurements over the output's existing look-ahead horizon. The oldest
 * boundary sample is retained until another sample replaces it, so a repeated
 * report never changes the history or invents a new measurement.
 */
export class RateTrend {
  #readings = [];
  #horizonMs;

  constructor(horizonSeconds = Number.POSITIVE_INFINITY) {
    this.#horizonMs = Math.max(0, horizonSeconds) * 1000;
  }

  add(at, value) {
    if (!Number.isFinite(at) || !Number.isFinite(value) || value < 0 ||
      at <= (this.#readings.at(-1)?.at ?? Number.NEGATIVE_INFINITY)) {
      return false;
    }
    this.#readings.push({ at, value });
    const cutoff = at - this.#horizonMs;
    while (this.#readings.length > 1 && this.#readings[1].at <= cutoff) {
      this.#readings.shift();
    }
    return true;
  }

  snapshot() {
    if (this.#readings.length === 0) {
      return null;
    }
    return summarizeRate(this.#readings);
  }
}

/**
 * @param {object} input
 * @param {number} input.positionSeconds
 * @param {number} input.durationSeconds
 * @param {number} input.bufferedAheadSeconds
 * @param {number} input.bufferLimitSeconds
 * @param {number} input.reserveSeconds - Measured source-stall coverage, in media seconds.
 * @param {number} input.lookaheadSeconds
 * @param {number} input.now
 * @param {boolean} [input.requiredAudio]
 * @param {Array<{ id: string, serviceKey?: string, complete: boolean, fileOffset?: number,
 *   fileLength?: number, pieceLength?: number, downloadRateReadings?: object,
 *   downloadForecast?: { ranges: Array<{ start: number, end: number, availableAt: number | null }> } }>} input.sources
 * @param {Array<{ id: string, sourceIds: string[], processedSeconds: number,
 *   bitsPerMediaSecond: number, readings: Array<{ at: number, value: number }>,
 *   clockOffsetSeconds?: number, clientRanges?: Array<{ start: number, end: number }>,
 *   segments: Array<{ index: number, startSeconds: number, endSeconds: number,
 *     mediaRanges?: { timescale: bigint | null, ranges: Array<{ start: bigint, end: bigint, frame: bigint }> } }>,
 *   readySegmentIndices: number[], segmentSizesBytes: Map<number, number> | object }>} input.tracks
 *   `mediaRanges` are a read piece's ranges on its served timeline, in ticks;
 *   `clockOffsetSeconds` is the `timestampOffset` the page's player applied to
 *   that track; `clientRanges` are what the page reports holding, in seconds.
 * @param {Array<{ at: number, value: number }>} input.linkReadings - Bits/s.
 * @returns {object}
 */
export function predictPlaybackReadiness(input = {}) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  // WHAT IS BEHIND THE VIEWER IS NOT PLANNED AGAIN. The forecast runs on every
  // progress poll of a waiting viewer, and it converted every piece of the film
  // to exact time before dropping those already played: 5.1 s of the proxy's
  // main thread at once after a seek back on Home Assistant, every second of
  // which FFmpeg's input and the page's pieces waited (torrent-tv/meta#178).
  // Kept are the pieces still to play, the first piece (where the track
  // starts), the read piece nearest before them (what an unread piece is placed
  // by) and read pieces inside what the page reports holding (their frames).
  const tracks = (Array.isArray(input.tracks) ? input.tracks : []).map((track) =>
    Array.isArray(track.segments) ? { ...track, segments: piecesThatMatter(track, finiteNonNegative(input.positionSeconds)) } : track);
  const duration = finiteNonNegative(input.durationSeconds);
  // Each track's served ticks are placed on the clock the page reports by the
  // offset its player applied (`timestampOffset`).
  const clocks = tracks.map((track) =>
    Number.isFinite(track.clockOffsetSeconds) ? fromSeconds(track.clockOffsetSeconds) : ZERO);
  const reported = tracks.map((track) => Array.isArray(track.clientRanges)
    ? track.clientRanges.filter((range) => Number.isFinite(range?.start) && Number.isFinite(range?.end) &&
      range.end > range.start).map((range) => ({ start: fromSeconds(range.start), end: fromSeconds(range.end) }))
    : null);
  // One timescale in which every time of this forecast is a whole number of
  // ticks, so that adding and comparing never seek a common denominator. A
  // track's pieces give it the same timescale while they are the same pieces.
  const unit = commonTimescale([
    fromSeconds(finiteNonNegative(input.positionSeconds)), fromSeconds(duration),
    fromSeconds(finiteNonNegative(input.bufferedAheadSeconds)), REPORTED_TIME_ERROR, ...clocks,
    ...reported.flatMap((ranges) => (ranges ?? []).flatMap(({ start, end }) => [start, end])),
    ...tracks.map((track) => mediaTime(0n, timescaleOfPieces(track)))
  ]);
  const zero = mediaTime(0n, unit);
  const segmentsOf = tracks.map((track, trackIndex) => placedPieces(track, rescale(clocks[trackIndex], unit), unit));
  const origin = latest(zero, ...segmentsOf.map((segments) =>
    segments.find(({ index }) => index === 0)?.ranges?.[0]?.start ?? zero));
  const at = latest(origin, rescale(fromSeconds(finiteNonNegative(input.positionSeconds)), unit));
  const position = toSeconds(at);
  const remaining = Math.max(0, duration - position);
  const measuredRanges = reported.map((ranges, trackIndex) => ranges ?
    heldRanges(ranges, segmentsOf[trackIndex], unit, at) : null);
  const measured = measuredRanges.length > 0 && measuredRanges.every(Boolean);
  const heldEnd = measured ? earliest(...measuredRanges.map((ranges) => contiguousEnd(ranges, at))) : null;
  // The figure reported back is what the page said it holds; the widening by
  // the report's error only decides whether a piece is already there.
  const buffered = measured
    ? secondsAhead(subtract(heldEnd, rescale(REPORTED_TIME_ERROR, unit)), at)
    : finiteNonNegative(input.bufferedAheadSeconds);
  const reserve = Math.min(remaining, finiteNonNegative(input.reserveSeconds));
  const sources = new Map((Array.isArray(input.sources) ? input.sources : [])
    .filter((source) => typeof source?.id === "string")
    .map((source) => [source.id, source]));
  if (!(duration > 0) || tracks.length === 0) {
    return result(false, null, buffered, reserve, null, "incomplete-state", 0);
  }
  const requiredTracks = input.requiredAudio === true ? 2 : 1;
  if (tracks.length < requiredTracks) {
    return result(false, null, buffered, reserve, null, "separate-audio-not-observed", 0);
  }
  if (measured ? compare(heldEnd, rescale(fromSeconds(duration), unit)) >= 0 : remaining <= buffered) {
    return result(true, 0, buffered, reserve, 0, "client-buffer-covers-end", 0);
  }
  if (tracks.some((track) => !Array.isArray(track.segments) || track.segments.length === 0)) {
    return result(false, null, buffered, reserve, null, "timeline-unavailable", 0);
  }

  const trackState = tracks.map((track, trackIndex) => ({
    track,
    clientRanges: measuredRanges[trackIndex] ??
      [{ start: at, end: add(at, measured ? nearest(fromSeconds(buffered), unit) :
        rescale(fromSeconds(buffered), unit)), frame: zero }],
    ready: new Set(Array.isArray(track.readySegmentIndices) ? track.readySegmentIndices : []),
    // Film made over the encoder's working time, over the readings the trend
    // keeps: one reading is one closed piece, so the harmonic mean is that
    // ratio. The last reading alone is one piece's content and machine — a
    // first piece of credits read 6.49x and started a cold AVI on 2.4 s of
    // buffer that the next piece, at 0.57x, did not hold (torrent-tv/meta#178).
    curve: rateCurve(track.readings, now, "piece"),
    bitsPerMediaSecond: averageBitsPerMediaSecond(track, track.segments,
      new Set(Array.isArray(track.readySegmentIndices) ? track.readySegmentIndices : [])),
    segments: segmentsOf[trackIndex]
      .filter((segment) => Number.isInteger(segment?.index) &&
        Number.isFinite(segment?.startSeconds) && Number.isFinite(segment?.endSeconds) &&
        segment.endSeconds > segment.startSeconds && segment.endSeconds > position)
      .sort((left, right) => left.startSeconds - right.startSeconds || left.index - right.index)
  }));
  if (trackState.some(({ segments }) => segments.length === 0)) {
    return result(false, null, buffered, reserve, null, "timeline-unavailable", 0);
  }
  const sourceState = new Map();
  // A torrent has one download service, even when required media lives in separate files.
  const sourceServices = new Map();
  for (const [id, source] of sources) {
    const serviceKey = typeof source.serviceKey === "string" ? source.serviceKey : id;
    let service = sourceServices.get(serviceKey);
    if (!service) {
      // Bytes over time across the readings the trend keeps: the last 5 s of a
      // swarm moved between 0.97 and 5.8 MB/s and was carried to the end of the
      // film each time (torrent-tv/meta#178).
      service = { rate: rateCurve(source.downloadRateReadings, now, "time"), finish: 0 };
      sourceServices.set(serviceKey, service);
    }
    sourceState.set(id, { source, service });
  }
  const link = rateCurve(input.linkReadings, now);
  let unknownReason = null;
  if (!link) {
    return result(false, null, buffered, reserve, null, "link-rate-unavailable", 0);
  }

  const preparedSegments = trackState.reduce((sum, { ready, segments }) =>
    sum + segments.filter((segment) => ready.has(segment.index)).length, 0);
  const jobs = [];

  for (let trackIndex = 0; trackIndex < trackState.length; trackIndex += 1) {
    const state = trackState[trackIndex];
    const { track, segments } = state;
    const processingCoverage = numericCoverage((Array.isArray(track.processingRanges) ? track.processingRanges : [])
      .filter(range => Number.isFinite(range?.start) && Number.isFinite(range?.end) && range.end > range.start));
    const measuredBitsPerMediaSecond = state.bitsPerMediaSecond;
    const trackSources = Array.isArray(track.sourceIds) ? track.sourceIds : [];
    for (const segment of segments) {
      // Media the page already holds is not transferred again: every range of
      // the piece still ahead of the viewer lies inside what the page holds.
      let held = segment.ranges.length > 0;
      for (const range of segment.ranges) {
        if (compare(range.end, at) > 0 && !contains(state.clientRanges, latest(range.start, at), range.end)) {
          held = false;
          break;
        }
      }
      if (held) {
        continue;
      }
      const exactBytes = sizeOf(track.segmentSizesBytes, segment.index);
      const segmentSeconds = segment.endSeconds - segment.startSeconds;
      // HLS fetches the complete file when any required part is absent.
      const sizeBits = exactBytes > 0
        ? exactBytes * 8
        : measuredBitsPerMediaSecond * segmentSeconds;
      if (!(sizeBits > 0)) {
        unknownReason ??= "segment-size-unavailable";
      }

      const produced = state.ready.has(segment.index);
      // Attribute unfinished work to the actual run interval. A global
      // position from another run must not erase a missing earlier segment.
      const workStart = segment.startSeconds;
      const remainingProcessing = uncoveredIntervals({ start: workStart, end: segment.endSeconds }, processingCoverage);
      const encodeWork = produced ? 0 : remainingProcessing.reduce((sum, part) => sum + part.end - part.start, 0);

      let sourceByteIntervals = NO_SOURCE_BYTES;
      if (!produced && encodeWork > 0) {
        // Each source the piece reads, in order and once: the track's own, then
        // those its inputs name. Gathered with loops and no copies, because
        // this runs for every piece still to play on every poll of a waiting
        // viewer, and the sets and filtered lists it built were a quarter of
        // the forecast's time on a two-hour film (torrent-tv/meta#178).
        const exactInputs = Array.isArray(segment.sourceInputs) ? segment.sourceInputs : null;
        const count = trackSources.length + (exactInputs?.length ?? 0);
        for (let place = 0; place < count; place += 1) {
          const sourceId = place < trackSources.length ? trackSources[place]
            : exactInputs[place - trackSources.length]?.sourceId;
          if (namedBefore(sourceId, place, trackSources, exactInputs)) continue;
          const source = sourceState.get(sourceId);
          if (!source) {
            unknownReason ??= "source-measurement-unavailable";
          } else if (source.source.complete !== true) {
            const ranges = exactInputs ? inputRangesOf(exactInputs, sourceId) : null;
            if (ranges === null) {
              unknownReason ??= "source-input-ranges-unavailable";
            } else {
              if (sourceByteIntervals === NO_SOURCE_BYTES) sourceByteIntervals = new Map();
              sourceByteIntervals.set(sourceId, ranges);
            }
          }
        }
      }
      if (!produced && encodeWork > 0 && !state.curve) {
        unknownReason ??= "encode-rate-unavailable";
      }
      jobs.push({
        trackIndex,
        track,
        segment,
        ahead: Math.max(0, segment.startSeconds - position),
        sizeBits,
        encodeWork,
        sourceByteIntervals,
        produced
      });
    }
  }

  if (unknownReason) {
    return result(false, null, buffered, reserve, null, unknownReason, preparedSegments);
  }
  for (const { track, curve } of trackState) {
    if (jobs.some((job) => job.track === track && !job.produced) && !curve) {
      return result(false, null, buffered, reserve, null, "encode-rate-unavailable", preparedSegments);
    }
  }

  jobs.sort((left, right) => left.segment.startSeconds - right.segment.startSeconds ||
    left.segment.endSeconds - right.segment.endSeconds || left.trackIndex - right.trackIndex);

  // Each resource has one service integral and one queue. Production is
  // scheduled in media order, independently of browser storage capacity.
  // The earliest legal start is the supremum of completion lateness against
  // presentation deadlines, not a search over guessed delay candidates.
  const sourceByteService = new Map();
  for (const [id, { source }] of sourceState) {
    sourceByteService.set(id, Array.isArray(source.residence) ? source.residence
      .filter(({ location, start, end }) => location !== "missing" && Number.isFinite(start) && Number.isFinite(end) && end > start)
      .map(({ start, end }) => ({ start, end, begin: 0, finish: 0 })) : []);
    if (source.downloadForecast) {
      for (const range of source.downloadForecast.ranges ?? []) {
        if (!Number.isFinite(range?.availableAt) || !Number.isSafeInteger(range.start) ||
          !Number.isSafeInteger(range.end) || range.start < 0 || range.end <= range.start) continue;
        // A forecast time already past says nothing of when the bytes come:
        // held bytes are in the residence, and missing ones are estimated
        // below. Read as an arrival at zero, a piece forecast to come and
        // still missing counted as held (torrent-tv/meta#178).
        if (range.availableAt <= now) continue;
        const arrival = (range.availableAt - now) / 1000;
        // The entire protocol piece becomes readable after verification;
        // bytes inside it never arrive proportionally to their file address.
        sourceByteService.get(id).push({ start: range.start, end: range.end, begin: arrival, finish: arrival });
      }
    }
  }
  const trackFinish = trackState.map(({ track }) => finiteNonNegative(track.startupRemainingSeconds));
  // WHERE A RUN STARTS, AND WHAT IT COSTS. A run is given the stretch whose
  // bytes are held when its input is admitted, and the next one starts after
  // it, when more bytes are held, and opens its input first — 6-10 s on an
  // OpenDML AVI. Charged once at the first start only, a cold AVI made of runs
  // of one to five pieces was forecast as one run (torrent-tv/meta#178). So a
  // piece outside the live runs' stretches whose bytes arrive after the run
  // the schedule last started was admitted begins a run of its own, admitted
  // when the piece before it is made and its bytes are held, then opened.
  // The first run's start is `startupRemainingSeconds`, charged once above; a
  // stretch's bound by memory and by its copy time is not modelled.
  const runStarts = trackState.map(({ track }) => ({
    openSeconds: finiteNonNegative(track.openSeconds),
    spans: (Array.isArray(track.runSpans) ? track.runSpans : [])
      .filter(span => Number.isFinite(span?.start) && span.end > span.start),
    admittedAt: finiteNonNegative(track.startupRemainingSeconds) > 0 ? 0 : null
  }));
  const sourceByteCoverage = new Map([...sourceByteService].map(([id, ranges]) => [id, numericCoverage(ranges)]));
  const sourceArrivals = new Map([...sourceByteService].map(([id, ranges]) => [id, indexedArrivals(ranges)]));
  let transferFinish = 0;
  const completions = [];
  const productions = [];
  for (const job of jobs) {
    const { track, trackIndex, segment, sizeBits, encodeWork, sourceByteIntervals } = job;
    let sourceArrivalAt = 0;
    for (const [sourceId, ranges] of sourceByteIntervals) {
      const source = sourceState.get(sourceId);
      if (!source) {
        return result(false, null, buffered, reserve, null, "source-measurement-unavailable", preparedSegments);
      }
      for (const interval of ranges) {
        const missing = uncoveredIntervals(interval, sourceByteCoverage.get(sourceId) ?? []);
        if (missing.length === 0) {
          sourceArrivalAt = Math.max(sourceArrivalAt, latestArrival(interval, sourceArrivals.get(sourceId)));
          continue;
        }

        // Explicit piece arrivals remain authoritative. For still-unmapped
        // pieces, project only the media-order demand from the torrent's latest
        // measured download service; no supplier or positive rate means no
        // estimated arrival.
        const { source: facts, service: sourceService } = source;
        const { rate } = sourceService;
        if (!rate || !(rate.rateAt(0) > 0) || !Number.isSafeInteger(facts.pieceLength) ||
            facts.pieceLength <= 0 || !Number.isSafeInteger(facts.fileOffset) ||
            !Number.isSafeInteger(facts.fileLength) || facts.fileLength <= 0) {
          return { ...result(false, null, buffered, reserve, null,
            rate ? "service-not-advancing" : "download-rate-unavailable", preparedSegments),
          unavailableSource: { sourceId, segmentIndex: segment.index, range: interval, missing } };
        }
        const estimatedPieces = sourcePiecesFor(missing, facts);
        let finish = Math.max(sourceService.finish, sourceArrivalAt);
        const service = sourceByteService.get(sourceId) ?? [];
        for (const pieceRange of estimatedPieces) {
          const stillMissing = uncoveredIntervals(pieceRange, sourceByteCoverage.get(sourceId) ?? []);
          for (const part of stillMissing) {
            finish = rate.finish(part.end - part.start, finish);
            const arrival = { start: part.start, end: part.end, begin: finish, finish };
            service.push(arrival);
            sourceArrivalAt = Math.max(sourceArrivalAt, finish);
            // Joined in place, as the whole list would join: pieces arrive in
            // media order, so each one extends the end. Sorting the whole list
            // again after every piece was most of the forecast's time.
            sourceByteCoverage.set(sourceId, withCoverage(sourceByteCoverage.get(sourceId) ?? [], arrival));
            sourceArrivals.set(sourceId, withArrival(sourceArrivals.get(sourceId) ?? [], arrival, service));
          }
        }
        sourceService.finish = finish;
      }
    }
    // Production accepts a complete held segment input. It cannot overlap its
    // own source download; reused input retains its original arrival time.
    const processing = trackState[trackIndex].curve;
    let admittedAt = Math.max(trackFinish[trackIndex], sourceArrivalAt);
    if (!job.produced && encodeWork > 0) {
      const run = runStarts[trackIndex];
      const live = run.spans.some(span => segment.startSeconds >= span.start && segment.startSeconds < span.end);
      if (!live && (run.admittedAt === null || sourceArrivalAt > run.admittedAt)) {
        run.admittedAt = admittedAt;
        admittedAt += run.openSeconds;
      }
    }
    const producedAt = job.produced || encodeWork === 0 ? 0 : processing.finish(encodeWork, admittedAt);
    trackFinish[trackIndex] = Math.max(trackFinish[trackIndex], producedAt);
    productions.push({ at: producedAt, trackIndex, segment, requiresSource: sourceArrivalAt > 0 });
    const deliveryAt = link.finish(sizeBits, Math.max(transferFinish, producedAt));
    transferFinish = deliveryAt;
    completions.push({ at: deliveryAt + finiteNonNegative(track.appendSeconds), trackIndex, segment });
  }

  const constraints = [];
  // WHICH CONSTRAINT HOLDS THE START, said with the answer: the delay is the
  // largest of thousands, and the log could only say that some term was
  // positive while the picture stood for 17 s (torrent-tv/meta#178).
  let holding = null;
  const constrain = (value, kind, trackIndex, segment, atSeconds, aheadSeconds, requiresSource) => {
    constraints.push(value);
    if (value > 0 && (holding === null || value > holding.value)) {
      holding = { value, kind, trackIndex, segment, atSeconds, aheadSeconds, requiresSource };
    }
  };
  const end = rescale(fromSeconds(duration), unit);
  for (let trackIndex = 0; trackIndex < trackState.length; trackIndex += 1) {
    const state = trackState[trackIndex];
    const delivered = state.clientRanges.map((range) => ({ ...range }));
    const prepared = state.clientRanges.map((range) => ({ ...range }));
    const lastRange = state.segments.at(-1).ranges.at(-1);
    const trackEnd = lastRange ? earliest(end, lastRange.end) : end;
    // What the page holds without a gap from the viewer only changes when a
    // piece is added to it, so the end after one piece is the end before the
    // next.
    let after = contiguousEnd(delivered, at);
    for (const completion of completions.filter((item) => item.trackIndex === trackIndex)) {
      const before = after;
      for (const range of completion.segment.ranges) addMediaRange(delivered, range);
      after = contiguousEnd(delivered, at);
      const ahead = secondsAhead(earliest(before, trackEnd), at);
      constrain(completion.at - ahead, "delivery", trackIndex, completion.segment.index, completion.at, ahead, false);
      if (compare(after, before) <= 0 && completion.segment.ranges.some(({ start }) => compare(start, before) > 0)) {
        // A timestamp hole cannot be repaired by waiting longer. Keep it
        // distinct from an unavailable rate or a slow but finite service.
        return result(false, null, buffered, reserve, null, 'media-continuity-unavailable', preparedSegments);
      }
    }
    if (compare(after, trackEnd) < 0) {
      // Everything this track still needs has been delivered in the schedule
      // and its media still stops short of the end: a hole between ranges
      // already held, which no arrival crosses.
      return result(false, null, buffered, reserve, null, 'media-continuity-unavailable', preparedSegments);
    }
    for (const production of productions.filter((item) => item.trackIndex === trackIndex)) {
      const before = contiguousEnd(prepared, at);
      for (const range of production.segment.ranges) addMediaRange(prepared, range);
      // Supply interruption coverage is stock held by the proxy as well as
      // the browser. It is not a browser buffer-size admission rule.
      const ahead = Math.max(0, secondsAhead(before, at) -
        Math.min(reserve, secondsAhead(trackEnd, before)) * Number(production.requiresSource));
      constrain(production.at - ahead, "production", trackIndex, production.segment.index, production.at, ahead,
        production.requiresSource);
    }
  }
  const delay = Math.max(0, ...constraints);
  const originReady = trackState.every(({ clientRanges }) => compare(contiguousEnd(clientRanges, at), at) > 0);
  const ready = delay === 0 && originReady;
  const forecast = result(ready, Number.isFinite(delay) ? delay : null, buffered, reserve,
    Math.max(0, reserve - buffered), ready ? 'trajectory-safe-now' :
      Number.isFinite(delay) ? 'minimum-safe-delay' : 'service-not-advancing', preparedSegments);
  return { ...forecast, measuredAt: now, predictedStartAt: Number.isFinite(delay) ? now + delay * 1000 : null,
    // The piece whose `kind` — its production, or its delivery to the page —
    // comes `atSeconds` from now while the media before it lasts
    // `aheadSeconds`: the difference is the delay.
    holdingBy: ready ? null : holding === null ? (originReady ? null : { kind: "position-not-held" })
      : { kind: holding.kind, track: tracks[holding.trackIndex]?.id ?? holding.trackIndex,
        segment: holding.segment, atSeconds: holding.atSeconds, aheadSeconds: holding.aheadSeconds,
        requiresSource: holding.requiresSource },
    preparedUntilSeconds: Math.min(duration, ...trackState.map((state, index) => {
      const ranges = state.clientRanges.map((range) => ({ ...range }));
      for (const item of productions.filter((item) => item.trackIndex === index && item.at <= delay)) {
        for (const range of item.segment.ranges) addMediaRange(ranges, range);
      }
      return toSeconds(contiguousEnd(ranges, at));
    })) };

}

/**
 * Seconds from `from` to `to`, or zero when `to` is not later.
 *
 * @param {import("./media-time.js").MediaTime} to
 * @param {import("./media-time.js").MediaTime} from
 * @returns {number}
 */
function secondsAhead(to, from) {
  return compare(to, from) > 0 ? toSeconds(subtract(to, from)) : 0;
}

/**
 * Served ranges of a piece on the page's clock, in the forecast's timescale.
 * Media Source drops coded frames that start before `appendWindowStart`, zero
 * unless a page sets it, so nothing before zero is held; a range is cut there.
 *
 * @param {{ timescale: bigint | null, ranges: Array<{ start: bigint, end: bigint, frame: bigint }> }
 *   | undefined | null} served
 * @param {import("./media-time.js").MediaTime} clock - In `unit`.
 * @param {bigint} unit
 * @returns {import("./media-time.js").MediaRange[] | undefined}
 */
function playerRanges(served, clock, unit) {
  if (served === undefined || served === null) {
    return undefined;
  }
  if (!served.timescale || !Array.isArray(served.ranges)) {
    // A piece whose coverage could not be read is not known to hold nothing.
    return undefined;
  }
  const zero = mediaTime(0n, unit);
  return joinedPiece(served).map(({ start, end, frame }) => ({
    start: latest(zero, add(rescale(start, unit), clock)),
    end: add(rescale(end, unit), clock),
    frame: rescale(frame, unit)
  })).filter(({ start, end }) => compare(end, start) > 0);
}

/**
 * A piece's intervals joined by the rule a browser applies to them. A piece is
 * appended whole, and joining is unchanged by moving every interval by one
 * clock offset, so this is done once per served piece, in its own ticks, and
 * kept with it.
 *
 * @type {WeakMap<object, import("./media-time.js").MediaRange[]>}
 */
const joinedPieces = new WeakMap();

function joinedPiece(served) {
  let joined = joinedPieces.get(served);
  if (!joined) {
    joined = [];
    for (const { start, end, frame } of served.ranges) {
      addMediaRange(joined, {
        start: mediaTime(start, served.timescale),
        end: mediaTime(end, served.timescale),
        frame: mediaTime(frame, served.timescale)
      });
    }
    joinedPieces.set(served, joined);
  }
  return joined;
}

/**
 * What the page reports holding, as every exact time the report can denote:
 * each edge widened by {@link REPORTED_TIME_ERROR}.
 *
 * The page does not report the frames behind a range, but what it holds is
 * pieces this proxy served. Gecko gives a merged interval the largest fuzz of
 * its parts (`Interval::Span`), so a held range is allowed at least the largest
 * `frame` of the read pieces lying inside it; a range holding none is allowed
 * nothing of its own and joins a neighbour only on the neighbour's allowance.
 *
 * @param {Array<{ start: import("./media-time.js").MediaTime, end: import("./media-time.js").MediaTime }>}
 *   ranges - As reported, converted exactly.
 * @param {Array<{ ranges?: import("./media-time.js").MediaRange[] }>} segments - The
 *   track's pieces on the page's clock.
 * @param {bigint} unit
 * @returns {import("./media-time.js").MediaRange[]}
 */
function heldRanges(ranges, segments, unit, position) {
  const pieces = segments.flatMap((segment) => segment.ranges ?? []);
  const zero = mediaTime(0n, unit);
  const error = rescale(REPORTED_TIME_ERROR, unit);
  const startTolerance = add(position, rescale(fromSeconds(CLIENT_RANGE_START_TOLERANCE_SECONDS), unit));
  const held = [];
  for (const range of ranges) {
    const reportedStart = rescale(range.start, unit);
    let start = latest(zero, subtract(reportedStart, error));
    if (compare(reportedStart, position) > 0 && compare(reportedStart, startTolerance) <= 0) {
      start = position;
    }
    const end = add(rescale(range.end, unit), error);
    const inside = pieces.filter((piece) => contains([{ start, end }], piece.start, piece.end));
    addMediaRange(held, { start, end, frame: latest(zero, ...inside.map(({ frame }) => frame)) });
  }
  return held;
}

/**
 * The pieces of a track this forecast reads: those still to play (ending after
 * `position`), the first piece, every piece that has been read and every piece
 * that is made. A piece that is none of these changes no answer: it is not
 * scheduled, it is not where the track starts, no unread piece is placed by it
 * (only read pieces are), it lends no frame to what the page holds, and it has
 * no size to measure the output's rate by.
 *
 * @param {{ segments: object[], readySegmentIndices?: number[] }} track
 * @param {number} position - Seconds.
 * @returns {object[]}
 */
function piecesThatMatter(track, position) {
  const made = new Set(Array.isArray(track.readySegmentIndices) ? track.readySegmentIndices : []);
  const kept = track.segments.filter((segment) => segment?.index === 0 || segment?.mediaRanges !== undefined ||
    made.has(segment?.index) || !(Number.isFinite(segment?.endSeconds) && segment.endSeconds <= position));
  return kept.length === track.segments.length ? track.segments : kept;
}

/**
 * The exact times of a piece's playlist edges, converted once per piece and
 * kept with it: the playlist's cut times do not change between polls, and
 * converting them again on every one was a fifth of the forecast's time.
 *
 * @type {WeakMap<object, { startSeconds: number, endSeconds: number, start: import("./media-time.js").MediaTime | null, end: import("./media-time.js").MediaTime | null }>}
 */
const exactBounds = new WeakMap();

function exactTimesOf(segment) {
  let bounds = exactBounds.get(segment);
  if (!bounds || bounds.startSeconds !== segment.startSeconds || bounds.endSeconds !== segment.endSeconds) {
    bounds = {
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      start: Number.isFinite(segment.startSeconds) ? fromSeconds(segment.startSeconds) : null,
      end: Number.isFinite(segment.endSeconds) ? fromSeconds(segment.endSeconds) : null
    };
    exactBounds.set(segment, bounds);
  }
  return bounds;
}

/** The exact edges a piece carries from the forecast, or converts once. */
function timesOf(segment) {
  return segment.exact ?? exactTimesOf(segment);
}

/**
 * WHAT A TRACK'S PIECES GIVE THE FORECAST'S TIME, KEPT BETWEEN POLLS while
 * they are the same pieces. The forecast runs on every poll of a waiting
 * viewer, and gathering the edges of every remaining piece for the timescale,
 * then placing each on the page's clock, was about 3 s of the proxy's main
 * thread in r35's first 15 minutes on Home Assistant (torrent-tv/meta#178).
 * `track.geometry` is kept by whoever keeps the pieces; without it nothing is
 * kept, and the answer is the same either way: a placement is reused only for
 * pieces with the same edges and read ranges, the same timescale and the same
 * clock offset, so no time is rounded for the reuse. Only the times are kept: a
 * piece whose torrent inputs were told again is a new object with the same
 * times, and it is read with its inputs of this poll. In r37 most polls placed
 * every piece again, the MPEG-TS output having no read ranges to keep them by.
 *
 * @param {{ segments?: object[], geometry?: object }} track
 * @returns {bigint} The least timescale holding every edge and every served tick of its pieces.
 */
function timescaleOfPieces(track) {
  const segments = Array.isArray(track.segments) ? track.segments : [];
  const geometry = track.geometry;
  const changed = geometry ? piecesChanged(geometry.pieces, segments) : null;
  if (geometry && changed === null) return geometry.timescale;
  if (geometry) geometry.reason = changed;
  const distinct = new Set();
  for (const segment of segments) {
    if (segment.mediaRanges?.timescale) distinct.add(segment.mediaRanges.timescale);
    const { start, end } = exactTimesOf(segment);
    if (start) distinct.add(start.timescale);
    if (end) distinct.add(end.timescale);
  }
  const timescale = commonTimescale([...distinct].map((value) => mediaTime(0n, value)));
  if (geometry) {
    geometry.pieces = segments.map((segment) => ({ index: segment.index, startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds, mediaRanges: segment.mediaRanges }));
    geometry.timescale = timescale;
    geometry.placed = null;
  }
  return timescale;
}

/**
 * A track's pieces on the page's clock in `unit`: read pieces at their served
 * ranges, the others placed between them. The times are reused while the
 * pieces are those {@link timescaleOfPieces} last took and `unit` and `clock`
 * are the same; everything else of a piece is this poll's.
 *
 * @param {{ segments?: object[], geometry?: object }} track
 * @param {import("./media-time.js").MediaTime} clock - In `unit`.
 * @param {bigint} unit
 */
function placedPieces(track, clock, unit) {
  const geometry = track.geometry;
  const segments = Array.isArray(track.segments) ? track.segments : [];
  let times = geometry?.placed && geometry.placedUnit === unit && geometry.placedClock === clock.ticks ? geometry.placed : null;
  if (geometry) geometry.reason = times ? "kept" : !geometry.placed ? geometry.reason ?? "first" : geometry.placedUnit !== unit ? "timescale" : "clock";
  if (!times) {
    times = predictedMediaSegments(segments.map((segment) => ({
      ...segment, exact: exactTimesOf(segment), ranges: playerRanges(segment.mediaRanges, clock, unit)
    })), unit).map(({ exact, ranges }) => ({ exact, ranges }));
    if (geometry) Object.assign(geometry, { placed: times, placedUnit: unit, placedClock: clock.ticks });
  }
  return segments.map((segment, index) => ({ ...segment, exact: times[index].exact, ranges: times[index].ranges }));
}

/**
 * How `segments` differ from the pieces `kept` recorded, by the first field
 * their times come from that differs, or null when they are the same pieces.
 *
 * @returns {"first" | "count" | "index" | "edges" | "read ranges" | null}
 */
function piecesChanged(kept, segments) {
  if (!Array.isArray(kept)) return "first";
  if (kept.length !== segments.length) return "count";
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index], was = kept[index];
    if (segment.index !== was.index) return "index";
    if (segment.startSeconds !== was.startSeconds || segment.endSeconds !== was.endSeconds) return "edges";
    if (segment.mediaRanges !== was.mediaRanges) return "read ranges";
  }
  return null;
}

/**
 * `coverage` (sorted, joined; this forecast's own list) with `range` added in
 * place, as `numericCoverage` of the whole list would give it: found by halves,
 * joined with every neighbour it reaches or touches. Bytes held further on —
 * a piece of the file read for another viewer — sit after the place pieces are
 * added in media order, so adding only at the end did not hold.
 */
function withCoverage(coverage, range) {
  let low = 0, high = coverage.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (coverage[middle].end < range.start) low = middle + 1;
    else high = middle;
  }
  const joined = { start: range.start, end: range.end };
  let last = low;
  while (last < coverage.length && coverage[last].start <= joined.end) {
    joined.start = Math.min(joined.start, coverage[last].start);
    joined.end = Math.max(joined.end, coverage[last].end);
    last += 1;
  }
  coverage.splice(low, last - low, joined);
  return coverage;
}

/** `arrivals` (this forecast's own list) with `range` indexed, as `indexedArrivals` of the whole list would give it. */
function withArrival(arrivals, range, all) {
  if (!(range.finish > 0)) return arrivals;
  const last = arrivals.at(-1);
  if (!last || range.start > last.start || (range.start === last.start && range.end >= last.end)) {
    arrivals.push({ ...range, maximumEnd: Math.max(last?.maximumEnd ?? 0, range.end) });
    return arrivals;
  }
  return indexedArrivals(all);
}

/** Coverage is joined once per resource, independently of arrival times. */
function numericCoverage(ranges) {
  const joined = [];
  for (const range of [...ranges].sort((left, right) => left.start - right.start || left.end - right.end)) {
    const previous = joined.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else joined.push({ start: range.start, end: range.end });
  }
  return joined;
}

/** Already held bytes have no arrival delay. Index future arrivals once. */
function indexedArrivals(ranges) {
  let maximumEnd = 0;
  return ranges.filter(range => range.finish > 0)
    .sort((left, right) => left.start - right.start || left.end - right.end)
    .map(range => ({ ...range, maximumEnd: maximumEnd = Math.max(maximumEnd, range.end) }));
}

function latestArrival(interval, ranges = []) {
  let low = 0, high = ranges.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ranges[middle].maximumEnd <= interval.start) low = middle + 1;
    else high = middle;
  }
  let finish = 0;
  for (let index = low; index < ranges.length && ranges[index].start < interval.end; index++) {
    if (ranges[index].end > interval.start) finish = Math.max(finish, ranges[index].finish);
  }
  return finish;
}

/** A piece that reads no source byte still to arrive; never written to. */
const NO_SOURCE_BYTES = new Map();

/**
 * Whether the source named at `place` of a piece's sources — the track's own,
 * then those its inputs name — was named at an earlier place.
 */
function namedBefore(sourceId, place, trackSources, exactInputs) {
  for (let earlier = 0; earlier < place; earlier += 1) {
    const named = earlier < trackSources.length ? trackSources[earlier]
      : exactInputs[earlier - trackSources.length]?.sourceId;
    if (named === sourceId) return true;
  }
  return false;
}

/**
 * The byte ranges a piece reads of one source, in the order its inputs state
 * them, or null when an input of that source states none or one that is not a
 * non-empty run of whole bytes.
 */
function inputRangesOf(exactInputs, sourceId) {
  let ranges = null;
  for (const input of exactInputs) {
    if (input?.sourceId !== sourceId) continue;
    if (!Array.isArray(input.ranges) || input.ranges.length === 0) return null;
    for (const range of input.ranges) {
      if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
          range.start < 0 || range.end <= range.start) return null;
    }
    ranges = ranges === null ? input.ranges : ranges.concat(input.ranges);
  }
  return ranges;
}

/** Exact gaps in sorted disjoint numeric coverage, without per-range splitting. */
function uncoveredIntervals(interval, served) {
  let low = 0, high = served.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (served[middle].end <= interval.start) low = middle + 1;
    else high = middle;
  }
  const missing = [];
  let cursor = interval.start;
  for (let index = low; index < served.length && cursor < interval.end; index++) {
    const held = served[index];
    if (held.start >= interval.end) break;
    if (held.start > cursor) missing.push({ start: cursor, end: held.start });
    cursor = Math.max(cursor, held.end);
  }
  if (cursor < interval.end) missing.push({ start: cursor, end: interval.end });
  return missing;
}

/** Expand missing file bytes to the whole torrent pieces the reader must hold. */
function sourcePiecesFor(ranges, source) {
  const pieces = [];
  for (const range of ranges) {
    if (!(range.end > range.start)) continue;
    const first = Math.floor((source.fileOffset + range.start) / source.pieceLength);
    const last = Math.ceil((source.fileOffset + range.end) / source.pieceLength) - 1;
    for (let index = first; index <= last; index += 1) {
      const start = Math.max(0, index * source.pieceLength - source.fileOffset);
      const end = Math.min(source.fileLength, (index + 1) * source.pieceLength - source.fileOffset);
      if (end > start) pieces.push({ start, end });
    }
  }
  return numericCoverage(pieces);
}

/**
 * Ranges for pieces not read yet, placed in the clock of the pieces that were.
 * A cut time of the playlist is mapped linearly between the nearest measured
 * pieces around it, exactly, so neighbouring predictions share their boundary
 * and meet the measured pieces at their own edges. A predicted time is put on
 * the forecast's nearest tick; a measured edge is already one, so the
 * prediction still meets it exactly. A prediction says nothing about the frames
 * inside it, so its `frame` is zero.
 */
function predictedMediaSegments(segments, unit) {
  const zero = mediaTime(0n, unit);
  // In order of index, searched by halves: each unread piece looked through
  // every read one for its neighbours, a cost of pieces times read pieces.
  const anchors = segments.filter(({ ranges }) => ranges?.length > 0)
    .sort((left, right) => left.index - right.index);
  const firstAfter = (index) => {
    let low = 0, high = anchors.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (anchors[middle].index <= index) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  return segments.map((segment) => {
    if (segment.ranges !== undefined) return segment;
    const times = timesOf(segment);
    if (anchors.length === 0) {
      return { ...segment, ranges: [{ start: rescale(times.start, unit), end: rescale(times.end, unit), frame: zero }] };
    }
    const after = firstAfter(segment.index);
    let before = after - 1;
    while (before >= 0 && anchors[before].index >= segment.index) before -= 1;
    const previous = before >= 0 ? anchors[before] : undefined;
    const next = anchors[after];
    const nominalLeft = previous ? timesOf(previous).end : timesOf(next).start;
    const actualLeft = previous?.ranges.at(-1).end ?? next.ranges[0].start;
    const nominalRight = next ? timesOf(next).start : nominalLeft;
    const actualRight = next?.ranges[0].start ?? actualLeft;
    const nominalSpan = subtract(nominalRight, nominalLeft);
    // `nearest(actualLeft + fromLeft * (actualRight - actualLeft) / nominalSpan)`
    // in ticks of `unit`, as one fraction: both actual edges are already whole
    // ticks of it, so only the scaled part is rounded, and no common
    // denominator is sought for every piece (most of the forecast's time).
    const actualSpan = actualRight.ticks - actualLeft.ticks;
    const place = (time) => {
      const fromLeft = subtract(time, nominalLeft);
      const [numerator, denominator] = nominalSpan.ticks > 0n
        ? [fromLeft.ticks * nominalSpan.timescale * actualSpan, fromLeft.timescale * nominalSpan.ticks]
        : [fromLeft.ticks * unit, fromLeft.timescale];
      return { ticks: actualLeft.ticks + roundedHalfUp(numerator, denominator), timescale: unit };
    };
    return { ...segment, ranges: [{ start: place(times.start), end: place(times.end), frame: zero }] };
  });
}

/** `numerator / denominator` to the nearest whole number, halves up, as `nearest` rounds; `denominator` positive. */
function roundedHalfUp(numerator, denominator) {
  const quotient = numerator / denominator;
  const floor = numerator - quotient * denominator < 0n ? quotient - 1n : quotient;
  return 2n * (numerator - floor * denominator) >= denominator ? floor + 1n : floor;
}

/**
 * @param {*} readings - A summary (`RateTrend.snapshot`) or the readings themselves.
 * @param {number} now
 * @param {"last" | "piece" | "time"} [weighting] - Which rate the readings
 *   stand for: the last one; work per working time where each reading is one
 *   piece of film; or quantity per wall time where each reading holds until
 *   the next.
 */
function rateCurve(readings, now, weighting = "last") {
  if (readings && Number.isFinite(readings.count) && readings.count > 0 &&
    Number.isFinite(readings.lastAt) && Number.isFinite(readings.lastValue) &&
    Number.isFinite(readings.meanValue) && Number.isFinite(readings.spanSeconds)) {
    return rateCurveFrom(readings, weighting);
  }
  const ordered = (Array.isArray(readings) ? readings : [])
    .filter((reading) => Number.isFinite(reading?.at) && Number.isFinite(reading?.value) && reading.value >= 0)
    .filter((reading) => reading.at <= now)
    .sort((left, right) => left.at - right.at)
    .filter((reading, index, all) => index === 0 || reading.at !== all[index - 1].at);
  if (ordered.length === 0) {
    return null;
  }

  return rateCurveFrom(summarizeRate(ordered), weighting);
}

function summarizeRate(readings) {
  const latest = readings.at(-1);
  let weighted = 0;
  for (let index = 0; index + 1 < readings.length; index += 1) {
    weighted += readings[index].value * (readings[index + 1].at - readings[index].at);
  }
  const spanMs = latest.at - readings[0].at;
  return {
    count: readings.length,
    lastAt: latest.at,
    lastValue: latest.value,
    meanValue: readings.reduce((sum, reading) => sum + reading.value, 0) / readings.length,
    // Each reading one piece of work: work over the time it took.
    harmonicValue: readings.some(reading => !(reading.value > 0)) ? 0
      : readings.length / readings.reduce((sum, reading) => sum + 1 / reading.value, 0),
    // Each reading holding until the next: quantity over the span.
    timeWeightedValue: spanMs > 0 ? weighted / spanMs : latest.value,
    spanSeconds: spanMs / 1000
  };
}

function rateCurveFrom(summary, weighting = "last") {
  // Conditional projection of the measured service. No exponential
  // relaxation, smoothing time, slope extrapolation or guessed recovery.
  // A new measurement changes the integral; polling does not change its rate.
  const value = weighting === "piece" && Number.isFinite(summary.harmonicValue) ? summary.harmonicValue
    : weighting === "time" && Number.isFinite(summary.timeWeightedValue) ? summary.timeWeightedValue
      : summary.lastValue;
  const rate = Math.max(0, value);
  const workBy = (seconds) => rate * Math.max(0, seconds);
  return {
    rateAt: () => rate,
    workBy,
    finish: (work, startAt) => {
      const start = Math.max(0, startAt);
      return start + (work > 0 ? work / rate : 0);
    }
  };
}

function averageBitsPerMediaSecond(track, segments, ready) {
  let bits = 0;
  let mediaSeconds = 0;
  for (const segment of segments) {
    if (!ready.has(segment.index)) {
      continue;
    }
    const bytes = sizeOf(track.segmentSizesBytes, segment.index);
    const seconds = segment.endSeconds - segment.startSeconds;
    if (bytes > 0 && seconds > 0) {
      bits += bytes * 8;
      mediaSeconds += seconds;
    }
  }
  if (mediaSeconds > 0) {
    return bits / mediaSeconds;
  }
  return finiteNonNegative(track.bitsPerMediaSecond);
}

function sizeOf(sizes, index) {
  if (sizes instanceof Map) {
    return finiteNonNegative(sizes.get(index));
  }
  return finiteNonNegative(sizes?.[index]);
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function result(ready, delaySeconds, bufferedSeconds, reserveSeconds, neededSeconds, reason, preparedSegments,
  bufferedAtStartSeconds = null) {
  return {
    version: 1,
    ready,
    delaySeconds,
    bufferedSeconds,
    reserveSeconds,
    neededSeconds,
    reason,
    preparedSegments,
    bufferedAtStartSeconds
  };
}
