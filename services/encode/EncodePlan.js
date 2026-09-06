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
    // Both sides have to be known for the comparison to mean anything. The
    // encoder's own speed is one; what the swarm charges to fetch the same
    // bytes again is the other, and where nothing has measured it the sum is
    // not a cost but a fragment of one. Answering from a fragment biases the
    // decision one way — towards moving, since the missing term is on the
    // driving side — so an unknown term is a reason to keep, exactly as an
    // unmeasured speed is.
    const known = run.speedX > 0 && refetchSecPerFilmSecond > 0;
    const refetchSec = coveredAhead * segmentSeconds * refetchSecPerFilmSecond;
    const driveSec = known ? (coveredAhead * segmentSeconds) / run.speedX + refetchSec : null;
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
  const budget = Math.max(0, maxRuns - surviving.size);
  const alreadyPlanned = new Set(moves.map((action) => /** @type {{from:number}} */ (action).from));
  for (const from of placeEncoders({
    coverage,
    windows: wanted,
    howMany: budget,
    // Segments produced per second, from the fastest measured run: seconds of
    // film per second, divided by the seconds of film one segment holds.
    firstGap: gapFinderFor(
      coverage,
      surviving,
      segmentSeconds > 0
        ? live.reduce((best, run) => Math.max(best, run.speedX || 0), 0) / segmentSeconds
        : 0,
      restartCostSec + firstByteWaitSec,
      // What re-cutting a working encoder costs: killing it, starting it again,
      // and waiting for its first bytes. The same three terms the drive-or-move
      // comparison uses, so one price is quoted in both places.
      killCostSec + restartCostSec + firstByteWaitSec
    ),
    deadlineAt: deadlineReaderFor(wanted, segmentSeconds)
  })) {
    if (alreadyPlanned.has(from)) {
      continue;
    }
    alreadyPlanned.add(from);
    starts.push({
      type: "start",
      from,
      // As far as there is material to make, and as far as nobody ELSE holds.
      //
      // The runs of this pass are excluded because their roads are re-cut below,
      // over all the placements at once: asking about a claim that is about to
      // move answers about a state already gone, and an encoder placed in front
      // of a run claiming the whole film got a stretch of length zero and was
      // never started — the viewer who had just seeked was served by nobody. A
      // claim held by anything else is real and stands.
      to: endOfStretch(from, Math.min(
        coverage.unmadeRunFrom(from),
        coverage.freeRunFrom(from, new Set(live))
      )),
      because: `#${from} is wanted and nobody is making it`
    });
  }

  // WHEN THE BUDGET IS FULL, THE ENCODERS THERE ARE STAND WHERE SOMETHING IS
  // DUE — not wherever they happen to have ended up.
  //
  // The machine affords what it affords, and the placement above can only use
  // what is left over. So a viewer who seeks far ahead, or a third viewer on a
  // host that holds two encoders, would be served by nobody at all: the run that
  // exists is hundreds of numbers behind them, keeps its road because nothing
  // covers what lies in front of IT, and the budget leaves nothing to place.
  // Measured while building this — a viewer seeking from 6:40 to 50:00 got no
  // encoder, because one at 6:41 was already taking the whole of a swarm that
  // affords one.
  //
  // The remedy is the objective, applied: no late numbers, and where that cannot
  // be had, lateness as far to the right as possible. A run whose own position
  // has nothing due at it is doing nothing for anybody's deadline; moving it to
  // the soonest number that IS due strictly reduces lateness. A run standing
  // where something is due is left alone — taking it away would only move the
  // lateness from one person to another.
  const untilNeeded = deadlineReaderFor(wanted, segmentSeconds);
  if (budget === 0 && starts.length === 0) {
    const late = untilNeeded === null ? null : firstLateFrom({
      coverage,
      wanted,
      surviving,
      rate: segmentSeconds > 0
        ? live.reduce((best, run) => Math.max(best, run.speedX || 0), 0) / segmentSeconds
        : 0,
      untilNeeded
    });
    if (late !== null) {
      // The idlest of them: the one with the least reason to be where it is.
      let idlest = null;
      let worst = -1;
      for (const action of keeps) {
        const run = /** @type {{ run: { head: number } }} */ (action).run;
        const due = untilNeeded(run.head);
        if (due > worst) {
          worst = due;
          idlest = action;
        }
      }
      if (idlest !== null && !Number.isFinite(worst)) {
        // Only when NOTHING is due where it stands. A run with a real deadline
        // under it is serving somebody, and moving it would trade one viewer's
        // wait for another's.
        keeps.splice(keeps.indexOf(idlest), 1);
        moves.push({
          type: "move",
          run: /** @type {{ run: object }} */ (idlest).run,
          from: late,
          to: endOfStretch(late, coverage.unmadeRunFrom(late)),
          because:
            `nothing is due where it stands and #${late} is late, and the machine ` +
            "affords no more encoders than it already has"
        });
      }
    }
  }

  // ONE ENCODER'S WORK ENDS WHERE THE NEXT ONE'S BEGINS.
  //
  // A free stretch may run to the end of the track, and an encoder given all of
  // it stands in the road of every encoder placed behind it: they write the
  // same names, and each one's output is the other's "material somebody else
  // made", so they stop one another. Field 2026-09-05: three encoders started
  // on one track within 200 ms, each into the road another was already writing.
  // Fifteen readers on a piece store that holds sixteen pieces followed, half
  // of all evictions took a piece a reader had declared, and `/stream` began
  // handing out bytes that were not the file's.
  //
  // The bound is taken from the NEXT ENCODER'S START, not from a band edge: a
  // band edge travels with the viewer, so every step forward would leave a
  // sliver just past the previous encoder and buy an encoder for it.
  // A RUN THAT IS STAYING IS IN THE SORT TOO, because its road can be taken.
  //
  // It used to be left out, on the reading that a run staying put keeps what it
  // was given. That is true of the stretch it was GIVEN and false of the road it
  // will actually drive: a run with no end carries no `-to` and walks to the end
  // of the film, so an encoder placed in front of it writes the same names.
  const placed = [...moves, ...starts, ...keeps].sort(
    (left, right) => /** @type {any} */ (left).from - /** @type {any} */ (right).from
  );
  for (let index = 0; index < placed.length - 1; index += 1) {
    const here = /** @type {{ type: string, run?: object, from: number, to: number }} */ (placed[index]);
    const next = /** @type {{ from: number }} */ (placed[index + 1]);
    if (here.to >= 0 && here.to < next.from) {
      continue;
    }
    here.to = next.from - 1;
    if (here.type !== "keep") {
      continue;
    }
    // SHORTENING A LIVE RUN'S ROAD MEANS STOPPING IT, not merely writing a
    // smaller number down. Where a run's end goes is fixed when its process
    // starts, so one that was given none keeps producing past any bound decided
    // later and would write one piece into the new encoder's road — two
    // processes on one name, which is the collision this whole pass exists to
    // prevent. So it ends here and begins again at its own head with a real end;
    // the viewer in front pays a restart, which is a cost this file already
    // prices rather than a interruption nobody counted.
    keeps.splice(keeps.indexOf(here), 1);
    moves.push({
      type: "move",
      run: here.run,
      from: here.from,
      to: here.to,
      because:
        `an encoder is needed at #${next.from}, which this run would reach only by ` +
        "encoding through; it takes the road up to there and ends by itself"
    });
  }

  return [...stops, ...moves, ...starts, ...keeps];
}

