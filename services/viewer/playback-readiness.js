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
  scale,
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
export function forecastRate(readings, now = Date.now(), horizonSeconds = 0) {
  const curve = rateCurve(readings, now);
  if (!curve) {
    return null;
  }
  const horizon = Number.isFinite(horizonSeconds) ? Math.max(0, horizonSeconds) : 0;
  return horizon > 0 ? curve.workBy(horizon) / horizon : curve.rateAt(0);
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
  const tracks = Array.isArray(input.tracks) ? input.tracks : [];
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
  // ticks, so that adding and comparing never seek a common denominator.
  const unit = commonTimescale([
    fromSeconds(finiteNonNegative(input.positionSeconds)), fromSeconds(duration),
    fromSeconds(finiteNonNegative(input.bufferedAheadSeconds)), REPORTED_TIME_ERROR, ...clocks,
    ...reported.flatMap((ranges) => (ranges ?? []).flatMap(({ start, end }) => [start, end])),
    ...tracks.flatMap((track) => (Array.isArray(track.segments) ? track.segments : []).flatMap((segment) => [
      ...(segment.mediaRanges?.timescale ? [mediaTime(0n, segment.mediaRanges.timescale)] : []),
      ...[segment.startSeconds, segment.endSeconds].filter(Number.isFinite).map(fromSeconds)
    ]))
  ]);
  const zero = mediaTime(0n, unit);
  const segmentsOf = tracks.map((track, trackIndex) => predictedMediaSegments(
    (Array.isArray(track.segments) ? track.segments : []).map((segment) => ({
      ...segment, ranges: playerRanges(segment.mediaRanges, rescale(clocks[trackIndex], unit), unit)
    })), unit));
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
    curve: rateCurve(track.readings, now),
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
      service = { rate: rateCurve(source.downloadRateReadings, now), finish: 0 };
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
    for (const segment of segments) {
      // Media the page already holds is not transferred again.
      const needed = segment.ranges.filter((range) => compare(range.end, at) > 0);
      if (segment.ranges.length > 0 && needed.every((range) =>
        contains(state.clientRanges, latest(range.start, at), range.end))) {
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

      const sourceByteIntervals = new Map();
      if (!produced && encodeWork > 0) {
        const exactInputs = Array.isArray(segment.sourceInputs) ? segment.sourceInputs : null;
        const requiredSources = new Set([
          ...(Array.isArray(track.sourceIds) ? track.sourceIds : []),
          ...(exactInputs ?? []).map(input => input?.sourceId)
        ]);
        for (const sourceId of requiredSources) {
          const source = sourceState.get(sourceId);
          if (!source) {
            unknownReason ??= "source-measurement-unavailable";
          } else if (source.source.complete !== true) {
            if (exactInputs) {
              const inputs = exactInputs.filter(input => input?.sourceId === sourceId);
              const ranges = inputs.flatMap(input => Array.isArray(input.ranges) ? input.ranges : []);
              if (!ranges.length || inputs.some(input => !Array.isArray(input.ranges) || !input.ranges.length) ||
                  ranges.some(range => !range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end <= range.start)) {
                unknownReason ??= "source-input-ranges-unavailable";
              } else sourceByteIntervals.set(sourceId, ranges);
              continue;
            }
            unknownReason ??= "source-input-ranges-unavailable";
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
        const arrival = Math.max(0, (range.availableAt - now) / 1000);
        // The entire protocol piece becomes readable after verification;
        // bytes inside it never arrive proportionally to their file address.
        sourceByteService.get(id).push({ start: range.start, end: range.end, begin: arrival, finish: arrival });
      }
    }
  }
  const trackFinish = trackState.map(({ track }) => finiteNonNegative(track.startupRemainingSeconds));
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
            service.push({ start: part.start, end: part.end, begin: finish, finish });
            sourceArrivalAt = Math.max(sourceArrivalAt, finish);
          }
          sourceByteCoverage.set(sourceId, numericCoverage(service));
          sourceArrivals.set(sourceId, indexedArrivals(service));
        }
        sourceService.finish = finish;
      }
    }
    // Production accepts a complete held segment input. It cannot overlap its
    // own source download; reused input retains its original arrival time.
    const processing = trackState[trackIndex].curve;
    const admittedAt = Math.max(trackFinish[trackIndex], sourceArrivalAt);
    const producedAt = job.produced || encodeWork === 0 ? 0 : processing.finish(encodeWork, admittedAt);
    trackFinish[trackIndex] = Math.max(trackFinish[trackIndex], producedAt);
    productions.push({ at: producedAt, trackIndex, segment, requiresSource: sourceArrivalAt > 0 });
    const deliveryAt = link.finish(sizeBits, Math.max(transferFinish, producedAt));
    transferFinish = deliveryAt;
    completions.push({ at: deliveryAt + finiteNonNegative(track.appendSeconds), trackIndex, segment });
  }

  const constraints = [];
  const end = rescale(fromSeconds(duration), unit);
  for (let trackIndex = 0; trackIndex < trackState.length; trackIndex += 1) {
    const state = trackState[trackIndex];
    const delivered = state.clientRanges.map((range) => ({ ...range }));
    const prepared = state.clientRanges.map((range) => ({ ...range }));
    const lastRange = state.segments.at(-1).ranges.at(-1);
    const trackEnd = lastRange ? earliest(end, lastRange.end) : end;
    for (const completion of completions.filter((item) => item.trackIndex === trackIndex)) {
      const before = contiguousEnd(delivered, at);
      for (const range of completion.segment.ranges) addMediaRange(delivered, range);
      const after = contiguousEnd(delivered, at);
      constraints.push(completion.at - secondsAhead(earliest(before, trackEnd), at));
      if (compare(after, before) <= 0 && completion.segment.ranges.some(({ start }) => compare(start, before) > 0)) {
        // A timestamp hole cannot be repaired by waiting longer. Keep it
        // distinct from an unavailable rate or a slow but finite service.
        return result(false, null, buffered, reserve, null, 'media-continuity-unavailable', preparedSegments);
      }
    }
    if (compare(contiguousEnd(delivered, at), trackEnd) < 0) {
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
      constraints.push(production.at - Math.max(0, secondsAhead(before, at) -
        Math.min(reserve, secondsAhead(trackEnd, before)) * Number(production.requiresSource)));
    }
  }
  const delay = Math.max(0, ...constraints);
  const originReady = trackState.every(({ clientRanges }) => compare(contiguousEnd(clientRanges, at), at) > 0);
  const ready = delay === 0 && originReady;
  const forecast = result(ready, Number.isFinite(delay) ? delay : null, buffered, reserve,
    Math.max(0, reserve - buffered), ready ? 'trajectory-safe-now' :
      Number.isFinite(delay) ? 'minimum-safe-delay' : 'service-not-advancing', preparedSegments);
  return { ...forecast, measuredAt: now, predictedStartAt: Number.isFinite(delay) ? now + delay * 1000 : null,
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
  const anchors = segments.filter(({ ranges }) => ranges?.length > 0);
  return segments.map((segment) => {
    if (segment.ranges !== undefined) return segment;
    if (anchors.length === 0) {
      return { ...segment, ranges: [{ start: rescale(fromSeconds(segment.startSeconds), unit),
        end: rescale(fromSeconds(segment.endSeconds), unit), frame: zero }] };
    }
    const previous = anchors.findLast(({ index }) => index < segment.index);
    const next = anchors.find(({ index }) => index > segment.index);
    const nominalLeft = fromSeconds(previous?.endSeconds ?? next.startSeconds);
    const actualLeft = previous?.ranges.at(-1).end ?? next.ranges[0].start;
    const nominalRight = next ? fromSeconds(next.startSeconds) : nominalLeft;
    const actualRight = next?.ranges[0].start ?? actualLeft;
    const nominalSpan = subtract(nominalRight, nominalLeft);
    const place = (seconds) => {
      const fromLeft = subtract(fromSeconds(seconds), nominalLeft);
      return nearest(add(actualLeft, nominalSpan.ticks > 0n
        ? scale(fromLeft, subtract(actualRight, actualLeft), nominalSpan)
        : fromLeft), unit);
    };
    return { ...segment, ranges: [{ start: place(segment.startSeconds), end: place(segment.endSeconds), frame: zero }] };
  });
}

