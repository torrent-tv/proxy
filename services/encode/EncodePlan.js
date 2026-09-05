/**
 * @file How many encoders there should be on one output, and where each of them
 * belongs — decided from numbers alone.
 *
 * The decision is separated from carrying it out on purpose. Every rule below
 * was previously a condition somewhere inside an eleven-thousand-line file,
 * reachable only by starting a real ffmpeg, and each of them was written for
 * one viewer:
 *
 * - a run was placed at the position of whoever asked, and never at the first
 *   thing missing, so a viewer moving into a stretch already on disk restarted
 *   an encoder to make it a second time;
 * - a run had no end at all — neither `-to` nor `-t` appeared anywhere — so it
 *   ran until something killed it, and two runs on one output could not exist
 *   without writing over each other;
 * - nothing stopped a run that had caught up with material somebody else had
 *   already made.
 *
 * The rule this file exists to express, stated by the user 2026-09-04:
 *
 * > Viewers are always independent and always reuse what can be reused. The
 * > number of encoders is however many are needed; how many are needed follows
 * > from which sets of output parameters are wanted and where the viewers stand
 * > inside each. Segments produced by ANY encoder are available to ANY viewer,
 * > and which viewer asked never enters the question.
 *
 * So no name of a viewer reaches this file. It is given what is wanted, what
 * exists, what is being made, and what the machine can afford.
 *
 * **A viewer decides the ORDER the map is walked in and, through the budget, how
 * many processes walk it. Nothing else.** Stated by the user 2026-09-05, and it
 * is the rule the rest of this file now follows: while a file is being encoded
 * it is encoded WHOLE, in the order the map dictates. Who wants which segment
 * decides which gap is closed first, never whether a run may go on living.
 *
 * **A run is therefore never stopped for standing outside a viewer's window.**
 * It used to be, and the two decisions that produced that were in direct
 * contradiction — measured in the field 2026-09-05 on a viewer watching an
 * episode:
 *
 * 1. this file commanded a start inside the window, at #46;
 * 2. `planRunInterval` in the session manager moved the start to #78, because
 *    it counted a suspended run's claim as reaching `head + look-ahead`;
 * 3. this file then saw a run at #78 against a window of [27, 57], found no
 *    overlap, and killed it as "nothing it was given is wanted";
 * 4. neither coverage nor demand had changed, so the same start was commanded
 *    again — 350-700ms per cycle, dozens of times, no segment ever produced,
 *    the viewer's picture stopped for 125 seconds.
 *
 * Both of those other authorities are gone (roadmap item 76, step 5). What is
 * left is this file, and the only reasons it stops a run are: nobody is
 * watching the output at all; the machine affords fewer processes; or there is
 * nothing left unmade anywhere in the track.
 *
 * **A run's end comes from the coverage**, never from a window: it runs until
 * it meets material somebody else has made or is making, or until the end of
 * the film.
 */

/**
 * One encoder that is running now.
 *
 * @typedef {object} LiveRun
 * @property {string} id
 * @property {number} from - The first number it was given.
 * @property {number} to - The last number it was given, inclusive.
 * @property {number} head - The next number it will produce. Its position.
 * @property {number} speedX - Measured encode speed against realtime, from
 *   ffmpeg's own progress. Zero or less means nothing has measured it yet, and
 *   then no comparison involving its speed can be made.
 */

/**
 * What a viewer is waiting for. Which viewer is deliberately absent.
 *
 * @typedef {object} WantedSpan
 * @property {number} from
 * @property {number} to
 */

/**
 * @typedef {{ type: "start", from: number, to: number, because: string }
 *   | { type: "move", run: object, from: number, to: number, because: string }
 *   | { type: "stop", run: object, because: string }
 *   | { type: "keep", run: object, from: number, to: number }} PlanAction
 */

