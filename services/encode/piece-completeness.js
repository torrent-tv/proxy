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
 * @param {{ from: number, to: number, requiredKinds: string[], sourceEnds?: object, endsWithSource?: boolean }} [interval]
 * @returns {{ whole: boolean, throughSeconds: number | null, reason?: string }}
 */
export function judgePiece(format, ranges, cutSeconds, interval) {
  const throughSeconds = format.producedThroughSeconds?.(ranges) ?? null;
  if (throughSeconds === null) {
    return { whole: false, throughSeconds };
  }
  const shift = Number.isFinite(ranges?.cutShiftSeconds) ? ranges.cutShiftSeconds : 0;
  if (interval) {
    const reason = intervalFailure(ranges, { ...interval, shift, nextLeadingSeconds: leadingOfNext(ranges) });
    return reason ? { whole: false, throughSeconds, reason } : { whole: true, throughSeconds };
  }
  const cutMicros = Number.isFinite(cutSeconds) ? BigInt(Math.round((cutSeconds + shift) * 1_000_000)) : null;
  if (cutMicros !== null && ranges?.tracks?.length) {
    const leadMicros = BigInt(Math.round(leadingOfNext(ranges) * 1_000_000));
    const whole = ranges.tracks.every(({ kind, timescale, ranges: held, positionErrorTicks = 0n }) => {
      const end = held.at(-1)?.end;
      return end !== undefined && (end + positionErrorTicks) * 1_000_000n >= (cutMicros - (kind === "vide" ? leadMicros : 0n)) * timescale;
    });
    return { whole, throughSeconds };
  }
  if (cutMicros !== null && throughSeconds < Number(cutMicros) / 1_000_000) {
    return { whole: false, throughSeconds };
  }
  return { whole: true, throughSeconds };
}

/**
 * How long a picture's leading pictures are shown before it: the span from the
 * first presented picture of a piece to its first decoded one, which for a
 * copied picture is its keyframe. Zero without a picture or leading pictures.
 *
 * In an open GOP the pictures decoded right after a keyframe can be shown
 * before it. They belong to the piece of their keyframe, so the piece before
 * ends that much before its cut and this piece begins that much before it
 * (torrent-tv/meta#178). A piece states the next keyframe's span as
 * `nextLeadingSeconds`, read from the piece the muxer closed after it.
 *
 * @param {object | null | undefined} ranges - A piece's media intervals.
 * @returns {number}
 */
export function leadingSecondsOf(ranges) {
  const track = ranges?.tracks?.find(candidate => candidate.kind === "vide");
  const first = track?.ranges?.[0];
  if (!first || track.firstSampleStart === undefined || !(track.timescale > 0n)) return 0;
  const lead = track.firstSampleStart - first.start;
  return lead > 0n ? Number(lead) / Number(track.timescale) : 0;
}

/**
 * Whether the only gap between two adjacent pieces is the right one's leading
 * pictures, which it lacks: it begins at its keyframe, and the gap is the span
 * the left one states it ends short by, within a frame. A run that starts at a
 * keyframe cannot make those pictures and none was left by a run before it, so
 * the picture stands that long — known, and no fault of either piece.
 *
 * @param {object} left
 * @param {object} right
 * @returns {boolean}
 */
export function lacksOnlyItsLeadingPictures(left, right) {
  const before = left?.tracks?.find(track => track.kind === "vide");
  const after = right?.tracks?.find(track => track.kind === "vide");
  if (!before?.ranges?.length || !after?.ranges?.length || before.timescale !== after.timescale || leadingSecondsOf(right) !== 0) return false;
  const lead = BigInt(Math.round(leadingOfNext(left) * Number(before.timescale)));
  const gap = after.ranges[0].start - before.ranges.at(-1).end;
  const frame = before.productionFrame ?? before.ranges.at(-1).frame;
  return lead > 0n && gap > 0n && gap - lead <= frame && lead - gap <= frame;
}

/** The span a piece ends before its cut: the next keyframe's leading pictures. */
function leadingOfNext(ranges) {
  return Number.isFinite(ranges?.nextLeadingSeconds) && ranges.nextLeadingSeconds > 0 ? ranges.nextLeadingSeconds : 0;
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
 *
 * `endsWithSource` marks the final piece of a film. Its input is the rest of
 * the file, and it is published only by a run that reached the end of that
 * input, so a track that stops before the interval's end stops there in the
 * file too: the end the piece shows is the track's own, and only a track
 * running past the interval is refused. Where the input states a track's end
 * (`sourceEnds`), that end is held to as before. Field 2026-10-09, Drifters
 * episode 1: the picture's last packet ends at 1419.92 s and the separate
 * soundtrack's at 1419.904 s against a final cut of 1419.993 s, and both last
 * pieces were refused, so no viewer could reach the end of the episode.
 */
function intervalFailure(coverage, { from, to, requiredKinds, sourceEnds = {}, shift = 0, shiftByKind = {}, endsWithSource = false, nextLeadingSeconds = 0 }) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || !(to > from) || !requiredKinds?.length) return "segment-interval-is-not-declared";
  for (const kind of requiredKinds) {
    const track = coverage?.tracks?.find(track => track.kind === kind);
    if (!track?.ranges?.length || !(track.timescale > 0n)) return `segment-missing-${kind}`;
    const trackShift = Number.isFinite(shiftByKind[kind]) ? shiftByKind[kind] : shift;
    const start = BigInt(Math.round((from + trackShift) * Number(track.timescale)));
    const cutAt = to + trackShift - (kind === "vide" && !endsWithSource ? nextLeadingSeconds : 0);
    const through = Number.isFinite(sourceEnds[kind]) ? Math.min(cutAt, sourceEnds[kind]) : cutAt;
    if (!(through > from + trackShift)) return `segment-interval-is-empty-${kind}`;
    const end = BigInt(Math.round(through * Number(track.timescale)));
    const first = track.ranges[0];
    const frame = track.productionFrame ?? first.frame;
    // The muxer rounds an empty edit to movie ticks independently of sample
    // cadence. Account for that recorded position uncertainty at the boundary,
    // without admitting another missing frame or widening internal gaps.
    const positionError = track.positionErrorTicks ?? 0n;
    // A piece starts at its first DECODED sample — a copied picture's keyframe;
    // pictures shown before it are its leading pictures, and the walk below
    // holds them to the same continuity as every other range.
    const anchor = track.firstSampleStart ?? first.start;
    if (anchor > start + frame + positionError || anchor < start - frame - positionError) return `segment-start-outside-interval-${kind}`;
    // The first sample's cadence already bounds the interval start. A shorter
    // final sample must not replace that bound when this range is traversed.
    let reached = first.start;
    for (const range of track.ranges) {
      if (!(range.frame > 0n) || range.end <= range.start || range.start > reached + range.frame) return `segment-gap-within-interval-${kind}`;
      if (range.end > reached) reached = range.end;
    }
    const finalFrame = track.productionFrame ?? track.ranges.at(-1).frame;
    const endsInFile = endsWithSource && !Number.isFinite(sourceEnds[kind]);
    if ((reached < end - finalFrame - positionError && !endsInFile) || reached > end + finalFrame + positionError) {
      return `segment-end-outside-interval-${kind}`;
    }
  }
  return null;

}
