/**
 * Cached piece geometry for playback forecasts. It is keyed by a live output
 * object and explicitly forgotten when that output is disposed.
 */
export class OutputForecastGeometry {
  #byOutput = new Map();
  #host;

  constructor(host) {
    this.#host = host;
  }

  get(output) {
    return this.#byOutput.get(output) ?? null;
  }

  forget(output) {
    return this.#byOutput.delete(output);
  }

  size() {
    return this.#byOutput.size;
  }

  segmentsOf(output, sessionInit, inventory, positionSeconds) {
    const timeline = output.timeline;
    const count = timeline?.segmentCount ?? 0;
    let forecast = this.#byOutput.get(output);
    if (!forecast) {
      forecast = { pieces: [], geometry: {} };
      this.#byOutput.set(output, forecast);
    }
    const kept = forecast.pieces;
    const segments = [];
    const lookahead = Number(this.#host.lookaheadSeconds);
    const start = Number.isFinite(positionSeconds) ? Math.max(0, positionSeconds) : 0;
    const end = Number.isFinite(lookahead) && lookahead > 0 ? start + lookahead : Number.POSITIVE_INFINITY;
    let low = 0, high = count;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (timeline.publishedStartOf(middle + 1) <= start) low = middle + 1;
      else high = middle;
    }
    const first = Math.max(0, low - 1);
    low = first;
    high = count;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (timeline.publishedStartOf(middle) < end) low = middle + 1;
      else high = middle;
    }
    const last = low;
    const indexes = new Set([0]);
    for (let index = first; index < last; index++) indexes.add(index);
    for (const index of indexes) {
      const endSeconds = timeline.publishedStartOf(index + 1);
      const ranges = inventory.has(index) ? this.#host.finishedMediaRangesOf(output, index) : undefined;
      const mediaRanges = ranges && output.segmentFormat?.servedMediaRanges ?
        output.segmentFormat.servedMediaRanges(ranges, { initBytes: sessionInit }) : undefined;
      if (index !== 0 && mediaRanges === undefined && !inventory.has(index) &&
        Number.isFinite(endSeconds) && Number.isFinite(positionSeconds) &&
        !this.#host.endsWithinPlayerSeekTolerance(endSeconds, positionSeconds) &&
        endSeconds < positionSeconds) {
        continue;
      }
      const startSeconds = timeline.publishedStartOf(index);
      const sourceInputs = this.#host.sourceInputsFor?.(output, index) ?? undefined;
      const previous = kept[index];
      if (previous && previous.startSeconds === startSeconds && previous.endSeconds === endSeconds &&
        previous.mediaRanges === mediaRanges && sameInputs(previous.sourceInputs, sourceInputs)) {
        segments.push(previous);
        continue;
      }
      const segment = { index, startSeconds, endSeconds, sourceInputs, mediaRanges };
      kept[index] = segment;
      segments.push(segment);
    }
    if (kept.length > count) kept.length = count;
    return segments;
  }
}

function sameInputs(left, right) {
  if (left === right) return true;
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((input, index) => input.sourceId === right[index].sourceId && input.ranges === right[index].ranges);
}
