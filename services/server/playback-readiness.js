/**
 * Predict the minimum delay before playback can run to the end without
 * exhausting the browser buffer.
 *
 * This module contains the playback decision's only model. Its inputs are
 * measurements and physical limits: source bytes and download rate, encoded
 * media and encoder rate, segment sizes and client-link rate, the existing
 * browser buffer, its capacity, the proxy look-ahead, and the measured reserve
 * for interruptions. A measured rate relaxes toward the lower of its latest
 * value and its observed mean over the measurement span. Its integral remains
 * unbounded for a positive measured rate; an old slope cannot invent a permanent
 * cessation of service. There are no fitted weights or rate multipliers.
 */

/**
 * The mean rate predicted over a horizon by the integral of the measured rate.
 * Every supplied measurement contributes equally to the observed mean.
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
 *   segments: Array<{ index: number, startSeconds: number, endSeconds: number }>,
 *   readySegmentIndices: number[], segmentSizesBytes: Map<number, number> | object }>} input.tracks
 * @param {Array<{ at: number, value: number }>} input.linkReadings - Bits/s.
 * @returns {object}
 */
export function predictPlaybackReadiness(input = {}) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const tracks = Array.isArray(input.tracks) ? input.tracks : [];
  const mediaOrigin = Math.max(0, ...tracks.map((track) =>
    track.segments?.find(({ index }) => index === 0)?.mediaRanges?.[0]?.start ?? 0));
  const position = Math.max(mediaOrigin, finiteNonNegative(input.positionSeconds));
  const duration = finiteNonNegative(input.durationSeconds);
  const remaining = Math.max(0, duration - position);
  const measuredRanges = tracks.map((track) => Array.isArray(track.clientRanges) ?
    normalizedRanges(track.clientRanges) : null);
  const buffered = measuredRanges.length > 0 && measuredRanges.every(Boolean) ?
    Math.max(0, Math.min(...measuredRanges.map((ranges) => contiguousEnd(ranges, position) - position))) :
    finiteNonNegative(input.bufferedAheadSeconds);
  // A loader target can be lowered after a fragment retry. Bytes already held
  // prove a larger capacity, even when an older page reports only that target.
  const capacity = Math.max(buffered, finiteNonNegative(input.bufferLimitSeconds),
    ...measuredRanges.map((ranges) => ranges ? ranges.reduce((total, range) =>
      total + Math.max(0, range.end - Math.max(position, range.start)), 0) : 0));
  const reserve = Math.min(remaining, finiteNonNegative(input.reserveSeconds));
  const lookahead = finiteNonNegative(input.lookaheadSeconds);
  const sources = new Map((Array.isArray(input.sources) ? input.sources : [])
    .filter((source) => typeof source?.id === "string")
    .map((source) => [source.id, source]));
  if (remaining <= buffered) {
    return result(true, 0, buffered, reserve, 0, "client-buffer-covers-end", 0);
  }
  if (!(duration > 0) || !(capacity > 0) || tracks.length === 0) {
    return result(false, null, buffered, reserve, null, "incomplete-state", 0);
  }
  const requiredTracks = input.requiredAudio === true ? 2 : 1;
  if (tracks.length < requiredTracks) {
    return result(false, null, buffered, reserve, null, "separate-audio-not-observed", 0);
  }
  if (tracks.some((track) => !Array.isArray(track.segments) || track.segments.length === 0)) {
    return result(false, null, buffered, reserve, null, "timeline-unavailable", 0);
  }

  const trackState = tracks.map((track) => ({
    track,
    clientRanges: Array.isArray(track.clientRanges) ? normalizedRanges(track.clientRanges) :
      [{ start: position, end: position + buffered }],
    ready: new Set(Array.isArray(track.readySegmentIndices) ? track.readySegmentIndices : []),
    curve: rateCurve(track.readings, now),
    bitsPerMediaSecond: averageBitsPerMediaSecond(track, track.segments,
      new Set(Array.isArray(track.readySegmentIndices) ? track.readySegmentIndices : [])),
    segments: predictedMediaSegments(track.segments)
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
      if (coveredSeconds(state.clientRanges, Math.max(position, segment.startSeconds), segment.endSeconds) >=
        segment.endSeconds - Math.max(position, segment.startSeconds) - Number.EPSILON * duration) {
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
      // Global encode progress may belong to another run beyond a missing
      // segment. Only publication proves this segment's work is complete.
      const workStart = Math.max(position, segment.startSeconds);
      const encodeWork = produced ? 0 : Math.max(0, segment.endSeconds - workStart);
      if (!produced && !(encodeWork > 0)) {
        unknownReason ??= "segment-production-delay-unavailable";
      }

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
              sourceIntervals.set(sourceId, {
                start: workStart,
                end: segment.endSeconds
              });
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
        sourceIntervals,
        produced
      });
    }
  }

  if (unknownReason) {
    return result(false, null, buffered, reserve, null, unknownReason, preparedSegments);
  }
  for (const sourceId of new Set(jobs.flatMap(({ sourceIntervals }) => [...sourceIntervals.keys()]))) {
    const source = sourceState.get(sourceId);
    if (!source || !downloadServices.get(source.serviceId)?.curve) {
      return result(false, null, buffered, reserve, null, "download-rate-unavailable", preparedSegments);
    }
  }
  for (const { track, curve } of trackState) {
    if (jobs.some((job) => job.track === track && !job.produced) && !curve) {
      return result(false, null, buffered, reserve, null, "encode-rate-unavailable", preparedSegments);
    }
  }

  jobs.sort((left, right) => left.segment.startSeconds - right.segment.startSeconds ||
    left.segment.endSeconds - right.segment.endSeconds || left.trackIndex - right.trackIndex);

  const schedule = (startDelaySeconds, prefillOnly = false, prefillReach = 0) => {
    const sourceFinish = new Map([...downloadServices.keys()].map((id) => [id, {
      finishAt: 0
    }]));
    const sourceMediaEnd = new Map();
    const trackFinish = trackState.map(() => 0);
    let transferFinish = 0;
    const completions = [];
    const productions = [];
    for (const job of jobs) {
      const { track, trackIndex, segment, ahead, sizeBits, encodeWork, sourceIntervals } = job;
      if (prefillOnly && (ahead > prefillReach || segment.endSeconds - position > capacity)) {
        continue;
      }
      const requestAt = ahead <= lookahead
        ? 0
        : startDelaySeconds + ahead - lookahead;
      const sourceWorkByService = new Map();
      for (const [sourceId, interval] of sourceIntervals) {
        const source = sourceState.get(sourceId);
        const previousMediaEnd = sourceMediaEnd.get(sourceId) ?? position;
        const mediaWork = Math.max(0, interval.end - Math.max(interval.start, previousMediaEnd));
        const byteWork = mediaWork * Number(source.source.bytesPerMediaSecond);
        const serviceWork = sourceWorkByService.get(source.serviceId) ?? {
          bytes: 0,
          mediaEnds: new Map()
        };
        serviceWork.bytes += byteWork;
        serviceWork.mediaEnds.set(sourceId, Math.max(previousMediaEnd, interval.end));
        sourceWorkByService.set(source.serviceId, serviceWork);
      }
      const sourceReadyAt = new Map();
      for (const [serviceId, work] of sourceWorkByService) {
        const previous = sourceFinish.get(serviceId) ?? { finishAt: 0 };
        const service = downloadServices.get(serviceId);
        const serviceStart = Math.max(requestAt, previous.finishAt);
        const readyAt = work.bytes > 0
          ? service.curve.finish(work.bytes, serviceStart)
          : previous.finishAt;
        sourceFinish.set(serviceId, { finishAt: readyAt });
        for (const [sourceId, mediaEnd] of work.mediaEnds) {
          sourceMediaEnd.set(sourceId, mediaEnd);
          sourceReadyAt.set(sourceId, readyAt);
        }
      }
      const sourceReadyAtLatest = (Array.isArray(track.sourceIds) ? [...new Set(track.sourceIds)] : [])
        .reduce((latest, sourceId) => Math.max(latest, sourceReadyAt.get(sourceId) ?? requestAt), requestAt);
      const encodeStart = Math.max(requestAt, trackFinish[trackIndex]);
      const encodedAt = job.produced
        ? requestAt
        : trackState[trackIndex].curve.finish(encodeWork, encodeStart);
      if (!job.produced) {
        trackFinish[trackIndex] = encodedAt;
      }
      const producedAt = job.produced ? 0 : Math.max(sourceReadyAtLatest, encodedAt);
      productions.push({
        at: producedAt,
        sourceReadyAt: sourceReadyAtLatest,
        trackIndex,
        segment,
        requiresSource: sourceIntervals.size > 0
      });
      const roomAt = segment.endSeconds - position <= capacity
        ? 0
        : startDelaySeconds + segment.endSeconds - position - capacity;
      const transferStart = Math.max(transferFinish, producedAt, roomAt, requestAt);
      const transferEnd = link.finish(sizeBits, transferStart);
      if (!Number.isFinite(transferEnd)) {
        return { safe: false, finishAt: Number.POSITIVE_INFINITY, completions };
      }
      transferFinish = transferEnd;
      completions.push({ at: transferEnd, trackIndex, segment });
    }

    const usefulCompletions = prefillOnly
      ? completions.filter(({ segment }) => segment.startSeconds - position <= prefillReach &&
        segment.endSeconds - position <= capacity)
      : completions;
    const usefulProductions = prefillOnly
      ? productions.filter(({ segment }) => segment.startSeconds - position <= prefillReach &&
        segment.endSeconds - position <= capacity)
      : productions;
    const safety = isSafeSchedule(usefulCompletions, usefulProductions, trackState, position, duration,
      buffered, capacity, reserve, startDelaySeconds);
    return { safe: safety.safe,
      bufferedAtStart: safety.bufferedAtStart,
      neededSeconds: safety.neededSeconds,
      completionTimes: usefulCompletions.map(({ at }) => at),
      finishAt: usefulCompletions.reduce((latest, item) => Math.max(latest, item.at), 0) };
  };

  const prefillReach = Math.min(capacity, lookahead, remaining);
  const prefillSchedule = schedule(0, true, prefillReach);
  const maximumUsefulDelay = prefillSchedule.finishAt;
  if (!Number.isFinite(maximumUsefulDelay)) {
    return result(false, null, buffered, reserve, null, "prefill-cannot-complete", preparedSegments);
  }
  const immediate = schedule(0);
  if (immediate.safe) {
    return result(true, 0, buffered, reserve, 0, "trajectory-safe-now", preparedSegments);
  }
  const searchLimit = maximumUsefulDelay;
  if (!(searchLimit > 0)) {
    return result(false, null, buffered, reserve, null, "no-safe-start-found", preparedSegments);
  }

  let low = 0;
  let high = null;
  const breakpoints = [...new Set([
    maximumUsefulDelay,
    searchLimit,
    ...prefillSchedule.completionTimes
  ])]
    .filter((delay) => delay > 0 && delay <= searchLimit)
    .sort((left, right) => left - right);
  const candidates = new Set(breakpoints);
  for (let index = 1; index < breakpoints.length; index += 1) {
    candidates.add((breakpoints[index - 1] + breakpoints[index]) / 2);
  }
  for (const delay of [...candidates].sort((left, right) => left - right)) {
    if (schedule(delay).safe) {
      high = delay;
      break;
    }
  }
  if (high === null) {
    return result(false, null, buffered, reserve, null, "no-safe-start-found", preparedSegments);
  }

  while (true) {
    const middle = (low + high) / 2;
    if (middle === low || middle === high) {
      break;
    }
    if (schedule(middle).safe) {
      high = middle;
    } else {
      low = middle;
    }
  }
  const readiness = schedule(high);
  return result(false, high, buffered, reserve, immediate.neededSeconds,
    "minimum-safe-delay", preparedSegments, readiness.bufferedAtStart);
}

