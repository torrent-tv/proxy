/**
 * @file Which rung of the ladder the picture a viewer sees asks for (roadmap
 * item 98).
 *
 * THE RULE, stated by the user 2026-09-27: the smallest height of the ladder
 * whose frame is not smaller than the visible picture — both its width and its
 * height. The visible picture is what the viewer's page measured: the frame
 * that would be shown without being enlarged, in physical pixels
 * (`server/public/domain/visible-picture.js`). A frame smaller than that is
 * enlarged on screen and loses detail; a larger one costs encoder and link for
 * detail the screen cannot show.
 *
 * When no rung is large enough — a picture shown bigger than the source — the
 * answer is the top rung, the source's own size: nothing is ever made larger
 * than the source.
 *
 * It bounds only a RE-ENCODED picture. A copy of the source is not re-encoded
 * because it is taller than the picture on screen; it is re-encoded only when
 * the browser cannot play it or the viewer's link cannot carry it (the rule is
 * in "Key decisions" of the project notes).
 */

import { buildResolutionLadder } from "../hwaccel.js";

/**
 * The rung of `ladder` the visible picture asks for.
 *
 * @param {Array<{ width: number, height: number }>} ladder - Highest first, as
 *   `buildResolutionLadder` gives it.
 * @param {{ width: number, height: number } | null} visible
 * @returns {{ width: number, height: number } | null} Null when nothing was
 *   measured or there is no ladder.
 */
export function rungForVisiblePicture(ladder, visible) {
  if (!Array.isArray(ladder) || ladder.length === 0 || !(visible?.width > 0) || !(visible?.height > 0)) {
    return null;
  }
  const large = ladder.filter((rung) => rung.width >= visible.width && rung.height >= visible.height);
  return large.length > 0 ? large[large.length - 1] : ladder[0];
}

/**
 * The height a re-encoded picture of this source is bounded by for a viewer
 * who sees `visible`, or null when nothing bounds it.
 *
 * @param {number} sourceWidth
 * @param {number} sourceHeight
 * @param {{ width: number, height: number } | null} visible
 * @returns {number | null}
 */
export function visibleHeightCap(sourceWidth, sourceHeight, visible) {
  const rung = rungForVisiblePicture(
    buildResolutionLadder(Math.round(Number(sourceWidth) || 0), Math.round(Number(sourceHeight) || 0)),
    visible
  );
  return rung ? rung.height : null;
}