/**
 * The soonest number that is due and that nobody standing behind it can reach in
 * time.
 *
 * The same arithmetic as the placement, asked once over the whole line rather
 * than as a search for somewhere to put a new process: it is what decides
 * whether the encoders that exist are enough, when there is no room for another.
 *
 * @param {object} params
 * @param {import("./CoverageMap.js").CoverageMap} params.coverage
 * @param {WantedSpan[]} params.wanted
 * @param {Set<object>} params.surviving
 * @param {number} params.rate - Segments per second, measured. Zero means
 *   nothing has measured it and no arrival time can be computed.
 * @param {(index: number) => number} params.untilNeeded
 * @returns {number | null}
 */
function firstLateFrom({ coverage, wanted, surviving, rate, untilNeeded }) {
  if (!(rate > 0)) {
    return null;
  }
  const heads = [...surviving].map((run) => {
    const head = Number(/** @type {{ head?: number }} */ (run).head);
    return Number.isFinite(head) ? head : Number(/** @type {{ from: number }} */ (run).from);
  });
  const first = Math.min(...wanted.map((span) => span.from));
  const last = Math.max(...wanted.map((span) => span.to));
  for (let index = first; index <= last; index += 1) {
    if (coverage.isReady(index)) {
      continue;
    }
    const deadline = untilNeeded(index);
    if (!Number.isFinite(deadline)) {
      continue;
    }
    const reached = heads.some((head) => head <= index && (index - head + 1) / rate <= deadline);
    if (!reached) {
      return index;
    }
  }
  return null;
}

