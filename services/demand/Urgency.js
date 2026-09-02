/**
 * @file How urgent a stated need is, and what follows from that.
 *
 * Five levels, ordered. The ordering is not a set of numbers handed to
 * WebTorrent — measured 2026-09-02, the library does not keep them. Its picker
 * sorts selections by priority only at the moment one is inserted, and then, on
 * every wire it fills, moves the selection it just served to the BACK of the
 * whole group with a non-zero priority:
 *
 * ```js
 * function shufflePriority (i) {
 *   let last = i
 *   for (let j = i; j < self._selections.length && self._selections.get(j).priority; j++) last = j
 *   self._selections.swap(i, last)
 * }
 * ```
 *
 * So distinct non-zero numbers give an order once and a round robin thereafter.
 * Only two things hold: non-zero rotates fairly, zero is always last.
 *
 * Therefore urgency here is expressed by WHETHER a need is stated to the swarm
 * at all. A level is stated only while every level above it is satisfied, and
 * withdrawn the moment one is not — a withdrawn need is not in the download set
 * at all, so a peer with nothing urgent to give cannot fall through to it and
 * spend the shared link on it. A permanently low priority does exactly that,
 * which is why it is not what this does.
 *
 * The rotation is not merely tolerated, it is wanted: with two viewers of one
 * film both stopped, both their needs sit at {@link Urgency.BLOCKED} and the
 * swarm alternates between them instead of always serving whoever asked first.
 */

/**
 * The levels, most urgent first. The value is the position, so `<` compares
 * urgency and nothing else may be read into it.
 *
 * @enum {number}
 */
export const Urgency = {
  /**
   * The bytes a reader is stopped on. The picture is not moving until they
   * arrive.
   */
  BLOCKED: 0,
  /**
   * The rest of that reader's own window — the cushion being built. Late here
   * and the picture stops in a few seconds.
   */
  NEAR: 1,
  /**
   * Further along the file, as far as the encoder will reach. Late here costs
   * nothing yet.
   */
  AHEAD: 2,
  /**
   * To the end of the file. Wanted for certain if the viewer watches on, and
   * not before anything above is satisfied.
   */
  TAIL: 3,
  /**
   * The gap behind the playhead, left by a forward seek. Wanted only if the
   * viewer seeks back, so it is last — but it is real: a backward seek into a
   * hole is the longest wait this proxy produces (field: 93 s).
   */
  BEHIND: 4
};

/** Every level, most urgent first. */
export const URGENCY_ORDER = [
  Urgency.BLOCKED,
  Urgency.NEAR,
  Urgency.AHEAD,
  Urgency.TAIL,
  Urgency.BEHIND
];

/**
 * Whether a level may take a block away from a slow peer and give it to a fast
 * one — WebTorrent's `critical`.
 *
 * Only the level that is being waited on. Displacement throws away the part of
 * the block the slow peer had already fetched, so it buys time exactly where
 * time is what is short, and wastes bandwidth everywhere else.
 *
 * @param {number} urgency
 * @returns {boolean}
 */
export function mayDisplaceSlowPeer(urgency) {
  return urgency === Urgency.BLOCKED;
}

/**
 * Whether a level is stated to the swarm only while the levels above it want
 * nothing.
 *
 * The three urgent levels are always stated: they are what the viewer is
 * waiting for. The two speculative ones are stated only in the room the urgent
 * ones leave.
 *
 * @param {number} urgency
 * @returns {boolean}
 */
export function isConditional(urgency) {
  return urgency >= Urgency.TAIL;
}

/**
 * The number handed to `torrent.select`.
 *
 * Two values only, because two is all the library keeps: everything urgent
 * shares one non-zero priority and rotates fairly among itself; the
 * speculative levels take zero, which the library always places last and never
 * rotates into the group above.
 *
 * @param {number} urgency
 * @returns {number}
 */
export function selectionPriority(urgency) {
  return isConditional(urgency) ? 0 : 1;
}

/**
 * A level's name, for the log.
 *
 * @param {number} urgency
 * @returns {string}
 */
export function urgencyName(urgency) {
  switch (urgency) {
    case Urgency.BLOCKED: return "blocked";
    case Urgency.NEAR: return "near";
    case Urgency.AHEAD: return "ahead";
    case Urgency.TAIL: return "tail";
    case Urgency.BEHIND: return "behind";
    default: return `urgency-${urgency}`;
  }
}
