/**
 * @file The host a `Renditions` is built on in a check: the viewers' records as
 * production has them, and inert ports for everything else
 * (torrent-tv/meta#309).
 *
 * The viewer relations are `viewerRelationsFor`, the function
 * `server/wire-outputs.js` spreads into its own host, so a check cannot drift
 * from production by leaving one out — three copies had.
 */

import { viewerRelationsFor } from "../../../services/viewer/choices.js";

/**
 * @param {object} viewers - A `Viewers`.
 * @param {object} [overrides] - Ports that replace the helper's, and any the
 *   helper does not give (`outputs`, `createOrGetSession`, `logger`, ...).
 * @returns {object} The host to pass to `new Renditions(...)`.
 */
export function renditionsHost(viewers, overrides = {}) {
  return {
    ...viewerRelationsFor(viewers),
    // Nobody has a position and nothing is on screen unless a check says so.
    viewerSecondsOn: () => 0,
    viewerPositionOf: () => 0,
    encodeRuns: { isLive: () => true },
    quality: { variantsOnScreen: () => new Set() },
    ...overrides
  };
}