/**
 * How long until a number is needed, read off the map.
 *
 * The map states it per stretch, for the stretch's NEAR EDGE, because a stretch
 * is met at its beginning. Every number inside is needed no sooner than that, so
 * taking the stretch's figure for all of them is the safe reading: it can only
 * make the filling earlier than it has to be, never later.
 *
 * Where the map says nothing, nobody is coming and nothing can be late.
 *
 * Inside a stretch the time GROWS with the distance, because a viewer covers a
 * second of film in a second: the number `n` places past the near edge is
 * reached `n` segments of film later. Taking the near edge's figure for every
 * number inside instead makes a whole stretch due at once — measured while
 * building this: the first stretch is as wide as the measured allowance, so its
 * far end was demanded instantly and an encoder was placed on a number another
 * one was already writing.
 *
 * @param {WantedSpan[]} windows
 * @param {number} segmentSeconds - How much film one number holds.
 * @returns {(index: number) => number}
 */
function deadlineReaderFor(windows, segmentSeconds) {
  const perSegment = segmentSeconds > 0 ? segmentSeconds : 0;
  return (index) => {
    let soonest = Number.POSITIVE_INFINITY;
    for (const span of windows) {
      if (index < span.from || index > span.to) {
        continue;
      }
      const stated = /** @type {{ withinSeconds?: number }} */ (span).withinSeconds;
      // A stretch stated with no time is somebody waiting at its near edge: that
      // is what stating one means. The rest of it grows with the distance, the
      // same as a stated one — read as due all at once instead, a window as wide
      // as a viewer's cushion demanded its far end instantly and bought an
      // encoder to stand beside one already working.
      const within = stated === undefined ? 0 : Number(stated);
      if (!Number.isFinite(within)) {
        // Stated as no time at all: nobody is coming here.
        continue;
      }
      const here = within + (index - span.from) * perSegment;
      if (here < soonest) {
        soonest = here;
      }
    }
    return soonest;
  };
}

