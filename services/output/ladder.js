/**
 * @file The heights a picture may be offered at.
 *
 * A fact about an output and about nothing else: it takes a source height and
 * answers with heights. What the machine can afford of them is the quality
 * budget's question, and what a player may splice between is `LiveOutputs`.
 */

/**
 * The standard heights, high to low. One list for both uses: the heights the
 * menu offers, and the rungs the realtime budget steps down through below a
 * viewer's own screen size. They were two lists with the same values, and two
 * owners of one fact drift apart.
 *
 * Only rungs below the source are used: upscaling invents detail and costs the
 * encoder more than the source itself.
 */
export const LADDER_HEIGHTS = Object.freeze([2160, 1440, 1080, 720, 540, 480, 360, 240]);

/**
 * The heights offered for a source of this height, largest first.
 *
 * @param {number} sourceHeight
 * @returns {number[]}
 */
export function variantHeightsFor(sourceHeight) {
  if (!Number.isFinite(sourceHeight) || sourceHeight <= 0) {
    return [];
  }
  const rungs = LADDER_HEIGHTS.filter((height) => height < sourceHeight);
  return [Math.round(sourceHeight), ...rungs];
}
