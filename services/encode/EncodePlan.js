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
 * @param {(others: number) => number} [params.contentionPenaltyFor] - How much
 *   slower ONE encoder runs with that many others beside it, measured on this
 *   host. Without it every extra process looks free, and the score then wants an
 *   encoder per piece: at exactly realtime each next piece is marginally late
 *   however many are running, so another one always seemed to help a little.
 *   Unmeasured is 1, and then the budget is the only thing bounding the count.
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
  refetchSecPerFilmSecond = 0,
  contentionPenaltyFor = () => 1
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
  const untilNeeded = deadlineReaderFor(wanted, segmentSeconds);
  // Segments produced per second, from the fastest measured encoder here.
  const rate = segmentSeconds > 0
    ? live.reduce((best, run) => Math.max(best, run.speedX || 0), 0) / segmentSeconds
    : 0;
  // What a body costs to take away from where it stands and put somewhere else:
  // its death, the start of another, and the wait for the first bytes there.
  const moveSec = restartCostSec + killCostSec + firstByteWaitSec;

  // ------------------------------------------------------------------ WHERE
  //
  // A question about the FILM, and about nothing else: which numbers are
  // missing, when each is needed, how fast this machine encodes, how many
  // processes it can hold. No encoder that happens to be running enters it,
  // which is why it can be answered by arithmetic.
  const positions = placeEncoders({
    coverage,
    windows: wanted,
    howMany: maxRuns,
    // EVERY LIVE ENCODER IS PRE-PLACED, because that is what "somebody already
    // gets here in time" means. A number one of them reaches before it is
    // needed is not a position at all; a number none of them reaches is, and
    // needs a body brought to it. There is no third case, and in particular no
    // separate question of whether an encoder should drive on or be moved:
    // driving is simply its arrival, and its arrival is priced in one place.
    firstGap: gapFinderFor(coverage, new Set(live), rate, segmentSeconds * refetchSecPerFilmSecond),
    deadlineAt: untilNeeded
  });

  // -------------------------------------------------------------------- WHO
  //
  // ARGMIN OF THE OBJECTIVE, EVALUATED. Not a rule that approximates it.
  //
  // Every way of filling the positions is scored by `latenessOf` and the best is
  // taken. There are at most a handful of positions and a handful of bodies, so
  // the enumeration is exact: no local rule stands in for the objective, and
  // none can therefore disagree with another.
  //
  // Four such rules were written before this and all four had to go — "place
  // where a number is late", "take a body that serves nothing", "take one whose
  // work is needed later than this", "drive on or move, by cost". Each looked
  // like a consequence of the model and each approximated it from a different
  // side, so together they contradicted one another and the answer depended on
  // which ran first.
  /** One decision per live encoder, so none can be decided twice. @type {Map<object, PlanAction>} */
  const decided = new Map();
  const room = Math.max(0, maxRuns - live.length);
  const refetchPerSegment = segmentSeconds * refetchSecPerFilmSecond;
  const startSec = restartCostSec + firstByteWaitSec;

  let arrangements = [{ fill: [], used: new Set(), fresh: 0 }];
  for (let index = 0; index < positions.length; index += 1) {
    const next = [];
    for (const arrangement of arrangements) {
      next.push({ fill: [...arrangement.fill, null], used: arrangement.used, fresh: arrangement.fresh });
      // A FRESH PROCESS IS OFFERED BEFORE ANY WORKING BODY, so that when the two
      // score the same the working one is left alone. Taking it is free in the
      // arithmetic — its output stays on disk — but it is not free in fact: the
      // run it belongs to has a position, a warm input and a measured speed, and
      // all three are thrown away for nothing.
      if (arrangement.fresh < room) {
        next.push({
          fill: [...arrangement.fill, "new"],
          used: arrangement.used,
          fresh: arrangement.fresh + 1
        });
      }
      for (const run of live) {
        if (arrangement.used.has(run)) {
          continue;
        }
        next.push({
          fill: [...arrangement.fill, run],
          used: new Set([...arrangement.used, run]),
          fresh: arrangement.fresh
        });
      }
    }
    arrangements = next;
  }

  let best = null;
  let bestScore = null;
  for (const arrangement of arrangements) {
    const bodies = [];
    for (let index = 0; index < positions.length; index += 1) {
      const filler = arrangement.fill[index];
      if (filler === null) {
        continue;
      }
      if (filler === "new") {
        bodies.push({ at: positions[index], delaySec: startSec });
        continue;
      }
      const head = Number(filler.head);
      bodies.push({
        at: positions[index],
        delaySec: head === positions[index] ? 0 : moveSec
      });
    }
    // Bodies nobody was given a position for go on working where they stand,
    // and their coverage counts: the file is encoded whole.
    //
    // A body given no end pays a restart the moment anybody is placed inside the
    // road it would drive: where a run stops is fixed when its process starts,
    // so it has to be cut and begun again at its own head. That price was
    // invisible here, and an arrangement was scored as free when it was not.
    for (const run of live) {
      if (arrangement.used.has(run)) {
        continue;
      }
      const head = Number(run.head);
      const endless = Number(run.to) < Number(run.from);
      const cutInFront = arrangement.fill.some((filler, index) =>
        filler !== null && positions[index] > head
        && (endless || positions[index] <= Number(run.to)));
      bodies.push({ at: head, delaySec: cutInFront ? moveSec : 0 });
    }
    const scored = latenessOf(bodies, coverage, wanted, untilNeeded, rate / contentionPenaltyFor(Math.max(0, bodies.length - 1)), refetchPerSegment, segmentSeconds);
    if (bestScore === null || scored < bestScore) {
      bestScore = scored;
      best = arrangement;
    }
  }

  // A BODY STANDING ON FILM THAT EXISTS is the one arrangement the enumeration
  // above cannot reach: the gap in front of it is nobody's deadline, so it is
  // never a position, and the body is left to make three hundred pieces a second
  // time. Each such body is offered its own first gap and the SAME score decides
  // — moving costs a restart on everything downstream, staying costs the repeat.
  //
  // Offered one at a time rather than folded into the enumeration because the
  // enumeration is exponential in the number of positions, and this is called
  // again on every piece produced. One extra evaluation per body against
  // several thousand arrangements is the difference between arithmetic and a
  // stalled proxy.
  const placement = new Map();
  for (let index = 0; index < positions.length; index += 1) {
    const filler = best ? best.fill[index] : null;
    if (filler && filler !== "new") {
      placement.set(filler, positions[index]);
    }
  }
  const bodiesOf = (override) => {
    const bodies = [];
    for (const run of live) {
      if (override.has(run) && override.get(run) === null) {
        // Asked what the film looks like WITHOUT this one.
        continue;
      }
      const at = override.has(run) ? override.get(run) : (placement.get(run) ?? Number(run.head));
      const head = Number(run.head);
      bodies.push({ at, delaySec: at === head ? 0 : moveSec });
    }
    for (let index = 0; index < positions.length; index += 1) {
      if ((best ? best.fill[index] : null) === "new") {
        bodies.push({ at: positions[index], delaySec: startSec });
      }
    }
    return bodies;
  };
  const scoreOf = (override) => {
    const bodies = bodiesOf(override);
    return latenessOf(bodies, coverage, wanted, untilNeeded,
      rate / contentionPenaltyFor(Math.max(0, bodies.length - 1)), refetchPerSegment, segmentSeconds);
  };
  for (const run of live) {
    if (placement.has(run)) {
      continue;
    }
    const gap = coverage.firstGapFrom(run.head, undefined, run);
    if (gap === null || gap === Number(run.head)) {
      continue;
    }
    const asIs = scoreOf(new Map());
    const moved = scoreOf(new Map([[run, gap]]));
    if (moved < asIs) {
      placement.set(run, gap);
    }
  }

  /**
   * Would the film be worse off without this body? Asked of the same score.
   *
   * @param {object} run
   * @returns {boolean}
   */
  const worseWithout = (run) => {
    if (!(rate > 0) || live.length < 2) {
      // Nothing has measured how fast this machine encodes, so what the film
      // would look like without this encoder cannot be worked out — and an
      // unmeasured quantity is a reason not to act. The only encoder there is
      // is never the answer either: taking it away leaves nobody.
      return true;
    }
    const kept = bodiesOf(new Map());
    const without = bodiesOf(new Map([[run, null]]));
    const scoreOf_ = (bodies) => latenessOf(bodies, coverage, wanted, untilNeeded,
      rate / contentionPenaltyFor(Math.max(0, bodies.length - 1)), refetchPerSegment, segmentSeconds);
    return scoreOf_(without) > scoreOf_(kept);
  };

  const stretchAt = (from) => endOfStretch(from, Math.min(
    coverage.unmadeRunFrom(from),
    coverage.freeRunFrom(from, new Set(live))
  ));

  for (let index = 0; index < positions.length; index += 1) {
    if ((best ? best.fill[index] : null) !== "new") {
      continue;
    }
    const at = positions[index];
    starts.push({
      type: "start",
      from: at,
      to: stretchAt(at),
      because: `#${at} is wanted and nobody reaches it in time`
    });
  }

  for (const run of live) {
    const head = Number(run.head);
    const at = placement.has(run) ? placement.get(run) : head;
    if (at !== head) {
      decided.set(run, {
        type: "move",
        run,
        from: at,
        to: stretchAt(at),
        because: `standing at #${head} scores worse than standing at #${at}, counting ` +
          "both how late the film would be and the work that would be done twice"
      });
      continue;
    }
    // It stays where it is — unless holding it changes nothing.
    //
    // A body left over from where a viewer used to be goes on costing the
    // machine a process while another encoder already reaches everything it
    // would. The score says so directly: take it away and see. Removing it is
    // refused the moment it makes anything later or leaves film abandoned, so
    // this cannot quietly drop the encoder somebody is waiting on.
    if (!placement.has(run) && !worseWithout(run)) {
      stops.push({
        type: "stop",
        run,
        because: "another encoder reaches everything it would, so holding it changes nothing"
      });
      continue;
    }
    // Stopped also when there is nothing left ahead of it to make at all — a run
    // is never stopped merely for standing outside a window.
    if (coverage.firstGapFrom(head, undefined, run) === null) {
      stops.push({
        type: "stop",
        run,
        because: "everything ahead of it is already made or being made"
      });
      continue;
    }
    decided.set(run, { type: "keep", run, from: head, to: run.to });
  }

  for (const action of decided.values()) {
    if (action.type === "keep") {
      keeps.push(action);
    } else {
      moves.push(action);
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
 * THE OBJECTIVE, as a value that can be compared.
 *
 * ONE NUMBER, IN SECONDS, and both terms are seconds:
 *
 * 1. HOW LATE, summed over every number somebody is waiting for:
 *    `max(0, arrival - deadline)` for each.
 *
 *    It was the earliest missed deadline before, and that is degenerate: a
 *    number wanted NOW cannot be made instantly by any arrangement, so every
 *    arrangement missed it and all of them scored the same. The viewer who
 *    seeked was then served by nobody, because serving them scored no better
 *    than ignoring them. How late says what where-it-starts cannot: two seconds
 *    against four hundred is the whole difference between a viewer who waits
 *    and a viewer who leaves;
 *
 * 2. HOW MUCH WORK IS THROWN AWAY: the pieces a body would make a second time,
 *    priced as the seconds it spends encoding them plus the seconds the swarm
 *    spends fetching the same film again.
 *
 * 3. WHAT IS ABANDONED: unmade film below the lowest body, which no arrangement
 *    of them will ever reach, priced as the seconds of encoding it represents.
 *
 *    Without it the objective is blind to giving up the middle of a film: those
 *    numbers carry no deadline — nobody is coming to them YET — so leaving them
 *    unmade cost nothing, and an encoder was taken off two hundred pieces it was
 *    producing to gain a fraction of a second somewhere ahead. The whole file is
 *    wanted; only WHEN differs.
 *
 * They are ADDED, not ranked. Ranked, any lateness at all outweighed any amount
 * of repeated work, so an encoder walking into three hundred already-made pieces
 * was left there rather than moved past them — and the work it repeats is paid
 * for by the same machine and the same swarm that everybody else is waiting on,
 * so it becomes somebody's lateness a moment later. One currency is the only
 * honest way to compare them.
 *
 * Every decision in this file is made by comparing this. It replaced four local
 * rules that each approximated it from a different side and therefore
 * contradicted one another.
 *
 * @param {{ at: number, delaySec: number }[]} bodies - Where each encoder would
 *   stand, and how long before it produces anything there: nothing where it is
 *   already standing, a move or a start otherwise.
 * @param {import("./CoverageMap.js").CoverageMap} coverage
 * @param {WantedSpan[]} wanted
 * @param {(index: number) => number} untilNeeded
 * @param {number} rate - Segments per second, measured.
 * @param {number} refetchSecPerSegment
 * @param {number} segmentSeconds
 * @returns {number} Seconds. Smaller is better; zero is nobody late and nothing
 *   repeated.
 */
function latenessOf(bodies, coverage, wanted, untilNeeded, rate, refetchSecPerSegment, segmentSeconds) {
  const first = Math.min(...wanted.map((span) => span.from));
  const last = Math.max(...wanted.map((span) => span.to));
  // What a number nobody reaches at all counts as. The film's own length is the
  // honest bound — nothing can be later than never — and a finite figure is what
  // lets two hopeless arrangements still be told apart by the rest of the sum.
  const never = (last + 1) * segmentSeconds;
  let tardiness = 0;
  for (let index = first; index <= last; index += 1) {
    if (coverage.isReady(index)) {
      continue;
    }
    const deadline = untilNeeded(index);
    if (!Number.isFinite(deadline)) {
      // Nobody is coming here, so nothing about it can be late.
      continue;
    }
    let soonest = Number.POSITIVE_INFINITY;
    for (const body of bodies) {
      if (body.at > index) {
        continue;
      }
      if (!(rate > 0)) {
        // Nothing has measured how fast this machine encodes, so no arrival can
        // be computed and nothing is claimed late.
        soonest = 0;
        break;
      }
      const arrival = body.delaySec
        + (index - body.at + 1) / rate
        + coverage.madeBetween(body.at, index) * refetchSecPerSegment;
      if (arrival < soonest) {
        soonest = arrival;
      }
    }
    tardiness += Number.isFinite(soonest)
      ? Math.max(0, soonest - deadline)
      : never;
  }
  // A body works until its neighbour's start, so what it would make a second
  // time is bounded there and not by the end of the film. Counted to the end,
  // two bodies were charged for the same repeated pieces and arrangements that
  // differ only in where the repeat happens scored the same.
  const starts_ = bodies.map((body) => body.at).sort((left, right) => left - right);
  // Below every body: nothing will make it. The whole file is wanted, so this
  // is a real loss and not a free one.
  let abandoned = 0;
  const lowest = starts_.length > 0 ? starts_[0] : last + 1;
  for (let index = 0; index < lowest; index += 1) {
    if (!coverage.isReady(index)) {
      abandoned += 1;
    }
  }
  let wasted = rate > 0 ? abandoned / rate : 0;
  for (const body of bodies) {
    const after = starts_.find((at) => at > body.at);
    const until = after === undefined ? last : after - 1;
    const again = coverage.madeBetween(body.at, until);
    wasted += rate > 0 ? again / rate + again * refetchSecPerSegment : 0;
  }
  return tardiness + wasted;
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
 * @returns {(at: number, bound: number, deadlineAt: (index: number) => number, alsoPlaced?: number[]) => number | null}
 */
function gapFinderFor(coverage, surviving, rate, refetchSecPerSegment = 0) {
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
        // WHEN THIS BODY GETS HERE, and both terms of it.
        //
        // Its own encoding of everything between, and the swarm's price for the
        // film it would fetch a SECOND time — every number between that is
        // already made, it makes again. That second term is why "should this
        // encoder drive on or be moved" is not a question of its own: an
        // encoder with three hundred made pieces in front of it is simply slow
        // to arrive, and the model compares arrivals. Asked separately it was a
        // second authority over the same encoder, and the two disagreed.
        const arrival = (index - a + 1) / rate
          + coverage.madeBetween(a, index) * refetchSecPerSegment;
        if (arrival < soonest) {
          soonest = arrival;
        }
      }
      if (soonest <= deadline) {
        // Somebody gets here in time. Nothing to decide.
        continue;
      }
      // IT IS LATE, AND THAT IS ALL THIS DECIDES. Whether filling it is worth
      // the price is not asked here: this only proposes candidates, and the
      // score decides how many of them are taken and by whom. Asked here as
      // well, it was a second cost model beside the objective — with its own
      // idea of what a process costs — and the two disagreed at exactly
      // realtime, where every next piece is marginally late and each looked
      // worth its own encoder.
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