/**
 * WHERE ENCODERS BELONG, from the model rather than from a list of cases.
 *
 * The problem this solves, stated exactly:
 *
 * - the track is a line of segment numbers; `M` are the ones not made;
 * - each `x` carries a DEADLINE `D(x)`, the seconds until somebody needs it.
 *   That is what the priority map is a reading of — a viewer moving forward
 *   covers a second of film in a second, so the time until they are at `x` is
 *   the distance to it. `Infinity` where nobody is coming;
 * - an encoder is a SEQUENTIAL producer: placed at `a`, it delivers `a + j` at
 *   time `(j + 1) / r`, where `r` is segments per second, measured. It cannot
 *   skip, so its whole schedule follows from where it starts;
 * - the machine affords `k` of them, measured.
 *
 * Two consequences fall out and need no rule of their own. Placements
 * `a_1 < ... < a_k` PARTITION the line: encoder `i` is useful only on
 * `[a_i, a_{i+1})`, because past that its neighbour got there first. And a
 * segment served by encoder `i` arrives at `(x - a_i + 1) / r`, which is
 * therefore also the answer to "when would the encoder already placed before it
 * get here" — the second half of the comparison, and the half that was missing.
 *
 * `x` is LATE when it arrives after `D(x)`. The objective is no late segments;
 * where `k` does not stretch to that, lateness beginning as far to the right as
 * possible.
 *
 * THE ALGORITHM is first-fit, left to right:
 *
 *     for each missing x with a finite deadline, ascending:
 *         if some encoder already placed at a satisfies (x - a + 1)/r <= D(x):
 *             it covers x
 *         else:
 *             place an encoder at x
 *
 * A LIVE run enters as an encoder already placed at its own head. There is no
 * special case for it.
 *
 * WHY IT IS OPTIMAL. The leftmost missing number with a finite deadline must be
 * covered by somebody. An encoder placed exactly on it delivers it at the
 * earliest time any placement can, `1/r`, and covers the longest suffix any
 * placement can — starting further left only re-makes material and arrives
 * later, starting further right does not cover it at all. So the greedy choice
 * is never worse than any other, and the usual exchange argument carries it to
 * the whole line. This is the known result for FIXED-ORDER scheduling with
 * deadlines, where first-fit is optimal at unit processing times, and a segment
 * is one unit. General machine minimisation with release times and deadlines is
 * NP-hard; this case is polynomial because the order is forced and each machine
 * covers a contiguous stretch.
 *
 * WHAT WAS TRIED FIRST AND WAS WRONG, kept because each looked reasonable:
 *
 * - `(h - p) * s / (1 - s)`, how long a run stays in front of a viewer moving
 *   forward. It answers a different question: a viewer stopped with an empty
 *   buffer needs the segment now, and at exactly realtime that formula says
 *   "for ever" while the viewer waits thirteen minutes;
 * - whether a run's head lies inside a wanted band — which ties an encoder to
 *   whoever is standing there, and this layer must never know that;
 * - the run's head as a barrier, everything above it placeable. It has no time
 *   in it at all, so it cannot tell two segments ahead from two hundred.
 *
 * Each was a case, not a model. The deadline is the model.
 *
 * @param {import("./CoverageMap.js").CoverageMap} coverage
 * @param {Set<object>} surviving - Runs that will still be alive, as encoders
 *   already placed at their own heads.
 * @param {number} rate - Segments produced per second by one encoder, measured.
 *   Zero when nothing has measured it, and then no arrival time can be computed
 *   and every claimed number is left alone.
 * @param {number} startCostSec - What a NEW encoder costs before it delivers
 *   anything: starting the process and opening its input. Measured, both of
 *   them. Without it a number one second late buys a whole process that takes
 *   longer than that to produce its first piece — measured while building this,
 *   two viewers two numbers apart, one encoder each.
 * @param {number} recutCostSec - What it costs to take the road from a run that
 *   is working through this number: it stops and starts again at its own head,
 *   because where a run ends is fixed when its process starts. Measured. The
 *   original scheduling problem has no such term — its machines are free to
 *   start and stop — and leaving it out let the model call a trade a gain while
 *   somebody watching paid for it with a restart.
 * @returns {(at: number, bound: number, deadlineAt: (index: number) => number, alsoPlaced?: number[]) => number | null}
 */
