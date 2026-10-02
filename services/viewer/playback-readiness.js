/**
 * Predict the minimum delay before playback can run to the end without
 * exhausting the continuous media available for the required tracks.
 *
 * This module contains the playback decision's only model. Its inputs are
 * measurements and physical limits: source bytes and download rate, encoded
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
 * @param {Array<{ id: string, serviceId?: string, complete: boolean, bytesPerMediaSecond: number,
 *   readings: Array<{ at: number, value: number }> }>} input.sources
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
  const segmentsOf = tracks.map((track, trackIndex) =>
    (Array.isArray(track.segments) ? track.segments : []).map((segment) => ({
      ...segment, ranges: playerRanges(segment.mediaRanges, rescale(clocks[trackIndex], unit), unit)
    })));
  const origin = latest(zero, ...segmentsOf.map((segments) =>
    segments.find(({ index }) => index === 0)?.ranges?.[0]?.start ?? zero));
  const at = latest(origin, rescale(fromSeconds(finiteNonNegative(input.positionSeconds)), unit));
  const position = toSeconds(at);
  const remaining = Math.max(0, duration - position);
  const measuredRanges = reported.map((ranges, trackIndex) => ranges ?
    heldRanges(ranges, segmentsOf[trackIndex], unit) : null);
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
    segments: predictedMediaSegments(segmentsOf[trackIndex], unit)
      .filter((segment) => Number.isInteger(segment?.index) &&
        Number.isFinite(segment?.startSeconds) && Number.isFinite(segment?.endSeconds) &&
        segment.endSeconds > segment.startSeconds && segment.endSeconds > position)
      .sort((left, right) => left.startSeconds - right.startSeconds || left.index - right.index)
  }));
  if (trackState.some(({ segments }) => segments.length === 0)) {
    return result(false, null, buffered, reserve, null, "timeline-unavailable", 0);
  }
  const sourceState = new Map();
  const downloadServices = new Map();
  for (const [id, source] of sources) {
    const serviceId = typeof source.serviceId === "string" ? source.serviceId : id;
    const service = downloadServices.get(serviceId);
    if (!service || (!service.curve && source.complete !== true)) {
      downloadServices.set(serviceId, {
        curve: source.complete === true ? null : rateCurve(source.readings, now)
      });
    }
    sourceState.set(id, {
      source,
      serviceId
    });
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
      const remainingProcessing = uncoveredIntervals({ start: workStart, end: segment.endSeconds },
        (Array.isArray(track.processingRanges) ? track.processingRanges : []).filter((range) =>
          Number.isFinite(range?.start) && Number.isFinite(range?.end) && range.end > range.start));
      const encodeWork = produced ? 0 : remainingProcessing.reduce((sum, part) => sum + part.end - part.start, 0);

      const sourceIntervals = new Map();
      if (!produced && encodeWork > 0) {
        for (const sourceId of Array.isArray(track.sourceIds) ? new Set(track.sourceIds) : []) {
          const source = sourceState.get(sourceId);
          if (!source) {
            unknownReason ??= "source-measurement-unavailable";
          } else if (source.source.complete !== true) {
            const bytesPerMediaSecond = Number(source.source.bytesPerMediaSecond);
            if (!(bytesPerMediaSecond > 0)) {
              unknownReason ??= "download-rate-unavailable";
            } else {
              sourceIntervals.set(sourceId, remainingProcessing);
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
        remainingProcessing,
        sourceIntervals,
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
  const sourceFinish = new Map([...downloadServices.keys()].map((id) => [id, 0]));
  const sourceMediaService = new Map();
  for (const [id, { source }] of sourceState) {
    const density = Number(source.bytesPerMediaSecond);
    if (density > 0 && Array.isArray(source.residence)) {
      // Initial time-to-byte mapping uses measured file-average density.
      // Held bytes are not downloaded again. Reading costs are already
      // included in effective processing speed, rather than charged twice.
      sourceMediaService.set(id, source.residence.filter(({ location, start, end }) =>
        location !== "missing" && Number.isFinite(start) && Number.isFinite(end) && end > start)
        .map(({ start, end }) => ({ start: start / density, end: end / density, begin: 0, finish: 0 })));
    }
  }
  const trackFinish = trackState.map(({ track }) => finiteNonNegative(track.startupRemainingSeconds));
  let transferFinish = 0;
  const completions = [];
  const productions = [];
  for (const job of jobs) {
    const { track, trackIndex, segment, sizeBits, encodeWork, sourceIntervals, remainingProcessing } = job;
    const sourceArrivals = [];
    for (const [sourceId, interval] of [...sourceIntervals].flatMap(([id, ranges]) =>
      ranges.map((range) => [id, range]))) {
      const source = sourceState.get(sourceId);
      const served = sourceMediaService.get(sourceId) ?? [];
      for (const part of uncoveredIntervals(interval, served)) {
        const supply = downloadServices.get(source.serviceId)?.curve;
        if (!supply) return result(false, null, buffered, reserve, null, "download-rate-unavailable", preparedSegments);
        const begin = sourceFinish.get(source.serviceId) ?? 0;
        const end = supply.finish(
          (part.end - part.start) * Number(source.source.bytesPerMediaSecond), begin);
        sourceFinish.set(source.serviceId, end);
        served.push({ ...part, begin, finish: end });
      }
      sourceMediaService.set(sourceId, served);
      sourceArrivals.push(...served.filter((part) => part.end > interval.start && part.start < interval.end)
        .flatMap((part) => [Math.max(part.start, interval.start), Math.min(part.end, interval.end)]
          .map((media) => ({ media, at: media === part.start ? part.begin : part.begin +
            (part.finish - part.begin) * (media - part.start) / (part.end - part.start) }))));
    }
    // Max-plus composition of fluid arrival and processing. Between measured
    // boundaries both are linear, so their supremum occurs at an endpoint.
    // Reused input keeps its original arrival times; it is neither downloaded
    // twice nor charged the queue start of a later request.
    const processing = trackState[trackIndex].curve;
    const producedAt = job.produced || encodeWork === 0 ? 0 : Math.max(
      processing.finish(encodeWork, trackFinish[trackIndex]),
      ...sourceArrivals.map(({ media, at }) => processing.finish(
        remainingProcessing.reduce((sum, part) => sum + Math.max(0, part.end - Math.max(part.start, media)), 0), at)));
    trackFinish[trackIndex] = Math.max(trackFinish[trackIndex], producedAt);
    productions.push({ at: producedAt, trackIndex, segment, requiresSource: sourceArrivals.some(({ at }) => at > 0) });
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
function heldRanges(ranges, segments, unit) {
  const pieces = segments.flatMap((segment) => segment.ranges ?? []);
  const zero = mediaTime(0n, unit);
  const error = rescale(REPORTED_TIME_ERROR, unit);
  const held = [];
  for (const range of ranges) {
    const start = latest(zero, subtract(rescale(range.start, unit), error));
    const end = add(rescale(range.end, unit), error);
    const inside = pieces.filter((piece) => contains([{ start, end }], piece.start, piece.end));
    addMediaRange(held, { start, end, frame: latest(zero, ...inside.map(({ frame }) => frame)) });
  }
  return held;
}

function uncoveredIntervals(interval, served) {
  let remaining = [{ ...interval }];
  for (const held of served) {
    remaining = remaining.flatMap((part) => held.end <= part.start || held.start >= part.end ? [part] : [
      { start: part.start, end: Math.min(part.end, held.start) },
      { start: Math.max(part.start, held.end), end: part.end }
    ].filter(({ start, end }) => end > start));
  }
  return remaining;
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