/** Predict only unknown cuts in the same clock as the measured track. */
function predictedMediaSegments(segments) {
  const anchors = segments.filter(({ mediaRanges }) => mediaRanges?.length > 0);
  return segments.map((segment) => {
    if (segment.mediaRanges !== undefined && segment.mediaRanges !== null || anchors.length === 0) return segment;
    const previous = anchors.findLast(({ index }) => index < segment.index);
    const next = anchors.find(({ index }) => index > segment.index);
    const nominalLeft = previous?.endSeconds ?? next.startSeconds;
    const actualLeft = previous?.mediaRanges.at(-1).end ?? next.mediaRanges[0].start;
    const nominalRight = next?.startSeconds ?? nominalLeft;
    const actualRight = next?.mediaRanges[0].start ?? actualLeft;
    const scale = nominalRight > nominalLeft ? (actualRight - actualLeft) / (nominalRight - nominalLeft) : 1;
    return { ...segment, mediaRanges: [{
      start: actualLeft + (segment.startSeconds - nominalLeft) * scale,
      end: actualLeft + (segment.endSeconds - nominalLeft) * scale
    }] };
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

function rateCurveFrom({ lastAt, lastValue, meanValue, spanSeconds }, now) {
  const baseline = Math.max(0, Math.min(lastValue, meanValue));
  const span = Math.max(Number.EPSILON, spanSeconds);
  const age = Math.max(0, (now - lastAt) / 1000);
  const excess = Math.max(0, lastValue - baseline) * Math.exp(-age / span);
  // r(t) = baseline + excess * exp(-t/span).
  // W(t) = integral(0..t, r(u)du). Positive measured service has no finite
  // total-work ceiling merely because an old sample was faster.
  const workBy = (seconds) => rateIntegral(Math.max(0, seconds), baseline, excess, span);
  return {
    rateAt: (seconds) => baseline + excess * Math.exp(-Math.max(0, seconds) / span),
    workBy,
    finish: (work, startAt) => {
      const start = Math.max(0, startAt);
      return start + invertRateIntegral(Math.max(0, work), baseline,
        excess * Math.exp(-start / span), span);
    }
  };
}

function rateIntegral(seconds, baseline, excess, span) {
  return baseline * seconds - excess * span * Math.expm1(-seconds / span);
}

/** Invert the strictly increasing service integral, with no playback rule. */
function invertRateIntegral(work, baseline, excess, span) {
  if (work === 0) {
    return 0;
  }
  if (!(baseline > 0) || !Number.isFinite(work)) {
    return Number.POSITIVE_INFINITY;
  }
  let low = 0;
  let high = work / baseline;
  if (excess === 0) {
    return high;
  }
  while (true) {
    const middle = (low + high) / 2;
    if (middle === low || middle === high) {
      return high;
    }
    if (rateIntegral(middle, baseline, excess, span) >= work) {
      high = middle;
    } else {
      low = middle;
    }
  }
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

function isSafeSchedule(completions, productions, trackState, position, duration, buffered, capacity, reserve,
  startDelay) {
  // Client continuity is constrained by its buffer limit; source-stall reserve
  // is covered by the larger union of client data and output already prepared here.
  const clientRanges = trackState.map((state) => state.clientRanges.map((range) => ({ ...range })));
  const preparedRanges = trackState.map((state) => state.clientRanges.map((range) => ({ ...range })));
  const orderedCompletions = [...completions]
    .filter(({ at }) => Number.isFinite(at))
    .sort((left, right) => left.at - right.at || left.trackIndex - right.trackIndex);
  const orderedProductions = [...productions]
    .filter(({ at }) => Number.isFinite(at))
    .sort((left, right) => left.at - right.at || left.trackIndex - right.trackIndex);
  const reserveUntil = trackState.map(() => Number.NEGATIVE_INFINITY);
  // The measured reserve applies only until this track's last required source
  // interval has arrived; encoding and client delivery stay in the schedule.
  for (const production of productions) {
    if (production.requiresSource) {
      reserveUntil[production.trackIndex] = Math.max(reserveUntil[production.trackIndex],
        production.sourceReadyAt);
    }
  }
  let completionIndex = 0;
  let productionIndex = 0;

  const addThrough = (time) => {
    while (productionIndex < orderedProductions.length && orderedProductions[productionIndex].at <= time) {
      const { trackIndex, segment } = orderedProductions[productionIndex];
      for (const range of segment.mediaRanges ?? [{ start: segment.startSeconds, end: segment.endSeconds }]) {
        addRange(preparedRanges[trackIndex], range.start, range.end);
      }
      productionIndex += 1;
    }
    while (completionIndex < orderedCompletions.length && orderedCompletions[completionIndex].at <= time) {
      const { trackIndex, segment } = orderedCompletions[completionIndex];
      for (const range of segment.mediaRanges ?? [{ start: segment.startSeconds, end: segment.endSeconds }]) {
        addRange(clientRanges[trackIndex], range.start, range.end);
        addRange(preparedRanges[trackIndex], range.start, range.end);
      }
      completionIndex += 1;
    }
  };
  const safeAt = (time, checkClient = true) => {
    const playerPosition = position + Math.max(0, time - startDelay);
    if (playerPosition >= duration) {
      return { safe: true, stockSafe: true, available: 0, neededSeconds: 0 };
    }
    const trackEnd = (index) => {
      const last = trackState[index].segments.at(-1);
      return last?.mediaRanges?.at(-1)?.end ?? duration;
    };
    const available = Math.min(capacity, ...clientRanges.map((trackRanges, index) =>
      playerPosition >= trackEnd(index) ? Number.POSITIVE_INFINITY :
        Math.max(0, contiguousEnd(trackRanges, playerPosition) - playerPosition)));
    let neededSeconds = 0;
    let stockSafe = true;
    for (let trackIndex = 0; trackIndex < trackState.length; trackIndex += 1) {
      const required = time <= reserveUntil[trackIndex]
        ? Math.min(reserve, Math.max(0, trackEnd(trackIndex) - playerPosition))
        : 0;
      const preparedAhead = Math.max(0,
        contiguousEnd(preparedRanges[trackIndex], playerPosition) - playerPosition);
      const deficit = Math.max(0, required - preparedAhead);
      neededSeconds = Math.max(neededSeconds, deficit);
      stockSafe &&= deficit === 0;
    }
    return {
      safe: (!checkClient || available > 0) && stockSafe,
      stockSafe,
      available,
      neededSeconds
    };
  };

  addThrough(startDelay);
  const atStart = safeAt(startDelay);
  if (!atStart.safe) {
    return { safe: false, bufferedAtStart: atStart.available, neededSeconds: atStart.neededSeconds };
  }

  const playbackEnd = startDelay + Math.max(0, duration - position);
  const playbackBoundaries = [position + buffered,
    ...trackState.flatMap(({ clientRanges }) => clientRanges.flatMap(({ start, end }) => [start, end])),
    ...trackState.flatMap(({ segments }) => segments.flatMap((segment) =>
      (segment.mediaRanges ?? []).flatMap(({ start, end }) => [start, end]))),
    ...trackState.flatMap(({ segments }) => segments.map(({ endSeconds }) => endSeconds))]
    .filter((boundary) => boundary > position && boundary < duration)
    .map((boundary) => startDelay + boundary - position);
  const sourceReadyTimes = productions
    .filter(({ requiresSource }) => requiresSource)
    .map(({ sourceReadyAt }) => sourceReadyAt);
  const eventTimes = [...orderedCompletions.map(({ at }) => at),
    ...orderedProductions.map(({ at }) => at), ...playbackBoundaries, ...sourceReadyTimes]
    .filter((time) => Number.isFinite(time) && time > startDelay && time < playbackEnd)
    .sort((left, right) => left - right)
    .filter((time, index, all) => index === 0 || time !== all[index - 1]);

  for (const time of eventTimes) {
    const beforeArrival = safeAt(time, false);
    if (!beforeArrival.stockSafe) {
      return { safe: false, bufferedAtStart: atStart.available, neededSeconds: beforeArrival.neededSeconds };
    }
    addThrough(time);
    const afterArrival = safeAt(time);
    if (!afterArrival.safe) {
      return { safe: false, bufferedAtStart: atStart.available, neededSeconds: afterArrival.neededSeconds };
    }
  }

  const atEnd = safeAt(playbackEnd);
  return { safe: atEnd.safe, bufferedAtStart: atStart.available, neededSeconds: atStart.neededSeconds };
}

function addRange(ranges, start, end) {
  const merged = [];
  let next = { start, end };
  let inserted = false;
  for (const range of ranges) {
    if (range.end < next.start) {
      merged.push(range);
    } else if (next.end < range.start) {
      if (!inserted) {
        merged.push(next);
        inserted = true;
      }
      merged.push(range);
    } else {
      next = { start: Math.min(next.start, range.start), end: Math.max(next.end, range.end) };
    }
  }
  if (!inserted) {
    merged.push(next);
  }
  ranges.splice(0, ranges.length, ...merged);
}

function normalizedRanges(ranges) {
  const result = [];
  for (const range of ranges) {
    if (Number.isFinite(range?.start) && Number.isFinite(range?.end) && range.end > range.start) {
      addRange(result, range.start, range.end);
    }
  }
  return result;
}

function coveredSeconds(ranges, start, end) {
  return ranges.reduce((total, range) => total + Math.max(0,
    Math.min(end, range.end) - Math.max(start, range.start)), 0);
}

function contiguousEnd(ranges, position) {
  for (const range of ranges) {
    if (range.start <= position && position <= range.end) {
      return range.end;
    }
    if (range.start > position) {
      break;
    }
  }
  return position;
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
