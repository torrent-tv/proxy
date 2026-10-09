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
 * Whether a closed piece holds its stretch of film. With `interval` (a run
 * reading the original file, which states the stretch each piece covers) the
 * piece's tracks are compared with that stretch; otherwise with the cut.
 *
 * Both are compared on the clock the producing run's muxer cut by: moved by
 * `ranges.cutShiftSeconds`, which the run states for every piece it closes
 * ({@link cutShiftOf}) and which travels with the piece. A piece whose run is
 * not known — one adopted from an earlier life of the process — has none, and
 * is compared with the cut as published.
 *
 * @param {{ producedThroughSeconds?: (ranges: object) => number | null }} format
 * @param {object} ranges - The piece's media intervals, as the format read them.
 * @param {number | undefined} cutSeconds - From {@link cutOf}.
 * @param {{ from: number, to: number, requiredKinds: string[], sourceEnds?: object }} [interval]
 * @returns {{ whole: boolean, throughSeconds: number | null, reason?: string }}
 */
export function judgePiece(format, ranges, cutSeconds, interval) {
  const throughSeconds = format.producedThroughSeconds?.(ranges) ?? null;
  if (throughSeconds === null) {
    return { whole: false, throughSeconds };
  }
  const shift = Number.isFinite(ranges?.cutShiftSeconds) ? ranges.cutShiftSeconds : 0;
  if (interval) {
    const reason = intervalFailure(ranges, { ...interval, shift });
    return reason ? { whole: false, throughSeconds, reason } : { whole: true, throughSeconds };
  }
  const cutMicros = Number.isFinite(cutSeconds) ? BigInt(Math.round((cutSeconds + shift) * 1_000_000)) : null;
  if (cutMicros !== null && ranges?.tracks?.length) {
    const whole = ranges.tracks.every(({ timescale, ranges: held, positionErrorTicks = 0n }) => {
      const end = held.at(-1)?.end;
      return end !== undefined && (end + positionErrorTicks) * 1_000_000n >= cutMicros * timescale;
    });
    return { whole, throughSeconds };
  }
  if (cutMicros !== null && throughSeconds < Number(cutMicros) / 1_000_000) {
    return { whole: false, throughSeconds };
  }
  return { whole: true, throughSeconds };
}

/**
 * How far after its requested start a run's segment muxer counts its cuts
 * from, read from the run's FIRST piece, or `null` when that piece does not
 * start within one frame of the start.
 *
 * With `endMicros`, the end of the piece in the muxer's own clock as its
 * segment list states it, the first packet is that end less the span of the
 * piece's samples: exact, because the span is a sum of sample durations and
 * the muxer's clock needs no track position. Without it, the first sample's
 * position is read, which the piece states only to within its position error.
 *
 * The muxer measures every cut time from its first packet of the reference
 * stream, not from the start it was asked for (measured on ffmpeg 8.1.2,
 * 2026-10-09: AAC copied from Matroska, asked to start at 10.385 s with its
 * first packet at 10.403 s and a cut at 10.386 s from the start, closed the
 * piece at 20.805 s — the first packet at or after 10.403 + 10.386). A copied
 * stream cannot start between its packets, so its first packet lies up to one
 * frame after the requested start, and every cut of the run moves by as much.
 *
 * @param {object} ranges - The first piece's media intervals.
 * @param {number} startSeconds - Where the run was asked to start.
 * @param {string} kind - The reference track: `vide` when the output carries a picture, else `soun`.
 * @returns {number | null}
 */
export function cutShiftOf(ranges, startSeconds, kind, endMicros = null) {
  const track = ranges?.tracks?.find((candidate) => candidate.kind === kind);
  const first = track?.ranges?.[0];
  if (!first || !(track.timescale > 0n) || !Number.isFinite(startSeconds)) return null;
  const timescale = Number(track.timescale);
  const firstSeconds = typeof endMicros === "bigint" && track.firstSampleStart !== undefined
    ? Number(endMicros) / 1_000_000 - Number(track.ranges.at(-1).end - track.firstSampleStart) / timescale
    : Number(first.start) / timescale;
  const shift = firstSeconds - startSeconds;
  const allowance = Number((track.productionFrame ?? first.frame) + (track.positionErrorTicks ?? 0n)) / timescale;
  return Math.abs(shift) <= allowance ? shift : null;
}

