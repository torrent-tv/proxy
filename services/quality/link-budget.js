/**
 * @file What the viewer's link can carry, and what a height would ask of it.
 *
 * TWO PURE FUNCTIONS, and that is the whole point of the file: the viewer's
 * connection enters the quality budget as a NUMBER — how many megabits the last
 * report showed — and never as a reference to a viewer. So nothing here holds
 * anybody, reads anything or can be asked at the wrong moment; it is arithmetic
 * over readings somebody else took.
 *
 * They lived in the session manager, where the first of them reached for the
 * worst reading among the viewers itself. That is the reach the layer table
 * forbids in as many words: the link is an input to encoding, not a thing
 * encoding may go and look at.
 */

import { maxrateKbpsFor, nominalKbpsForHeight } from "../encode/args.js";

/**
 * How much of a measured link may be spent on video.
 *
 * The rest is what the link does when it is not being perfect: retransmission,
 * the other tabs, the moment somebody else in the house starts something. A
 * step sized to the whole reading stalls on the first of those.
 *
 * Chosen, not measured, and written as a constant rather than dressed up as a
 * measurement. What would replace it is a reading of how far a link's own
 * throughput varies over a session, which nothing takes.
 */
export const LINK_SAFETY = 0.8;

/**
 * The most a stream at this height would ask of the link, in megabits a second.
 *
 * A COPIED source is the one case where the answer is known rather than
 * predicted: the file states its own bitrate, and copying does not change it.
 * Everything else is what the rate cap would be set to at that height, since
 * that is the ceiling the encoder is actually held to.
 *
 * @param {{ sourceHeight: number, transcodeVideo: boolean, sourceMbps: number | null }} picture
 * @param {number} height
 * @returns {number}
 */
export function peakMbpsForHeight(picture, height) {
  const sourceHeight = Math.round(Number(picture?.sourceHeight) || 0);
  if (height === sourceHeight && picture?.transcodeVideo !== true) {
    const sourceMbps = Number(picture?.sourceMbps);
    if (Number.isFinite(sourceMbps) && sourceMbps > 0) {
      return sourceMbps;
    }
  }
  return maxrateKbpsFor(nominalKbpsForHeight(height)) / 1000;
}

/**
 * Whether a link that measured `linkMbps` can carry a stream asking for
 * `wantedMbps`.
 *
 * @param {number | null} linkMbps - The WORST reading among the viewers, taken
 *   by whoever holds them. Null when nothing has measured the link, and then
 *   the link has no opinion either way — which is the same silence that stops
 *   the budget acting at all, and is deliberately a yes rather than a no.
 * @param {number} wantedMbps
 * @returns {boolean}
 */
export function linkCouldCarry(linkMbps, wantedMbps) {
  if (!Number.isFinite(linkMbps) || !(linkMbps > 0)) {
    return true;
  }
  return linkMbps * LINK_SAFETY >= wantedMbps;
}
