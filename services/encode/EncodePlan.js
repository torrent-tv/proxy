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
 * **What a viewer wants decides WHERE a run starts and WHETHER it is needed,
 * never where it stops.** A run's end comes from the coverage: it runs until it
 * meets material somebody else has made or is making, or until the end of the
 * film. Bounding it by the window instead was tried and is wrong, because a
 * window travels forward as the viewer plays: a second viewer whose cushion
 * reached two segments past the first run's end was given an encoder of their
 * own to make those two, while the run already there had nowhere left to go.
 * How far ahead of the viewers a run may get is a different question with its
 * own answer — the look-ahead, which suspends a run rather than bounding it.
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
 *   | { type: "move", runId: string, from: number, to: number, because: string }
 *   | { type: "stop", runId: string, because: string }
 *   | { type: "keep", runId: string, from: number, to: number }} PlanAction
 */

/**
 * Whether a stretch and a window touch at all.
 *
 * @param {number} fromA
 * @param {number} toA
 * @param {number} fromB
 * @param {number} toB
 * @returns {boolean}
 */
function overlaps(fromA, toA, fromB, toB) {
  return fromA <= toB && fromB <= toA;
}

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
  restartCostSec
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
      stops.push({ type: "stop", runId: run.id, because: "nobody is watching this output" });
    }
    return stops;
  }

  // How far a search for a gap needs to look: past the furthest thing anybody
  // is waiting for there is nothing to decide about.
  const demandTo = Math.max(...wanted.map((span) => span.to));

  /** Runs that survive this pass, by id. @type {Set<string>} */
  const surviving = new Set();

  for (const run of live) {
    // 1. Is anybody waiting for what this run was given? A run whose stretch
    //    touches no window is making material nobody has asked for.
    const stillWanted = wanted.some((span) => overlaps(run.from, run.to, span.from, span.to));
    if (!stillWanted) {
      stops.push({ type: "stop", runId: run.id, because: "nothing it was given is wanted" });
      continue;
    }

    // 2. Has it arrived at material that already exists, or that another run is
    //    making? Its own claim does not count against it.
    const coveredAhead = coverage.coveredRunFrom(run.head, run.id);
    if (coveredAhead === 0) {
      surviving.add(run.id);
      keeps.push({ type: "keep", runId: run.id, from: run.head, to: run.to });
      continue;
    }

    // Where it would go instead: the first thing nobody has and nobody is
    // making, at or after where it stands.
    const gap = coverage.firstGapFrom(run.head, demandTo, run.id);
    if (gap === null) {
      stops.push({
        type: "stop",
        runId: run.id,
        because: "everything wanted ahead of it is already made or being made"
      });
      continue;
    }

    // Driving through costs its own encode time for material that exists.
    // Moving costs one restart. Both are measured; neither is chosen here.
    //
    // A run whose speed nothing has measured yet cannot be compared, and then
    // moving is the answer rather than a default: driving through is work that
    // is certainly wasted, while the restart is a known and small cost.
    const driveSec = run.speedX > 0 ? (coveredAhead * segmentSeconds) / run.speedX : null;
    if (driveSec !== null && driveSec <= restartCostSec) {
      surviving.add(run.id);
      keeps.push({ type: "keep", runId: run.id, from: run.head, to: run.to });
      continue;
    }

    const free = coverage.freeRunFrom(gap, run.id);
    surviving.add(run.id);
    moves.push({
      type: "move",
      runId: run.id,
      from: gap,
      to: gap + Math.max(1, free) - 1,
      because: driveSec === null
        ? `${coveredAhead} segment(s) ahead are already covered and its speed is not measured`
        : `driving through ${coveredAhead} covered segment(s) costs ${driveSec.toFixed(2)}s ` +
          `against ${restartCostSec.toFixed(2)}s to move`
    });
  }

  // 3. Gaps somebody is waiting for that nobody is making. Taken in the order
  //    the viewers meet them — the lowest first — because that is the one a
  //    viewer is stopped at, and the budget may not stretch to all of them.
  const gapsWanted = [];
  for (const span of wanted) {
    const gap = coverage.firstGapFrom(span.from, span.to);
    if (gap !== null) {
      gapsWanted.push(gap);
    }
  }
  const alreadyPlanned = new Set(moves.map((action) => /** @type {{from:number}} */ (action).from));
  const budget = Math.max(0, maxRuns - surviving.size);
  for (const gap of [...new Set(gapsWanted)].sort((left, right) => left - right)) {
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
      to: gap + free - 1,
      because: `#${gap} is wanted and nobody is making it`
    });
  }

  return [...stops, ...moves, ...starts, ...keeps];
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
