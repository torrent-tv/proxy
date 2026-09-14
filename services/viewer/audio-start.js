/**
 * @file Where a soundtrack must begin.
 *
 * ASKED OF THE PEOPLE, NOT OF A SESSION. Sound is produced for the same reason
 * a picture is — somebody is going to hear it — so the question is where the
 * earliest of them stands, across every rung of that picture: a track begun at
 * the leader has nothing to give the viewer behind them, and two viewers of one
 * film may be watching at different qualities.
 *
 * NO SUBTRACTION, and that is the whole of what this replaced: three position
 * sources ranked by priority, a second function naming which had answered, a
 * subtraction of the deepest reported buffer, and a special case for a session
 * nobody had asked anything of. Each repaired a quantity that meant two things.
 * A viewer's position is where their PICTURE is, so the sound belongs exactly
 * there. Field 2026-08-31, what the subtraction cost: a page opened at 588 s
 * started its sound at 460 s — 131 seconds nobody would hear
 * (`research/cold-open-audio-start-2026-08-31.md`).
 *
 * It decides ONE PARAMETER of an output and places no encoder: where an encoder
 * works is the priority map's answer. Pure over plain values — the outputs of
 * one picture, where it was opened, and how long a piece is — so it knows
 * nothing of ffmpeg, cut grids or the disk.
 */

import { earliestViewerSecondsOn } from "./positions.js";

/**
 * @param {object} params
 * @param {Iterable<object>} params.family - Every output of one picture: the
 *   picture itself and its quality steps. The viewers are spread across them.
 * @param {number} params.openedAtSeconds - Where the picture was opened, which
 *   is the answer while nobody has stated a position yet.
 * @param {number} params.segmentSeconds - How long one piece is.
 * @returns {number} Seconds, never negative.
 */
export function audioStartSecondsFor({ family, openedAtSeconds, segmentSeconds }) {
  const earliest = earliestViewerSecondsOn(family);
  const opened = Number(openedAtSeconds);
  const from = earliest ?? (Number.isFinite(opened) ? opened : 0);
  // ONE PIECE BACK, and that is not a margin: a cut grid places the
  // soundtrack's own boundaries where it will, so the piece holding a moment of
  // film begins at or before it.
  const back = Number.isFinite(segmentSeconds) && segmentSeconds > 0 ? segmentSeconds : 0;
  return Math.max(0, from - back);
}
