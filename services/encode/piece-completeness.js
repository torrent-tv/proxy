/**
 * @file Whether a closed piece holds the whole of its stretch of film.
 *
 * A fact of production, decided where production is known: the cut a piece
 * must reach comes from the output's cut table, and what it holds from the
 * piece's own media intervals as its format reads them. The segment store keeps
 * the bytes and whatever is derived from them; it does not judge them.
 *
 * A non-final piece is whole when the end of its last frame, on every track,
 * reaches its next cut less `SEGMENT_CUT_TIME_DELTA_SECONDS`, the delta the
 * muxer is configured with. The final piece has no next cut and is whole when
 * it holds playable media at all. A piece that holds no playable media is never
 * whole: an interrupted run can close a file with nothing in it.
 */

import { SEGMENT_CUT_TIME_DELTA_SECONDS } from "./output/index.js";

/**
 * The time a piece must reach, or undefined for the final piece.
 *
 * @param {{ segmentCount: number, publishedStartOf: (index: number) => number }} timeline
 * @param {number} index
 * @returns {number | undefined}
 */
export function cutOf(timeline, index) {
  return index < timeline.segmentCount - 1
    ? (Math.round(timeline.publishedStartOf(index + 1) * 1_000_000) -
      Math.round(SEGMENT_CUT_TIME_DELTA_SECONDS * 1_000_000)) / 1_000_000
    : undefined;
}

/**
 * Track positions read from empty edits retain their movie-tick uncertainty.
 * Fresh closures also carry the muxer's packet end and its actual cut, so a
 * restarted run is judged on its own reference clock. Neither allowance is a
 * browser's frame-join rule.
 *
 * @param {{ producedThroughSeconds?: (ranges: object) => number | null }} format
 * @param {object} ranges - The piece's media intervals, as the format read them.
 * @param {number | undefined} cutSeconds - From {@link cutOf}.
 * @returns {{ whole: boolean, throughSeconds: number | null }}
 */
export function judgePiece(format, ranges, cutSeconds) {
  const throughSeconds = format.producedThroughSeconds?.(ranges) ?? null;
  if (throughSeconds === null) {
    return { whole: false, throughSeconds };
  }
  const cutMicros = ranges?.production?.cutMicros ??
    (Number.isFinite(cutSeconds) ? BigInt(Math.round(cutSeconds * 1_000_000)) : null);
  if (cutMicros !== null && ranges?.tracks?.length) {
    const tracks = ranges.tracks;
    const production = ranges.production;
    const reference = production ? tracks.find(({ kind }) => kind === production.kind) : null;
    const referenceEnd = reference?.ranges.at(-1)?.end;
    const whole = tracks.every((track) => {
      const { timescale, ranges: held, positionErrorTicks = 0n } = track;
      const end = held.at(-1)?.end;
      if (end === undefined) return false;
      if (referenceEnd !== undefined) {
        if (track === reference) return 2n * production.endMicros + 1n >= 2n * cutMicros;
        // The segment muxer's CSV reports packet time before movenc truncates
        // the empty edit. Compare on that clock, including another track's
        // relative end and the precision of both written track positions.
        const difference = (end + positionErrorTicks) * reference.timescale -
          (referenceEnd - (reference.positionErrorTicks ?? 0n)) * timescale;
        const denominator = timescale * reference.timescale;
        return 2n * difference * 1_000_000n +
          (2n * production.endMicros + 1n) * denominator >= 2n * cutMicros * denominator;
      }
      return (end + positionErrorTicks) * 1_000_000n >= cutMicros * timescale;
    });
    return { whole, throughSeconds };
  }
  if (cutMicros !== null && throughSeconds < Number(cutMicros) / 1_000_000) {
    return { whole: false, throughSeconds };
  }
  return { whole: true, throughSeconds };
}

/** The muxer cuts relative to its first reference packet, not the requested seek. */
export function productionOf(timing, cutTimes, relativeIndex, kind) {
  if (!timing || timing.originMicros === null || !Number.isFinite(cutTimes?.[relativeIndex])) return null;
  return {
    kind,
    endMicros: timing.endMicros,
    cutMicros: timing.originMicros + BigInt(Math.round(cutTimes[relativeIndex] * 1_000_000)) -
      BigInt(Math.round(SEGMENT_CUT_TIME_DELTA_SECONDS * 1_000_000))
  };
}

/**
 * The first CSV entry has start_time = 0 even after a seek (segment.c).
 * Recover its reference packet's PTS from the reported end minus the exact
 * sample span. The edit-list offset cancels, including its lost precision.
 */
export function originOf(ranges, endMicros, kind) {
  const track = ranges?.tracks?.find(track => track.kind === kind);
  if (track?.firstSampleStart === undefined || !track.ranges.length) return null;
  const ticks = endMicros * track.timescale -
    (track.ranges.at(-1).end - track.firstSampleStart) * 1_000_000n;
  // CSV rounds to microseconds; rescale with the muxer's nearest rounding.
  return ticks >= 0n ? (2n * ticks + track.timescale) / (2n * track.timescale) :
    -((-2n * ticks + track.timescale) / (2n * track.timescale));
}
