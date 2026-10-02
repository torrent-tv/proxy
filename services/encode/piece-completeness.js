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
    ? timeline.publishedStartOf(index + 1) - SEGMENT_CUT_TIME_DELTA_SECONDS
    : undefined;
}

/**
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
  if (Number.isFinite(cutSeconds) && throughSeconds < cutSeconds) {
    return { whole: false, throughSeconds };
  }
  return { whole: true, throughSeconds };
}
