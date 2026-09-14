/**
 * @file How long material nobody is using is kept.
 *
 * ONE NUMBER, IN ONE PLACE, because everything it governs stands for the same
 * unmeasured thing: whether the viewer comes back. Everything else in the
 * decision is measured or measurable — re-downloading a piece from the swarm is
 * ~1430 ms on the field host, re-making a segment is its own encode time, and
 * the disk now has an owner that prices holding it. Only the return is unknown,
 * and a period is what stands in for it.
 *
 * IT WAS THREE NUMBERS AND THEY CONTRADICTED EACH OTHER (read 2026-09-10):
 *
 *   torrent and its downloaded bytes   15 minutes
 *   session                            30 minutes
 *   produced segments                   6 hours
 *
 * The torrent therefore went at fifteen minutes while the session it feeds
 * lived to thirty, so between them there was a session with no source: a viewer
 * returning at the twentieth minute got a session that could not make a single
 * new segment until the torrent was added again. That is not two answers to one
 * question, it is a contradiction — and it is what two independent guesses about
 * one unknown produce.
 *
 * With one hour for both kinds of material the session dies first, which is the
 * right order and needs no rule of its own to enforce.
 *
 * WHY AN HOUR, honestly: nothing derives it. It is a stand-in, chosen to be
 * long enough that an interruption — a phone call, a meal — does not cost the
 * film, and short enough that a household disk is not held for a day by
 * somebody who is not coming back. It is the OWNER'S disk, and holding
 * gigabytes on it because there happens to be room is taking something that is
 * not ours.
 *
 * WHAT REPLACES IT, and the proxy is already in a position to measure it: every
 * session opened on an output whose segments are still on disk IS a return, and
 * its age is known. `services/disk/returns.js` records them. A week of those and
 * the distribution answers this directly — keep material for as long as returns
 * actually happen — and then the two kinds can have different numbers, since
 * their costs of coming back differ.
 */

/**
 * How long material nobody has read is kept, in milliseconds.
 *
 * Read by the torrent pool for a torrent and its downloaded bytes, and by the
 * session manager for the segments an encoder produced.
 */
export const IDLE_KEEP_MS = 60 * 60 * 1000;
