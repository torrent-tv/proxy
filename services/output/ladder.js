/**
 * @file The heights a picture may be offered at.
 *
 * A fact about an output and about nothing else: it takes a source height and
 * answers with heights. What the machine can afford of them is the quality
 * budget's question, and what a player may splice between is `LiveOutputs`.
 */

// The resolutions a viewer may choose between. Only rungs at or below the
// source are offered: upscaling invents detail and costs the encoder more than
// the source itself.
const VARIANT_LADDER = [2160, 1440, 1080, 720, 540, 480, 360, 240];

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
  const rungs = VARIANT_LADDER.filter((height) => height < sourceHeight);
  return [Math.round(sourceHeight), ...rungs];
}
