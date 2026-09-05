/**
 * @file How many encoders this machine can afford on one output.
 *
 * Not how many are wanted — that is the demand map's answer — but how many can
 * run at once without making things worse. It is the SMALLEST of several
 * limits, and every one of them is measured:
 *
 * 1. **the processor.** A second encoder slows the first: measured on the addon
 *    host at 1.70x for two at 854x480 and 1.98x at 1920x1080. The ladder is
 *    walked while the measured penalty still leaves every encoder above
 *    realtime, and it stops where the measurements stop rather than continuing
 *    a curve two points cannot describe;
 * 2. **the swarm.** Every encoder reads the same torrent, so together they
 *    cannot consume faster than it is delivered. On the field file of
 *    2026-09-05 a second of film weighs 842 KB and the swarm gave 2119-3347
 *    KB/s, so the encoders' speeds together may reach 2.5-4x — which is why a
 *    copy the processor would run at 8x runs at four, and why a third encoder
 *    makes all three slower rather than adding anything;
 * 3. **memory for the torrent's pieces.** Encoders placed far apart hold
 *    windows that do not overlap, so the store must hold their SUM. On the
 *    addon host the store was already full on the readers of one viewer — "6
 *    readers want 14 pieces of 14 the store may hold" — so this is the limit
 *    that binds first there, not the processor.
 *
 * Which of them bound the answer is returned beside it, because "why is there
 * only one encoder" is otherwise a question no log can answer.
 *
 * **Only the first is supplied today.** The two readings the others need are
 * both in the torrent thread — what the swarm delivers against the film's own
 * byte rate, and the store's allowance against what one reader keeps — and
 * carrying them across is its own piece of work, deliberately not done here.
 * Until it is, the swarm and the memory terms are inert: this returns what the
 * processor allows, and says so. Stated rather than left to be discovered from
 * a parameter nobody passes.
 */

/**
 * @typedef {object} RunBudget
 * @property {number} runs - How many encoders may run on this output.
 * @property {string} because - Which limit decided it.
 */

/**
 * @param {object} params
 * @param {number} params.byProcessor - What the processor allows, from the
 *   measured speed and the measured penalty for concurrency. At least one.
 * @param {number} [params.speedX] - The measured speed of one encoder here.
 * @param {number} [params.refetchSecPerFilmSecond] - Seconds of swarm time per
 *   second of film: the film's own byte rate over what the swarm delivers. One
 *   encoder at speed `s` therefore consumes `s * refetch` of the swarm, and
 *   what they may consume together is all of it. Absent where neither rate has
 *   been measured, and then the swarm does not bound the answer.
 * @param {number} [params.storeBytes] - What the piece store may hold.
 * @param {number} [params.readerWindowBytes] - What one encoder's reader keeps.
 * @returns {RunBudget}
 */
export function affordableRuns({
  byProcessor,
  speedX,
  refetchSecPerFilmSecond,
  storeBytes,
  readerWindowBytes
}) {
  let runs = Number.isFinite(byProcessor) && byProcessor > 0 ? Math.floor(byProcessor) : 1;
  let because = "the processor";

  // The swarm. One encoder at speed `s` takes `s * refetch` of what is
  // delivered, and everything running takes the sum, which cannot pass one.
  if (
    Number.isFinite(refetchSecPerFilmSecond) &&
    refetchSecPerFilmSecond > 0 &&
    Number.isFinite(speedX) &&
    speedX > 0
  ) {
    const bySwarm = Math.max(1, Math.floor(1 / (speedX * refetchSecPerFilmSecond)));
    if (bySwarm < runs) {
      runs = bySwarm;
      because = "what the swarm delivers";
    }
  }

  // Memory: encoders far apart hold windows that do not overlap.
  if (
    Number.isFinite(storeBytes) &&
    storeBytes > 0 &&
    Number.isFinite(readerWindowBytes) &&
    readerWindowBytes > 0
  ) {
    const byMemory = Math.max(1, Math.floor(storeBytes / readerWindowBytes));
    if (byMemory < runs) {
      runs = byMemory;
      because = "memory for the torrent's pieces";
    }
  }

  return { runs: Math.max(1, runs), because };
}