/**
 * Decide what to do with the encoders on one output.
 *
 * @param {object} params
 * @param {import("./CoverageMap.js").CoverageMap} params.coverage - What has
 *   been made and what is being made.
 * @param {WantedSpan[]} params.windows - What viewers are waiting for, one
 *   window each. Empty means nobody is watching this output.
 * @param {LiveRun[]} params.runs - The encoders running on it now.
 * @param {number} params.maxRuns - How many encoders this machine can afford on
 *   this output. Comes from the same arithmetic that decides the quality offer;
 *   it is measured per host and never chosen here.
 * @param {number} params.segmentSeconds - How much film one segment holds.
 * @param {number} params.restartCostSec - What it costs to stop an encoder and
 *   start it somewhere else: process start plus opening the input. Measured —
 *   0.12 s on the addon host, 0.5-0.6 s on a desktop.
 * @returns {PlanAction[]} Stops first, then moves, then starts, so that a plan
 *   carried out in order never holds two encoders where it means to hold one.
 */
export function planEncoders({
  coverage,
  windows,
  runs,
  maxRuns,
  segmentSeconds,
  restartCostSec,
  killCostSec = 0,
  firstByteWaitSec = 0,
  refetchSecPerFilmSecond = 0
}) {
  /** @type {PlanAction[]} */
  const stops = [];
  /** @type {PlanAction[]} */
  const moves = [];
  /** @type {PlanAction[]} */
  const starts = [];
  /** @type {PlanAction[]} */
  const keeps = [];

  const wanted = Array.isArray(windows) ? windows : [];
  const live = Array.isArray(runs) ? runs : [];

  // Nobody is watching this output: every encoder on it is making segments for
  // no one. This is the case a look-ahead cannot answer, because look-ahead
  // asks how far AHEAD of a viewer a run is and there is no viewer.
  if (wanted.length === 0) {
    for (const run of live) {
      stops.push({ type: "stop", run, because: "nobody is watching this output" });
    }
    return stops;
  }

  // How far a search for a gap needs to look: past the furthest thing anybody
  // is waiting for there is nothing to decide about.
  const demandTo = Math.max(...wanted.map((span) => span.to));

  /** Runs that survive this pass. @type {Set<object>} */
  const surviving = new Set();

  for (const run of live) {
    // 1. A RUN IS NEVER STOPPED FOR STANDING OUTSIDE A WINDOW. While a file is
    //    being encoded it is encoded whole; a viewer decides the ORDER the work
    //    is taken in and, through the budget, how many processes take it.
    //
    //    This used to stop a run whose stretch touched no window, and that
    //    decision contradicted the one below it: the run was placed by a search
    //    the retention test did not accept, so it was killed on the pass after
    //    it started and started again in the same place — 350-700ms per cycle in
    //    the field on 2026-09-05, no segment ever produced, the viewer's picture
    //    stopped for 125 seconds.
    //
    // 2. Has it arrived at material that already exists, or that another run is
    //    making? Its own claim does not count against it.
    const coveredAhead = coverage.coveredRunFrom(run.head, run);
    if (coveredAhead === 0) {
      surviving.add(run);
      keeps.push({ type: "keep", run, from: run.head, to: run.to });
      continue;
    }

    // Where it would go instead: the first thing nobody has and nobody is
    // making, at or after where it stands.
    const gap = coverage.firstGapFrom(run.head, demandTo, run);
    if (gap === null) {
      stops.push({
        type: "stop",
        run,
        because: "everything wanted ahead of it is already made or being made"
      });
      continue;
    }

    // WHICH IS CHEAPER, AND BOTH SIDES COUNTED WHOLE.
    //
    // Driving through material that exists costs this run's own encode time for
    // it, and costs the swarm the same bytes a second time — the film has to be
    // fetched again to be encoded again.
    //
    // Moving costs the death of this run, the start of another, and the wait
    // for the first bytes at the new position. The last of those is the largest
    // in the field and the one nothing measures yet; while it is unmeasured it
    // counts as zero, which makes moving look cheaper than it is.
    //
    // A run whose speed nothing has measured yet cannot be compared at all, and
    // then it is KEPT. Moving costs a known amount for an unknown gain, and a
    // fresh run has produced nothing, so taking its work away is certainly a
    // loss. This used to answer the other way, and every just-started run was
    // moved the moment anything ahead of it was covered — which, once the whole
    // film ahead had been made, was always.
    const refetchSec = coveredAhead * segmentSeconds * refetchSecPerFilmSecond;
    const driveSec =
      run.speedX > 0 ? (coveredAhead * segmentSeconds) / run.speedX + refetchSec : null;
    const moveSec = restartCostSec + killCostSec + firstByteWaitSec;
    if (driveSec === null || driveSec <= moveSec) {
      surviving.add(run);
      keeps.push({ type: "keep", run, from: run.head, to: run.to });
      continue;
    }

    const free = coverage.freeRunFrom(gap, run);
    surviving.add(run);
    moves.push({
      type: "move",
      run,
      from: gap,
      to: endOfStretch(gap, free),
      because:
        `driving through ${coveredAhead} covered segment(s) costs ${driveSec.toFixed(2)}s ` +
        `(encode ${((coveredAhead * segmentSeconds) / run.speedX).toFixed(2)}s + ` +
        `refetch ${refetchSec.toFixed(2)}s) against ${moveSec.toFixed(2)}s to move ` +
        `(kill ${killCostSec.toFixed(2)}s + start ${restartCostSec.toFixed(2)}s + ` +
        `first bytes ${firstByteWaitSec.toFixed(2)}s)`
    });
  }

  // 3. Gaps somebody is waiting for that nobody is making, IN THE ORDER THE
  //    DEMAND MAP PUTS THEM: most urgent zone first, and within one zone the
  //    lowest number, because that is where a viewer is stopped. The budget
  //    rarely stretches to every gap, so which one is taken first is the whole
  //    of what a viewer's presence decides.
  const gapsWanted = [];
  for (const span of [...wanted].sort(
    (left, right) => (right.priority ?? 0) - (left.priority ?? 0) || left.from - right.from
  )) {
    const gap = coverage.firstGapFrom(span.from, span.to);
    if (gap !== null) {
      gapsWanted.push(gap);
    }
  }
  const alreadyPlanned = new Set(moves.map((action) => /** @type {{from:number}} */ (action).from));
  const budget = Math.max(0, maxRuns - surviving.size);
  for (const gap of [...new Set(gapsWanted)]) {
    if (starts.length >= budget) {
      break;
    }
    if (alreadyPlanned.has(gap)) {
      continue;
    }
    const free = coverage.freeRunFrom(gap);
    if (free === 0) {
      continue;
    }
    alreadyPlanned.add(gap);
    starts.push({
      type: "start",
      from: gap,
      to: endOfStretch(gap, free),
      because: `#${gap} is wanted and nobody is making it`
    });
  }

  return [...stops, ...moves, ...starts, ...keeps];
}

/**
 * The last number of a stretch that begins at `from` and is `length` long.
 *
 * `-1` when the length is not finite, which is this layer's word for a run with
 * no end: the film's length is not known, so there is nothing to stop it at, and
 * a number invented here would be an end nobody measured.
 *
 * @param {number} from
 * @param {number} length
 * @returns {number}
 */
function endOfStretch(from, length) {
  return Number.isFinite(length) ? from + Math.max(1, length) - 1 : -1;
}

/**
 * The lowest number a viewer is waiting for that is not ready — what the plan
 * is judged by.
 *
 * Not used to decide anything: it is the figure a log line carries, so that a
 * plan that keeps producing while a viewer waits is visible rather than
 * inferred.
 *
 * @param {import("./CoverageMap.js").CoverageMap} coverage
 * @param {WantedSpan[]} windows
 * @returns {number | null}
 */
export function firstUnmetWant(coverage, windows) {
  let lowest = null;
  for (const span of windows ?? []) {
    for (let at = span.from; at <= span.to; at += 1) {
      if (!coverage.isReady(at)) {
        if (lowest === null || at < lowest) {
          lowest = at;
        }
        break;
      }
    }
  }
  return lowest;
}