/** Compare adjacent production ranges in their declared track clocks. */
export function judgeNeighbors(left, right) {
  if (!left?.tracks?.length || !right?.tracks?.length) return { whole: false, reason: "neighbor-tracks-are-missing" };
  for (const track of right.tracks) {
    if (!left.tracks.some(previous => previous.kind === track.kind)) return { whole: false, reason: `neighbor-missing-${track.kind}` };
  }
  for (const track of left?.tracks ?? []) {
    const next = right?.tracks?.find(candidate => candidate.kind === track.kind);
    if (!next?.ranges?.length || !track.ranges?.length) return { whole: false, reason: `neighbor-missing-${track.kind}` };
    if (!(track.timescale > 0n) || !(next.timescale > 0n)) return { whole: false, reason: "neighbor-clock-is-invalid" };
    const end = track.ranges.at(-1), start = next.ranges[0];
    const difference = start.start * track.timescale - end.end * next.timescale;
    const leftFrame = (track.productionFrame ?? end.frame) * next.timescale;
    const rightFrame = (next.productionFrame ?? start.frame) * track.timescale;
    if (!(leftFrame > 0n) || !(rightFrame > 0n)) return { whole: false, reason: "neighbor-frame-is-invalid" };
    const allowance = leftFrame > rightFrame ? leftFrame : rightFrame;
    if (difference > allowance || difference < -allowance) return { whole: false, reason: `neighbor-discontinuity-${track.kind}` };
  }
  return { whole: true };
}

/**
 * Every required track must cover the interval with at most one-frame error,
 * on the clock the run's muxer cut by: the interval moved by `shift`
 * ({@link cutShiftOf}). A track's own end in the file is not moved.
 */
function intervalFailure(coverage, { from, to, requiredKinds, sourceEnds = {}, shift = 0 }) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || !(to > from) || !requiredKinds?.length) return "segment-interval-is-not-declared";
  for (const kind of requiredKinds) {
    const track = coverage?.tracks?.find(track => track.kind === kind);
    if (!track?.ranges?.length || !(track.timescale > 0n)) return `segment-missing-${kind}`;
    const start = BigInt(Math.round((from + shift) * Number(track.timescale)));
    const through = Number.isFinite(sourceEnds[kind]) ? Math.min(to + shift, sourceEnds[kind]) : to + shift;
    if (!(through > from + shift)) return `segment-interval-is-empty-${kind}`;
    const end = BigInt(Math.round(through * Number(track.timescale)));
    const first = track.ranges[0];
    const frame = track.productionFrame ?? first.frame;
    // The muxer rounds an empty edit to movie ticks independently of sample
    // cadence. Account for that recorded position uncertainty at the boundary,
    // without admitting another missing frame or widening internal gaps.
    const positionError = track.positionErrorTicks ?? 0n;
    if (first.start > start + frame + positionError || first.start < start - frame - positionError) return `segment-start-outside-interval-${kind}`;
    // The first sample's cadence already bounds the interval start. A shorter
    // final sample must not replace that bound when this range is traversed.
    let reached = first.start;
    for (const range of track.ranges) {
      if (!(range.frame > 0n) || range.end <= range.start || range.start > reached + range.frame) return `segment-gap-within-interval-${kind}`;
      if (range.end > reached) reached = range.end;
    }
    const finalFrame = track.productionFrame ?? track.ranges.at(-1).frame;
    if (reached < end - finalFrame - positionError || reached > end + finalFrame + positionError) return `segment-end-outside-interval-${kind}`;
  }
  return null;

}
