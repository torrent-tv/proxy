/**
 * @file What the viewers of one output say about their links, as one reading.
 *
 * The budget asks one question — is anybody failing to keep up — so both terms
 * are the worst case: the slowest link and the emptiest buffer, which may
 * belong to different people. Taking the last report instead meant a session
 * with two viewers acted on whichever of them happened to report most recently.
 *
 * NOTHING HERE EXPIRES, and that is the correction of 2026-09-14. A reading
 * used to be discarded once it was older than a chosen thirty seconds, which
 * conflated two facts under one number: how fast the link is, and whether we
 * are still hearing from the page. The first persists — a link does not stop
 * being what it was measured to be because nobody measured it for a minute,
 * which is why the page itself keeps its last figure for ever. The second is
 * PRESENCE, and presence has its own owner: a viewer who has gone is removed
 * from the output, so what is walked here is only people who are still here.
 *
 * The reading is corrected continuously while material crosses the link, which
 * is the whole shape: measured once when the connection comes up, corrected by
 * every transfer after it.
 */

import { viewersOf } from "./Viewer.js";

/**
 * @param {object} output - The session whose viewers are asked.
 * @returns {{ linkMbps: number, bufferedAheadSec: number, at: number, viewers: number } | null}
 *   Null when nobody present has ever measured their link, which every caller
 *   already treats as "no opinion either way".
 */
export function worstLinkReading(output) {
  let worst = null;
  for (const viewer of viewersOf(output).values()) {
    if (!viewer.isPresent()) {
      continue;
    }
    const reading = viewer.linkReading();
    if (reading === null) {
      continue;
    }
    if (worst === null) {
      worst = {
        linkMbps: reading.linkMbps,
        bufferedAheadSec: reading.bufferedAheadSec,
        at: reading.at,
        viewers: 1
      };
      continue;
    }
    worst.linkMbps = Math.min(worst.linkMbps, reading.linkMbps);
    worst.bufferedAheadSec = Math.min(worst.bufferedAheadSec, reading.bufferedAheadSec);
    worst.at = Math.max(worst.at, reading.at);
    worst.viewers += 1;
  }
  return worst;
}
