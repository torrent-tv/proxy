/**
 * Predict the minimum delay before playback can run to the end without
 * exhausting the browser buffer.
 *
 * This module contains the playback decision's only model. Its inputs are
 * measurements and physical limits: source bytes and download rate, encoded
 * media and encoder rate, segment sizes and client-link rate, the existing
 * browser buffer, its capacity, the proxy look-ahead, and the measured reserve
 * for interruptions. Rates are extrapolated from their measured linear trend;
 * there are no fitted weights or rate multipliers.
 */

/**
 * The mean rate predicted over a horizon by the trend in all supplied
 * measurements. With no trend this is the measured rate. The regression treats
 * every measurement equally.
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
 * Constant-space measurements for one rate trend. Linear regression can be
 * evaluated from these sums without retaining every poll for the life of a
 * film.
 */
export class RateTrend {
  #originAt = null;
  #lastAt = null;
  #count = 0;
  #sumTime = 0;
  #sumTimeSquared = 0;
  #sumValue = 0;
  #sumTimeValue = 0;

  add(at, value) {
    if (!Number.isFinite(at) || !Number.isFinite(value) || value < 0 ||
      (this.#lastAt !== null && at <= this.#lastAt)) {
      return false;
    }
    this.#originAt ??= at;
    const elapsed = (at - this.#originAt) / 1000;
    this.#count += 1;
    this.#sumTime += elapsed;
    this.#sumTimeSquared += elapsed ** 2;
    this.#sumValue += value;
    this.#sumTimeValue += elapsed * value;
    this.#lastAt = at;
    return true;
  }

  snapshot() {
    if (this.#count === 0) {
      return null;
    }
    return {
      count: this.#count,
      originAt: this.#originAt,
      lastAt: this.#lastAt,
      sumTime: this.#sumTime,
      sumTimeSquared: this.#sumTimeSquared,
      sumValue: this.#sumValue,
      sumTimeValue: this.#sumTimeValue
    };
  }
}

/**
 * @param {object} input
 * @param {number} input.positionSeconds
 * @param {number} input.durationSeconds
 * @param {number} input.bufferedAheadSeconds
 * @param {number} input.bufferLimitSeconds
 * @param {number} input.reserveSeconds
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
  const position = finiteNonNegative(input.positionSeconds);
  const duration = finiteNonNegative(input.durationSeconds);
  const remaining = Math.max(0, duration - position);
  const buffered = finiteNonNegative(input.bufferedAheadSeconds);
  const capacity = finiteNonNegative(input.bufferLimitSeconds);
  const reserve = Math.min(remaining, finiteNonNegative(input.reserveSeconds));
  const lookahead = finiteNonNegative(input.lookaheadSeconds);
  const tracks = Array.isArray(input.tracks) ? input.tracks : [];
  const sources = new Map((Array.isArray(input.sources) ? input.sources : [])
    .filter((source) => typeof source?.id === "string")
    .map((source) => [source.id, source]));
  if (remaining <= buffered) {
    return result(true, 0, buffered, reserve, 0, "client-buffer-covers-end", 0);
  }
  if (!(duration > 0) || !(capacity > 0) || !(reserve > 0) || tracks.length === 0) {
    return result(false, null, buffered, reserve, null, "incomplete-state", 0);
  }
  if (reserve > capacity) {
    return result(false, null, buffered, reserve, null, "reserve-exceeds-client-capacity", 0);
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
    ready: new Set(Array.isArray(track.readySegmentIndices) ? track.readySegmentIndices : []),
    curve: rateCurve(track.readings, now),
    bitsPerMediaSecond: averageBitsPerMediaSecond(track, track.segments,
      new Set(Array.isArray(track.readySegmentIndices) ? track.readySegmentIndices : [])),
    segments: track.segments
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
    const { track, ready, segments } = state;
    const measuredBitsPerMediaSecond = state.bitsPerMediaSecond;
    for (const segment of segments) {
      if (segment.endSeconds <= position + buffered) {
        continue;
      }
      const exactBytes = sizeOf(track.segmentSizesBytes, segment.index);
      const segmentSeconds = segment.endSeconds - segment.startSeconds;
      const sizeBits = exactBytes > 0
        ? exactBytes * 8
        : measuredBitsPerMediaSecond * segmentSeconds;
      if (!(sizeBits > 0)) {
        unknownReason ??= "segment-size-unavailable";
      }

      const produced = state.ready.has(segment.index);
      const processed = Number(track.processedSeconds);
      const workStart = Math.max(position, segment.startSeconds,
        Number.isFinite(processed) ? processed : segment.startSeconds);
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

  const rateRecoveryDelays = [];
  const sourceDemandByService = new Map();
  for (const sourceId of new Set(jobs.flatMap(({ sourceIntervals }) => [...sourceIntervals.keys()]))) {
    const source = sourceState.get(sourceId);
    const demand = sourceDemandByService.get(source.serviceId) ?? new Map();
    demand.set(sourceId, Number(source.source.bytesPerMediaSecond));
    sourceDemandByService.set(source.serviceId, demand);
  }
  for (const [serviceId, demandBySource] of sourceDemandByService) {
    const demand = [...demandBySource.values()].reduce((sum, value) => sum + value, 0);
    rateRecoveryDelays.push(downloadServices.get(serviceId).curve.timeAtLeast(demand));
  }
  for (const { track, curve } of trackState) {
    if (jobs.some((job) => job.track === track && !job.produced)) {
      rateRecoveryDelays.push(curve.timeAtLeast(1));
    }
  }
  const linkDemand = trackState.reduce((sum, { track, bitsPerMediaSecond }) =>
    sum + (jobs.some((job) => job.track === track) ? bitsPerMediaSecond : 0), 0);
  if (linkDemand > 0) {
    rateRecoveryDelays.push(link.timeAtLeast(linkDemand));
  }
  const rateRecoveryDelay = rateRecoveryDelays
    .filter(Number.isFinite)
    .reduce((latest, delay) => Math.max(latest, delay), 0);

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
      const producedAt = Math.max(sourceReadyAtLatest, encodedAt);
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
    const safety = isSafeSchedule(usefulCompletions, trackState, position, duration,
      buffered, capacity, reserve, startDelaySeconds);
    return { safe: safety.safe,
      bufferedAtStart: safety.bufferedAtStart,
      finishAt: usefulCompletions.reduce((latest, item) => Math.max(latest, item.at), 0),
      completions: usefulCompletions };
  };

  const prefillReach = Math.min(capacity, lookahead, remaining);
  const prefillSchedule = schedule(0, true, prefillReach);
  const maximumUsefulDelay = prefillSchedule.finishAt;
  if (!Number.isFinite(maximumUsefulDelay)) {
    return result(false, null, buffered, reserve, null, "prefill-cannot-complete", preparedSegments);
  }
  if (schedule(0).safe) {
    return result(true, 0, buffered, reserve, 0, "trajectory-safe-now", preparedSegments);
  }
  const searchLimit = Math.max(maximumUsefulDelay, rateRecoveryDelay);
  if (!(searchLimit > 0)) {
    return result(false, null, buffered, reserve, null, "no-safe-start-found", preparedSegments);
  }

  let low = 0;
  let high = null;
  const breakpoints = [...new Set([
    maximumUsefulDelay,
    searchLimit,
    ...rateRecoveryDelays.filter(Number.isFinite)
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
  return result(false, high, buffered, reserve, Math.max(0, reserve - buffered),
    "minimum-safe-delay", preparedSegments, readiness.bufferedAtStart);
}

function rateCurve(readings, now) {
  if (readings && Number.isFinite(readings.count) && readings.count > 0 &&
    Number.isFinite(readings.originAt) && Number.isFinite(readings.lastAt) &&
    Number.isFinite(readings.sumTime) && Number.isFinite(readings.sumTimeSquared) &&
    Number.isFinite(readings.sumValue) && Number.isFinite(readings.sumTimeValue)) {
    const { count, originAt, sumTime, sumTimeSquared, sumValue, sumTimeValue } = readings;
    const meanAt = sumTime / count;
    const meanValue = sumValue / count;
    const denominator = sumTimeSquared - count * meanAt ** 2;
    const numerator = sumTimeValue - count * meanAt * meanValue;
    const slope = denominator > 0 ? numerator / denominator : 0;
    const current = Math.max(0, meanValue + slope * ((now - originAt) / 1000 - meanAt));
    return rateCurveFrom(current, slope);
  }
  const ordered = (Array.isArray(readings) ? readings : [])
    .filter((reading) => Number.isFinite(reading?.at) && Number.isFinite(reading?.value) && reading.value >= 0)
    .filter((reading) => reading.at <= now)
    .sort((left, right) => left.at - right.at)
    .filter((reading, index, all) => index === 0 || reading.at !== all[index - 1].at);
  if (ordered.length === 0) {
    return null;
  }

  const points = ordered.map((reading) => ({
    at: (reading.at - now) / 1000,
    value: reading.value
  }));
  const meanAt = points.reduce((sum, point) => sum + point.at, 0) / points.length;
  const meanValue = points.reduce((sum, point) => sum + point.value, 0) / points.length;
  const numerator = points.reduce((sum, point) =>
    sum + (point.at - meanAt) * (point.value - meanValue), 0);
  const denominator = points.reduce((sum, point) =>
    sum + (point.at - meanAt) ** 2, 0);
  const slope = denominator > 0 ? numerator / denominator : 0;
  const current = Math.max(0, meanValue - slope * meanAt);
  return rateCurveFrom(current, slope);
}

function rateCurveFrom(current, slope) {
  const zeroAt = slope < 0 ? -current / slope : Number.POSITIVE_INFINITY;

  const workBy = (seconds) => {
    const span = Math.min(Math.max(0, seconds), zeroAt);
    return Math.max(0, current * span + (slope * span ** 2) / 2);
  };
  const timeFor = (work) => {
    if (!(work > 0)) {
      return 0;
    }
    if (!(current > 0) && !(slope > 0)) {
      return Number.POSITIVE_INFINITY;
    }
    const discriminant = current ** 2 + 2 * slope * work;
    if (discriminant < 0) {
      return Number.POSITIVE_INFINITY;
    }
    if (slope < 0 && work > workBy(zeroAt)) {
      return Number.POSITIVE_INFINITY;
    }
    if (slope === 0) {
      return current > 0 ? work / current : Number.POSITIVE_INFINITY;
    }
    const root = Math.sqrt(discriminant);
    const denominator = current + root;
    return denominator > 0 ? (2 * work) / denominator : Number.POSITIVE_INFINITY;
  };
  return {
    timeAtLeast: (target) => {
      if (!Number.isFinite(target) || target < 0) {
        return Number.POSITIVE_INFINITY;
      }
      if (current >= target) {
        return 0;
      }
      return slope > 0 ? (target - current) / slope : Number.POSITIVE_INFINITY;
    },
    rateAt: (seconds) => Math.max(0, current + slope * Math.min(Math.max(0, seconds), zeroAt)),
    workBy,
    finish: (work, startAt) => {
      if (!(work > 0)) {
        return Math.max(0, startAt);
      }
      const start = Math.max(0, startAt);
      return start + (timeFor(work + workBy(start)) - start);
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

function isSafeSchedule(completions, trackState, position, duration, buffered, capacity, reserve, startDelay) {
  const ranges = trackState.map(() => [{ start: position, end: position + buffered }]);
  const ordered = [...completions]
    .filter(({ at }) => Number.isFinite(at))
    .sort((left, right) => left.at - right.at || left.trackIndex - right.trackIndex);
  let completionIndex = 0;

  const addThrough = (time) => {
    while (completionIndex < ordered.length && ordered[completionIndex].at <= time) {
      const { trackIndex, segment } = ordered[completionIndex];
      addRange(ranges[trackIndex], segment.startSeconds, segment.endSeconds);
      completionIndex += 1;
    }
  };
  const safeAt = (time) => {
    const playerPosition = position + Math.max(0, time - startDelay);
    const available = Math.min(capacity, ...ranges.map((trackRanges) =>
      Math.max(0, contiguousEnd(trackRanges, playerPosition) - playerPosition)));
    const required = Math.min(reserve, Math.max(0, duration - playerPosition));
    return { safe: available >= required, available };
  };

  addThrough(startDelay);
  const atStart = safeAt(startDelay);
  if (!atStart.safe) {
    return { safe: false, bufferedAtStart: atStart.available };
  }

  while (completionIndex < ordered.length) {
    const time = ordered[completionIndex].at;
    if (time > startDelay) {
      const beforeArrival = safeAt(time);
      if (!beforeArrival.safe) {
        return { safe: false, bufferedAtStart: atStart.available };
      }
    }
    addThrough(time);
    if (time > startDelay) {
      const afterArrival = safeAt(time);
      if (!afterArrival.safe) {
        return { safe: false, bufferedAtStart: atStart.available };
      }
    }
  }

  const atEnd = safeAt(startDelay + Math.max(0, duration - position));
  return { safe: atEnd.safe, bufferedAtStart: atStart.available };
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