function rateCurve(readings, now) {
  if (readings && Number.isFinite(readings.count) && readings.count > 0 &&
    Number.isFinite(readings.lastAt) && Number.isFinite(readings.lastValue) &&
    Number.isFinite(readings.meanValue) && Number.isFinite(readings.spanSeconds)) {
    return rateCurveFrom(readings, now);
  }
  const ordered = (Array.isArray(readings) ? readings : [])
    .filter((reading) => Number.isFinite(reading?.at) && Number.isFinite(reading?.value) && reading.value >= 0)
    .filter((reading) => reading.at <= now)
    .sort((left, right) => left.at - right.at)
    .filter((reading, index, all) => index === 0 || reading.at !== all[index - 1].at);
  if (ordered.length === 0) {
    return null;
  }

  return rateCurveFrom(summarizeRate(ordered), now);
}

function summarizeRate(readings) {
  const latest = readings.at(-1);
  return {
    count: readings.length,
    lastAt: latest.at,
    lastValue: latest.value,
    meanValue: readings.reduce((sum, reading) => sum + reading.value, 0) / readings.length,
    spanSeconds: (latest.at - readings[0].at) / 1000
  };
}

function rateCurveFrom({ lastValue }) {
  // Conditional projection of the current measured service. No exponential
  // relaxation, smoothing time, slope extrapolation or guessed recovery.
  // A new measurement changes the integral; polling does not change its rate.
  const rate = Math.max(0, lastValue);
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