function gapFinderFor(coverage, surviving, rate, startCostSec = 0, recutCostSec = 0) {
  /** Encoders already placed: where each stands, and how far its road runs. */
  const placed = [];
  for (const run of surviving) {
    const head = Number(/** @type {{ head?: number }} */ (run).head);
    placed.push({
      at: Number.isFinite(head) ? head : Number(/** @type {{ from: number }} */ (run).from),
      // A live run's road, so that placing inside it can be priced. A run given
      // no end drives to the end of the film, which is what makes the price real.
      // A run given no end drives to the end of the film, which is what makes
      // the price of cutting in front of it real. Written out rather than
      // imported: this file depends on nothing, and that is what lets it be
      // exercised with plain values alone.
      to: Number(/** @type {{ to: number }} */ (run).to) < Number(/** @type {{ from: number }} */ (run).from)
        ? Number.POSITIVE_INFINITY
        : Number(/** @type {{ to: number }} */ (run).to)
    });
  }
  return (at, bound, deadlineAt, alsoPlaced) => {
    const start = Number.isInteger(at) && at > 0 ? at : 0;
    const last = Number.isInteger(bound) ? bound : -1;
    // THE LATE NUMBER THAT IS DUE SOONEST, not the leftmost one.
    //
    // With room for every placement the two are the same answer. With a budget
    // that binds they are not, and the objective decides: lateness pushed as far
    // to the right as possible means the soonest deadline is served first. A
    // walk by number gave the one machine to a viewer due in ten minutes while
    // another stood waiting with an empty buffer.
    //
    // Ties go to the smaller number, so the answer does not depend on the order
    // the map happens to be in.
    let best = null;
    let bestDue = Number.POSITIVE_INFINITY;
    for (let index = start; index <= last; index += 1) {
      if (coverage.isReady(index)) {
        continue;
      }
      const deadline = deadlineAt(index);
      if (!Number.isFinite(deadline)) {
        // NOBODY IS COMING HERE, so nothing about it can be late — and this is
        // asked before anybody is consulted, because it is true whether or not
        // an encoder happens to stand behind it. Asked inside the loop below it
        // silently became "true only if somebody is already placed", and on a
        // fresh output, where nobody is, the first encoder went to the stretch
        // BEHIND the viewer instead of to the viewer.
        continue;
      }
      // When would the SOONEST of those already placed get here? Encoders placed
      // EARLIER IN THIS PASS count: the first one placed for a viewer covers the
      // stretch in front of them, and without counting it the walk placed a
      // second and a third on the very next numbers — three processes a segment
      // apart for one person, which is the waste this model exists to refuse.
      let soonest = Number.POSITIVE_INFINITY;
      // Would placing here cut the road out from under somebody who is working?
      // A live run whose road covers this number has to stop and start again at
      // its own head, because where a run ends is fixed when its process starts.
      let recut = 0;
      for (const live of placed) {
        if (live.at < index && live.to >= index) {
          recut = recutCostSec;
          break;
        }
      }
      for (const a of [...placed.map((live) => live.at), ...(alsoPlaced ?? [])]) {
        if (a > index) {
          // Standing past it. Encoders only move forward, so it never will.
          continue;
        }
        if (a === index) {
          // Standing ON it. No placement is faster than the one already made.
          soonest = 0;
          break;
        }
        if (!(rate > 0)) {
          // Nothing has measured how fast this machine encodes, so no arrival
          // time exists to compare. An unmeasured quantity is a reason not to
          // act: the one standing behind it is credited with getting there.
          soonest = 0;
          break;
        }
        const arrival = (index - a + 1) / rate;
        if (arrival < soonest) {
          soonest = arrival;
        }
      }
      if (soonest <= deadline) {
        // Somebody gets here in time. Nothing to decide.
        continue;
      }
      // It IS late. But placing an encoder only helps if a new one would deliver
      // it SOONER than the best of those already working, and the price of that
      // is not only the new process:
      //
      //   its own start — the process and the opening of its input, measured;
      //   the RE-CUT it forces on whoever is working through this number, who
      //   must stop and begin again at their own head, also measured.
      //
      // The second was missing, so the model could count a trade a gain while it
      // was a loss: four seconds saved for somebody far ahead, paid for with a
      // restart in front of somebody who was watching. Both are paid in the same
      // coin — seconds before a piece exists — so they simply add.
      if (rate > 0 && startCostSec + recut + 1 / rate >= soonest) {
        continue;
      }
      if (deadline < bestDue) {
        best = index;
        bestDue = deadline;
      }
    }
    return best;
  };
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

/**
 * Where to put the encoders this machine can afford.
 *
 * Two things are wanted of a division of the film, and they are wanted in this
 * order:
 *
 * 1. **the viewer must not stop.** An encoder starting at `q` stays ahead of a
 *    viewer at `p` while `y / s <= q + y - p`, so it holds `(q - p) * s / (1-s)`
 *    of film and no more. Beyond that the viewer catches it, and the next
 *    encoder has to be standing there. That is where the first ones go, and it
 *    is why the stretches grow: the further off one starts, the later the
 *    viewer arrives and the longer it may work;
 * 2. **the film should be finished as soon as possible.** Once the viewer is
 *    safe, whatever is left is divided EQUALLY between the encoders that
 *    remain: equal shares finish together, and any other division finishes when
 *    its longest share does. That is what makes seeking cheap — the film exists.
 *
 * At or above realtime the first requirement is met by one encoder for the
 * whole film, and every other encoder goes to the second — which is the common
 * case on a copied picture, and is why "one viewer, one encoder" was never the
 * rule.
 *
 * @param {object} params
 * @param {import("./CoverageMap.js").CoverageMap} params.coverage
 * @param {WantedSpan[]} params.windows - The merged map, in this output's own
 *   numbering. Its highest-numbered band starts where the viewer is.
 * @param {number} params.howMany - What the machine affords.
 * @param {number} params.speedX - Measured. Zero when nothing has measured it,
 *   and then only the first requirement can be served.
 * @param {(at: number, bound: number, deadlineAt: (index: number) => number, placed: number[]) => number | null} [params.firstGap] -
 *   Where a gap may be opened. Defaults to the map's own answer; the plan hands
 *   in one that also counts a number a live run has claimed but will not reach
 *   before it is needed, which is the only way anybody beyond a working encoder
 *   is served.
 * @param {(index: number) => number} [params.deadlineAt] - Seconds until that
 *   number is needed. `Infinity` where nobody is coming. Absent means every
 *   stated want is due now.
 * @returns {number[]} Where to start each encoder, ascending.
 */
export function placeEncoders({ coverage, windows, howMany, firstGap = null, deadlineAt = null }) {
  if (!(howMany > 0) || windows.length === 0) {
    return [];
  }
  // NOW when the caller says nothing. A stated want with no time is somebody
  // waiting on it — that is what stating one means — so the honest reading is
  // that it is due. `Infinity` is a statement in its own right and has to be
  // made: it says nobody is coming.
  const untilNeeded = deadlineAt ?? (() => 0);
  /** Where this pass has placed so far — each one covers what it can reach. */
  const placedHere = [];
  const gapAt = firstGap
    ? (at, bound) => firstGap(at, bound, untilNeeded, placedHere)
    : (at, bound) => coverage.firstGapFrom(at, bound);

  const firstWanted = Math.min(...windows.map((span) => span.from));
  const lastWanted = Math.max(...windows.map((span) => span.to));

  // FIRST-FIT, LEFT TO RIGHT, and that is the whole algorithm.
  //
  // `gapAt` returns the leftmost number that nobody already placed can reach
  // before it is needed. Placing an encoder exactly there delivers it at the
  // earliest time any placement can and covers the longest suffix any placement
  // can, so the choice is never worse than another; the usual exchange argument
  // carries that to the whole line.
  //
  // Each round asks over the WHOLE line again, because the one just placed is in
  // `placedHere` and changes what is late: that is how one encoder comes to
  // serve a whole stretch instead of one being bought per band of the map. And
  // asking again is what lets the second placement go somewhere the first made
  // urgent, rather than to the next number along.
  /** @type {number[]} */
  const places = [];
  while (places.length < howMany) {
    const gap = gapAt(firstWanted, lastWanted);
    if (gap === null || places.includes(gap)) {
      break;
    }
    places.push(gap);
    placedHere.push(gap);
  }

  // NOTHING IS PLACED WHERE NOTHING CAN BE LATE, and that is deliberate.
  //
  // A stretch nobody is coming to — behind a viewer, past the last of them, or
  // the whole film while everybody is paused — has no time by which it must
  // exist, so an encoder there prevents nothing while costing a process the
  // people who ARE watching need. A paused viewer makes nobody work; one who
  // resumes states finite times again and is served then.
  //
  // The file still gets encoded whole: a run already alive is never stopped for
  // leaving a window and goes on to the end of the track. That is the retention
  // rule above, and it is what fills the parts no deadline covers.
  return places.sort((left, right) => left - right);
}

