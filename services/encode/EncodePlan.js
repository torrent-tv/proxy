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
 * @param {number} [params.killCostSec] - How long stopping an encoder takes,
 *   measured on this host from its own runs. Zero until something has measured
 *   it, which makes moving one look cheaper than it is and is said here so the
 *   bias is known.
 * @param {number} [params.now] - The clock, injected. This layer is arithmetic
 *   and reads no clock of its own; how old a run is is one of its inputs.
 * @param {number} [params.firstByteWaitSec] - How long a fresh encoder takes to
 *   produce anything: process start, opening the input, and the first piece.
 *   Measured the same way. It replaced a constant of 0.12 s taken from one
 *   host and charged to every other.
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
  killCostSec = 0,
  firstByteWaitSec = 0,
  now = Date.now(),
  refetchSecPerFilmSecond = 0,
  contentionPenaltyFor = () => 1,
  speedX = 0
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

  const untilNeeded = deadlineReaderFor(wanted, segmentSeconds);
  // Segments produced per second, from the fastest measured encoder here.
  // Seconds of film per second, divided by the film one piece holds.
  //
  // A RUN WORKING ON THIS OUTPUT OUTRANKS THE BENCHMARK. The startup figure is
  // what this host does on reference clips; a run here is what it does on THIS
  // material, and that is the more specific statement. Taken as a floor instead
  // — the larger of the two — an encoder reporting half realtime was scored as
  // though it ran at twice, and nothing was ever late.
  const working = live.reduce((best, run) => Math.max(best, run.speedX || 0), 0);
  const rate = segmentSeconds > 0 ? (working > 0 ? working : speedX) / segmentSeconds : 0;
  // How long one piece takes AT THE RATE ACTUALLY IN FORCE. Concurrent encoders
  // slow each other — measured on this host — so an arrangement's own encoder count
  // decides it, and the delays below are computed per arrangement for that
  // reason. Taken from the unpenalised rate instead, a piece looked cheaper the
  // more encoders there were, which made extra encoders look free: the plan bought a
  // second encoder where one served, and the arrivals it was compared on were
  // computed at the slower rate all along.
  //
  // `Infinity` where nothing has been measured, which is what "no speed" means
  // and what makes every arrangement equally hopeless rather than equally free.
  const pieceAt = (howManyEncoders) => {
    const inForce = rate / contentionPenaltyFor(Math.max(0, howManyEncoders - 1));
    return inForce > 0 ? 1 / inForce : Number.POSITIVE_INFINITY;
  };
  // What a encoder costs to take away from where it stands and put somewhere else:
  // its death, the start of another, and the wait for the first bytes there.
  // Taking an encoder somewhere else is stopping this one and waiting for the
  // next to produce. Both halves are measured on this host.
  // WHAT A START AND A MOVE OWE BEFORE THE PIECE THEY STAND ON EXISTS, and
  // neither is infinite.
  //
  // The measured `firstByteWaitSec` is spawn to first piece, so it already
  // contains one piece's encoding. Separated, because the two scale differently:
  // the piece costs more when encoders share the machine, the spawn does not.
  //
  //   spawn overhead = measured first output - what one piece costs alone
  //   a fresh encoder owes    spawn overhead + the piece at the rate in force
  //   a moved one owes        the kill, and then the same
  //
  // With nothing measured the overhead is zero and a fresh encoder owes exactly
  // one piece — which is the honest floor rather than a guess: a piece cannot
  // appear before it is encoded, and how fast this host encodes is measured
  // before any viewer exists. There was an `Infinity` here for the cost of a
  // move, on the reasoning that an unmeasured price must not license an
  // irreversible act; it was an exception in a model that needs none, and this
  // is the same statement made by arithmetic.
  const spawnOverheadSec = Math.max(0, firstByteWaitSec - (rate > 0 ? 1 / rate : 0));
  const moveSec = killCostSec + spawnOverheadSec;

  // WHAT A RUN STILL HAS TO GO BEFORE IT PRODUCES ANYTHING — the measured time
  // to a first piece, less the time it has already been alive.
  //
  // This is the memory the score was missing. It is computed afresh whenever
  // anything changes, and every arrangement used to be priced as though it were
  // the last decision anybody would take: a run that started 10 ms ago was
  // assumed to produce instantly, so killing it and starting another looked like
  // a straight gain. A move is justified by a benefit that arrives when the
  // moved run produces something; taken again before it has, the benefit is
  // never collected and the cost is paid twice, three times, forty times.
  //
  // A run 0.8 s old has 0.14 s left to go against 0.94 s to move it, so it is
  // left alone; one working for half a minute has nothing left, and a move
  // happens exactly when the film it would reach sooner is worth the restart. No
  // state to keep and nothing to choose: one measured figure minus elapsed time.
  const finishesItsPieceIn = (run, perPiece) => {
    // WHEN THIS RUN FINISHES THE PIECE IT IS STANDING ON.
    //
    // Two cases and neither is a choice: a run that has produced something is
    // working at a known rate, so the piece under it lands within one piece's
    // worth of time; a run that has produced nothing is still in its warm-up,
    // and what is left of that is the measured time to a first piece less the
    // time it has already been alive.
    //
    // This is the memory the score was missing. It is computed afresh whenever
    // anything changes, and each arrangement used to be priced as though it were
    // the last decision anybody would take: a run 0.8 s into a 0.9 s piece was
    // charged a whole piece for it, the same as one about to start, so killing
    // it and beginning again elsewhere looked cheaper by ten milliseconds. A
    // move is justified by a benefit that arrives when the moved run produces
    // something; taken again before it has, the benefit is never collected and
    // the cost is paid twice, three times, forty times.
    //
    // One measured figure minus elapsed time. Nothing to keep and nothing to
    // choose.
    if (Number(run.head) !== Number(run.from)) {
      return perPiece;
    }
    const startedAt = Number(run.startedAt);
    if (!Number.isFinite(startedAt) || startedAt <= 0) {
      return firstByteWaitSec;
    }
    return Math.max(0, firstByteWaitSec - (now - startedAt) / 1000);
  };

  // WHAT EACH BODY OWES BEFORE THE PIECE IT STANDS ON EXISTS, priced at the rate
  // the arrangement itself puts in force.
  //
  // Each encoder states its own debt where it is created, as a function of what one
  // piece costs — because only there is it known what the encoder IS, and here only
  // how many of them there are. So there is nothing to dispatch on: no kind, no
  // tag, no case analysis. The count is known before any debt is needed, which
  // is why this is one pass over the encoders rather than a figure computed once
  // outside.
  const priced = (encoders) => {
    const perPiece = pieceAt(encoders.length);
    return encoders.map((encoder) => ({ at: encoder.at, delaySec: encoder.owes(perPiece) }));
  };


  // WHERE A SECOND ENCODER MEETS THE ONE ALREADY ON A STRETCH, and whether it is
  // worth having.
  //
  // A stretch of unmade film runs from `from` to `to`. Whoever is already on it
  // stands at `from` and owes `w` before the piece under it exists; a fresh one
  // placed at `x` owes `d` — its start, and then a whole piece — and both then
  // work at the rate two encoders leave each other, which is measured on this
  // host and is not half by assumption.
  //
  //   the one already there closes [from, x-1]:  w + (x - 1 - from) / r
  //   the fresh one closes         [x, to]:      d + (to - x) / r
  //
  // The first rises with `x` and the second falls, so the stretch is closed
  // soonest where they cross:
  //
  //   x* = (from + to + 1) / 2  +  (d - w) * r / 2
  //
  // The midpoint, shifted forward by half the difference of what the two owe,
  // expressed in pieces. Halving is the special case `d = w`, which holds when
  // both are fresh — and it was applied to every case, including the common one
  // where `d` is a start plus a piece and `w` is the tail of a piece already
  // being made.
  //
  // AND WHETHER TO SPLIT AT ALL, which halving never asked. Two encoders under
  // contention against one at full speed:
  //
  //   one:  w + (to - from - 1) / rate
  //   two:  w + (x* - 1 - from) / r
  //
  // Nothing back where the second does not win. On the addon host at 1920x1080
  // the measured penalty for a second encoder is 1.98 — it takes very nearly
  // all of the first's speed — so there a second almost never pays, and it was
  // being placed regardless.
  const splitAt = (from, to) => {
    const pieces = to - from + 1;
    if (!(pieces > 1) || !(rate > 0)) {
      return null;
    }
    const together = rate / contentionPenaltyFor(live.length);
    if (!(together > 0)) {
      return null;
    }
    const perPieceTogether = 1 / together;
    // What the one already on this stretch owes, or a fresh one's debt where
    // nobody is on it — and then both sides owe the same and the meeting point
    // is the middle, as it should be.
    const onIt = live.find((run) => Number(run.head) === from) ?? null;
    const owedThere = onIt
      ? finishesItsPieceIn(onIt, perPieceTogether)
      : firstByteWaitSec + perPieceTogether;
    const owedFresh = firstByteWaitSec + perPieceTogether;
    const meeting = (from + to + 1) / 2 + ((owedFresh - owedThere) * together) / 2;
    const x = Math.min(to, Math.max(from + 1, Math.round(meeting)));
    const withTwo = owedThere + (x - 1 - from) * perPieceTogether;
    const withOne = owedThere + (pieces - 1) / rate;
    return withTwo < withOne ? x : null;
  };

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
    // needs a encoder brought to it. There is no third case, and in particular no
    // separate question of whether an encoder should drive on or be moved:
    // driving is simply its arrival, and its arrival is priced in one place.
    firstGap: gapFinderFor(coverage, new Set(live), rate, segmentSeconds * refetchSecPerFilmSecond),
    deadlineAt: untilNeeded,
    splitAt
  });

  // -------------------------------------------------------------------- WHO
  //
  // ARGMIN OF THE OBJECTIVE, EVALUATED. Not a rule that approximates it.
  //
  // Every way of filling the positions is scored by `latenessOf` and the best is
  // taken. There are at most a handful of positions and a handful of encoders, so
  // the enumeration is exact: no local rule stands in for the objective, and
  // none can therefore disagree with another.
  //
  // Four such rules were written before this and all four had to go — "place
  // where a number is late", "take a encoder that serves nothing", "take one whose
  // work is needed later than this", "drive on or move, by cost". Each looked
  // like a consequence of the model and each approximated it from a different
  // side, so together they contradicted one another and the answer depended on
  // which ran first.
  /** One decision per live encoder, so none can be decided twice. @type {Map<object, PlanAction>} */
  const decided = new Map();
  const room = Math.max(0, maxRuns - live.length);
  const refetchPerSegment = segmentSeconds * refetchSecPerFilmSecond;

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
    const encoders = [];
    for (let index = 0; index < positions.length; index += 1) {
      const filler = arrangement.fill[index];
      if (filler === null) {
        continue;
      }
      if (filler === "new") {
        // A encoder that does not exist yet owes its own start and then the piece.
        encoders.push({ at: positions[index], owes: (piece) => spawnOverheadSec + piece });
        continue;
      }
      const head = Number(filler.head);
      // Left where it stands it owes what is left of the piece under it; taken
      // somewhere else it owes the killing, the start and a whole piece.
      encoders.push({
        at: positions[index],
        owes: head === positions[index]
          ? (piece) => finishesItsPieceIn(filler, piece)
          : (piece) => moveSec + piece
      });
    }
    // Bodies nobody was given a position for go on working where they stand,
    // and their coverage counts: the file is encoded whole.
    //
    // A encoder given no end pays a restart the moment anybody is placed inside the
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
      encoders.push({
        at: head,
        owes: cutInFront
          ? (piece) => moveSec + piece
          : (piece) => finishesItsPieceIn(run, piece)
      });
    }
    const scored = latenessOf(priced(encoders), coverage, wanted, untilNeeded, rate / contentionPenaltyFor(Math.max(0, encoders.length - 1)), refetchPerSegment, segmentSeconds);
    if (bestScore === null || cheaperThan(scored, bestScore)) {
      bestScore = scored;
      best = arrangement;
    }
  }

  // A BODY STANDING ON FILM THAT EXISTS is the one arrangement the enumeration
  // above cannot reach: the gap in front of it is nobody's deadline, so it is
  // never a position, and the encoder is left to make three hundred pieces a second
  // time. Each such encoder is offered its own first gap and the SAME score decides
  // — moving costs a restart on everything downstream, staying costs the repeat.
  //
  // Offered one at a time rather than folded into the enumeration because the
  // enumeration is exponential in the number of positions, and this is called
  // again on every piece produced. One extra evaluation per encoder against
  // several thousand arrangements is the difference between arithmetic and a
  // stalled proxy.
  const placement = new Map();
  for (let index = 0; index < positions.length; index += 1) {
    const filler = best ? best.fill[index] : null;
    if (filler && filler !== "new") {
      placement.set(filler, positions[index]);
    }
  }
  const encodersOf = (override) => {
    const encoders = [];
    for (const run of live) {
      if (override.has(run) && override.get(run) === null) {
        // Asked what the film looks like WITHOUT this one.
        continue;
      }
      const at = override.has(run) ? override.get(run) : (placement.get(run) ?? Number(run.head));
      const head = Number(run.head);
      encoders.push({
        at,
        owes: at === head
          ? (piece) => finishesItsPieceIn(run, piece)
          : (piece) => moveSec + piece
      });
    }
    for (let index = 0; index < positions.length; index += 1) {
      if ((best ? best.fill[index] : null) === "new") {
        encoders.push({ at: positions[index], owes: (piece) => spawnOverheadSec + piece });
      }
    }
    return priced(encoders);
  };
  const scoreOf = (override) => {
    const encoders = encodersOf(override);
    return latenessOf(encoders, coverage, wanted, untilNeeded,
      rate / contentionPenaltyFor(Math.max(0, encoders.length - 1)), refetchPerSegment, segmentSeconds);
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
    if (cheaperThan(moved, asIs)) {
      placement.set(run, gap);
    }
  }

  /**
   * Would the film be worse off without this encoder? Asked of the same score.
   *
   * @param {object} run
   * @returns {boolean}
   */
  const worseWithout = (run) => {
    const kept = encodersOf(new Map());
    const without = encodersOf(new Map([[run, null]]));
    const scoreOf_ = (encoders) => latenessOf(encoders, coverage, wanted, untilNeeded,
      rate / contentionPenaltyFor(Math.max(0, encoders.length - 1)), refetchPerSegment, segmentSeconds);
    return cheaperThan(scoreOf_(kept), scoreOf_(without));
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
    // A encoder left over from where a viewer used to be goes on costing the
    // machine a process while another encoder already reaches everything it
    // would. The score says so directly: take it away and see. Removing it is
    // refused the moment it makes anything later or leaves film abandoned, so
    // this cannot quietly drop the encoder somebody is waiting on.
    if (!placement.has(run) && !worseWithout(run)) {
      stops.push({
        type: "stop",
        run,
        because: "the film is no worse off without it"
      });
      continue;
    }
    decided.set(run, { type: "keep", run, from: head, to: run.to });
  }

  // THE MACHINE'S LIMIT BINDS, whatever the map wants. It is measured — the
  // processor, the swarm and the piece store each give a figure and the smallest
  // wins — and an encoder over it is one the host cannot feed. Which of them
  // goes is the same question as any other here: the one the film misses least,
  // by the same score.
  while (decided.size + starts.length > maxRuns) {
    let cheapest = null;
    let cheapestScore = null;
    for (const [run, action] of decided) {
      if (action.type !== "keep") {
        continue;
      }
      const without = latenessOf(encodersOf(new Map([[run, null]])), coverage, wanted, untilNeeded,
        rate / contentionPenaltyFor(Math.max(0, live.length - 2)), refetchPerSegment, segmentSeconds);
      if (cheapestScore === null || cheaperThan(without, cheapestScore)) {
        cheapestScore = without;
        cheapest = run;
      }
    }
    if (cheapest === null) {
      break;
    }
    decided.delete(cheapest);
    placement.delete(cheapest);
    stops.push({
      type: "stop",
      run: cheapest,
      because: `the machine holds ${maxRuns} encoder(s) on this output and this is the one ` +
        "the film misses least"
    });
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
 * THREE COUNTS OF SECONDS, COMPARED IN ORDER. The order is the user's, stated
 * 2026-09-06, and a later count decides only where the earlier ones tie:
 *
 * 1. SECONDS ANYBODY SPENDS LOOKING AT A SPINNER. Nothing outranks it, at any
 *    size. Walked forward in film order rather than summed piece by piece: a
 *    viewer who is stopped is not watching, so a wait moves every deadline
 *    behind it by its own length;
 *
 * 2. WHEN THE FILM IN FRONT OF THE VIEWERS IS FINISHED — the last piece of it to
 *    be made, whichever encoder makes it. A stretch no encoder will ever reach
 *    counts as never, which is what stops the front being abandoned;
 *
 * 3. WHEN THE WHOLE FILE IS FINISHED — the film behind the viewers included,
 *    plus what the swarm pays to fetch anything a second time. Film nobody is
 *    waiting for still has value: a viewer seeking back into a part that exists
 *    starts playing at once, and seeking back is what people do in the first
 *    minutes while they find their place. So spare capacity goes to finishing
 *    the file. This is where "the file is encoded WHOLE" lives; it used to be a
 *    penalty for film below the lowest encoder, which said the same thing as a
 *    patch and said it about one edge of the track only.
 *
 * WHY AN ENCODER MAY STAND BEHIND A VIEWER while film in front is still unmade:
 * encoders work at the same time, so one in front and one behind can finish the
 * file sooner than two in front. Where nobody is stalled and the front is closed
 * just as fast, the file being done sooner is the answer — count 3 deciding a
 * tie in 1 and 2, which is exactly what the order is for.
 *
 * WHY THE COUNTS ARE COMPARED AND NOT ADDED: seconds of somebody waiting and
 * seconds until a distant stretch exists are not the same thing, and no measured
 * quantity says how many of one are worth one of the other. Adding them would
 * mean choosing that exchange rate, which is inventing a number.
 *
 * @param {{ at: number, delaySec: number }[]} encoders - Where each encoder would
 *   stand, and how long before it produces anything there: nothing where it is
 *   already standing, a move or a start otherwise.
 * @param {import("./CoverageMap.js").CoverageMap} coverage
 * @param {WantedSpan[]} wanted
 * @param {(index: number) => number} untilNeeded
 * @param {number} rate - Segments per second. Always a real figure: this host
 *   measures what it encodes at on startup, before any viewer exists, and every
 *   run that works then refines it. There is no "unmeasured" case to answer.
 * @param {number} refetchSecPerSegment
 * @param {number} segmentSeconds
 * @returns {{ stall: number, ahead: number, whole: number }} Three counts of
 *   seconds, compared in that order by {@link cheaperThan}.
 */
function latenessOf(encoders, coverage, wanted, untilNeeded, rate, refetchSecPerSegment, segmentSeconds) {
  const first = Math.min(...wanted.map((span) => span.from));
  const last = Math.max(...wanted.map((span) => span.to));
  // What a number nobody reaches at all counts as. The film's own length is the
  // honest bound — nothing can be later than never — and a finite figure is what
  // lets two hopeless arrangements still be told apart by the rest of the sum.
  const never = (last + 1) * segmentSeconds;

  // WHICH SIDE OF THE VIEWERS a piece is on. The map states it; nothing here
  // works it out from positions, and nothing here knows where a viewer stands.
  //
  // It was read off the deadline before — no time stated meant behind — and that
  // is true only of a viewer who is playing. A paused viewer has no times
  // anywhere, so their whole film read as behind them, "ahead before behind"
  // had nothing to compare, and the encoder was free to wander to the start of
  // the file. Which side a stretch is on and how soon it is wanted are two
  // different facts, and the map states both.
  // WHAT RANK THE MAP GIVES THIS NUMBER — the highest, where zones overlap,
  // because a number two viewers want is wanted as much as the more urgent of
  // them wants it.
  //
  // This replaced a boolean, "is it behind everybody", and the boolean was the
  // whole of what the objective knew about the map's own order. The map states
  // ten ranks on a film — p100 at the number a viewer is stopped on, doubling
  // zones down to p91 for the far tail, p1 for what lies behind them — and all
  // of that was collapsed into two buckets and then converted to seconds, where
  // "never" for the film behind is the film's own length. On a 48-minute file
  // that is 2024 s, which outvotes everything: field 2026-09-08, one viewer got
  // three encoders, two of them on film behind them, and the run serving them
  // was killed to make room for one.
  const rankAt = (at) => {
    let rank = 0;
    for (const span of wanted) {
      if (at >= span.from && at <= span.to) {
        rank = Math.max(rank, Number(span.priority) || 0);
      }
    }
    return rank;
  };
  // The ranks the map actually states, most urgent first. The comparison is over
  // these and nothing else, so a rank can never be outvoted by a lower one
  // however many seconds are at stake there.
  const ranks = [...new Set(wanted.map((span) => Number(span.priority) || 0))]
    .sort((left, right) => right - left);

  // EVERY COUNT IS OVER THE FILM, NOT OVER THE ENCODERS. When a piece is made
  // depends on which encoder reaches it soonest, and the encoder that reaches
  // film in front of the viewers may well be standing behind them.
  //
  // Counted over the encoders instead — each charged to the side it stands on —
  // the score had a hole that swallowed everything: an arrangement with every
  // encoder BEHIND the viewers had nothing charged to the film in front, so its
  // second term was zero, which is the best value there is. The plan then
  // abandoned the film in front of a viewer and put both encoders at the start
  // of the file, which is the opposite of the rule it is supposed to obey.
  //
  // AND THE WAITING IS WALKED FORWARD, not summed piece by piece.
  //
  // Not a sum of each piece's own lateness. A viewer who is stopped is not
  // watching, so everything after the piece they are stopped on is needed that
  // much later too: one wait moves every deadline behind it by its own length.
  //
  // Summed independently instead, the far tail of a long file outvoted the film
  // under the viewer's feet — measured, and it placed the only encoder at #114
  // while the viewer stood at #100, because thirteen pieces of certain waiting
  // "cost" less than 886 distant pieces arriving a little later. Walking the
  // clock forward makes that trade impossible: abandoning the near film delays
  // the far film by at least as much.
  let stalled = 0;
  let wastedSwarm = 0;
  /** Seconds anybody waits past a deadline, per rank. @type {Map<number, number>} */
  const lateAt = new Map(ranks.map((rank) => [rank, 0]));
  /** When the last number of a rank is made, per rank. @type {Map<number, number>} */
  const doneAt = new Map(ranks.map((rank) => [rank, 0]));
  for (let index = first; index <= last; index += 1) {
    // Which encoder gets to this piece first, and when. One standing on it is
    // already there; one behind it must work its way up, re-making anything
    // already made on the way, which costs its own time and the swarm's.
    let soonest = Number.POSITIVE_INFINITY;
    let byWhom = null;
    for (const encoder of encoders) {
      if (encoder.at > index) {
        continue;
      }
      // WHEN THIS BODY REACHES THIS NUMBER. `delaySec` is when it finishes the
      // piece it is STANDING ON, so the pieces after it are the only ones still
      // to be encoded at `rate`.
      //
      // It used to be `(index - at + 1) / rate` on top of the delay, which
      // charges every encoder a whole piece for the one it is already working on. A
      // fresh encoder does start from nothing, so for it that is right — and it is
      // now inside its own delay. A run 0.8 s into a 0.9 s piece does not, and
      // charging it 0.94 s for that piece is what made moving it look cheaper
      // than leaving it: from #58 it was priced at 1.89 s to reach #59 against
      // 1.88 s for a kill and a cold start, a difference of ten milliseconds
      // that is nothing but the double charge. Field 2026-09-08: 39 moves in one
      // session, 24 of them between three adjacent numbers, and the picture
      // stood still for 116.7 s.
      const arrival = encoder.delaySec
        + (index - encoder.at) / rate
        + coverage.madeBetween(encoder.at, index) * refetchSecPerSegment;
      if (arrival < soonest) {
        soonest = arrival;
        byWhom = encoder;
      }
    }
    if (coverage.isReady(index)) {
      // It exists. Nobody waits for it and nothing is owed — but whoever passes
      // over it makes it a second time, and the swarm fetches its bytes again.
      if (byWhom !== null) {
        wastedSwarm += refetchSecPerSegment;
      }
      continue;
    }
    // A piece nobody is working towards arrives never. There is no third case:
    // the host measures what it encodes at, and what it copies at, before any
    // viewer exists, so a speed is always a real number and an arrival can
    // always be computed.
    // Nothing arrives later than never, which is the bound the film's own length
    // gives. It is a definition rather than a guard: it also makes the score
    // total on a host whose startup measured nothing at all, where every arrival
    // is beyond reckoning and every arrangement is therefore equally hopeless.
    const when = byWhom === null ? never : Math.min(soonest, never);
    const rank = rankAt(index);
    doneAt.set(rank, Math.max(doneAt.get(rank) ?? 0, when));
    const deadline = untilNeeded(index);
    if (Number.isFinite(deadline)) {
      const due = deadline + stalled;
      const waited = Math.max(0, when - due);
      lateAt.set(rank, (lateAt.get(rank) ?? 0) + waited);
      stalled += waited;
    }
  }

  return {
    // THE MAP'S OWN ORDER, AS A VECTOR. One pair per rank the map states, most
    // urgent rank first: how long anybody waits at that rank, then when the last
    // number of it is made.
    //
    // Compared position by position, so a rank is never outvoted by a lower one
    // — which is the whole of what was asked for: nobody stares at a spinner;
    // then the film in front of the viewers is encoded as fast as it can be, band
    // by band as the map ranks them; then, with whatever is left over and only
    // then, the film behind them, in case somebody seeks back.
    //
    // No weights, and none possible: a weight would let seconds at one rank buy
    // seconds at another, and it would be a number nobody measured. The map is
    // the source of truth about what matters, and it already says so.
    byRank: ranks.flatMap((rank) => [lateAt.get(rank) ?? 0, doneAt.get(rank) ?? 0]),
    // HOW MANY ENCODERS IT TAKES. Ranked below every rank of the map and above
    // the swarm's bill, so it cannot buy one where the map is indifferent — and
    // the map IS indifferent about spare capacity, which is what bought an
    // encoder for film nobody waits for.
    encoders: encoders.length,
    // WHAT THE SWARM PAYS for anything fetched twice, which delays everything.
    wasted: wastedSwarm
  };
}

/**
 * Is the first arrangement cheaper than the second?
 *
 * Three things in order, stated by the user 2026-09-06: nobody stares at a
 * spinner; then the film in front of the viewers is finished soonest; then the
 * whole file is. A later one decides only where the earlier ones tie.
 *
 * That order is why an encoder may stand BEHIND a viewer while film in front is
 * still unmade: encoders work at the same time, so one in front and one behind
 * can finish the file sooner than two in front — and where nobody is stalled and
 * the front is closed just as fast, the file being done sooner is the answer.
 *
 * @param {{ stall: number, ahead: number, whole: number }} left
 * @param {{ stall: number, ahead: number, whole: number }} right
 * @returns {boolean}
 */
function cheaperThan(left, right) {
  // POSITION BY POSITION, in the map's own order of ranks. A difference at a
  // higher rank settles it, and nothing at a lower one can reopen it.
  //
  // There is no margin here and there must not be one. A threshold — "a move
  // must beat staying by at least what moving costs" — was written while the
  // arrival arithmetic charged a run for a piece it had already half made, and
  // it was a prop under a comparison that was wrong rather than indifferent.
  // With the arithmetic right the two are 1.08 s against 1.88 s, and nothing
  // needs propping.
  const size = Math.max(left.byRank.length, right.byRank.length);
  for (let index = 0; index < size; index += 1) {
    const here = left.byRank[index] ?? 0;
    const there = right.byRank[index] ?? 0;
    if (here !== there) {
      return here < there;
    }
  }
  // Where every rank is served identically, fewer encoders. The map is
  // indifferent, so the machine decides: a process, a reader of the piece store
  // and the swarm's bandwidth are all paid by the viewers the ranks above are
  // about.
  if (left.encoders !== right.encoders) {
    return left.encoders < right.encoders;
  }
  return left.wasted < right.wasted;
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
/** @param {WantedSpan[]} windows */
function firstOf(windows) {
  return Math.min(...windows.map((span) => span.from));
}

/** @param {WantedSpan[]} windows */
function lastOf(windows) {
  return Math.max(...windows.map((span) => span.to));
}

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
      // `null` IS A STATEMENT AND IT SAYS NOBODY IS COMING. `undefined` is the
      // absence of one, and a caller that knows only a position is somebody
      // waiting at it.
      //
      // Read through `Number()`, `null` becomes 0 — due NOW — so the film BEHIND
      // the viewers, which the map marks with exactly that, was the most urgent
      // material in the file. Everything followed from it: it bought encoders,
      // it took the run standing in front of the viewer because that run was the
      // nearest encoder to it, and it did so again on every pass. Field 2026-09-08:
      // 39 moves in one session, 24 between three adjacent numbers, one viewer
      // on three encoders, and the picture stood still for 116.7 s in three
      // interruptions, the worst of them 91.8 s.
      //
      // The map has always said it plainly — `{"from":0,"to":57,"priority":1,
      // "withinSeconds":null,"behind":true}` is in the log of every session — and
      // this line turned it into its opposite. Fourth time in this repository
      // that the input to a calculation was not what the calculation assumed.
      const within = stated === undefined ? 0 : (stated === null ? Number.NaN : Number(stated));
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
        // NOBODY IS COMING HERE, so nothing can be late — but the film is still
        // wanted, and this is where spare capacity goes. The number is proposed;
        // whether an encoder is actually spent on it is the score's answer, and
        // the score puts anything anybody is waiting for first.
        return index;
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
export function placeEncoders({
  coverage,
  windows,
  howMany,
  firstGap = null,
  deadlineAt = null,
  // WHERE TWO ENCODERS SHARE A STRETCH, and whether a second is worth having at
  // all. Derived by whoever holds the measurements — the rates, the contention
  // penalty, what a start costs — because this function is positional and holds
  // none of them. The default is the midpoint, which IS the answer when both are
  // fresh and owe the same, and is what a caller with nothing measured falls
  // back on.
  splitAt = (from, to) => from + Math.floor((to - from + 1) / 2)
}) {
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


  // CANDIDATES COME FROM THE PRIORITY MAP, IN THE ORDER THE MAP STATES.
  //
  // The map already answers every question that was being re-derived here. Its
  // ranks say what matters most — the number a viewer is stopped on, then what
  // is in front of them band by band, then the rest of the track, and last of
  // all what lies behind them. A pause flattens those ranks; a seek moves them;
  // a second viewer merges into them. So walking the map in its own order is
  // what "ahead before behind" means, and nothing here has to work out where the
  // viewers are.
  //
  // It was not read that way. This walked the film by number and proposed
  // whatever was late, then a second pass divided the leftovers — an order of
  // its own invention, which put the beginning of the file before the film in
  // front of a viewer and, at one point, proposed #0, #1 and #2 as three
  // separate places.
  //
  // One candidate per zone: the first number in it nobody has and nobody
  // reaches in time. Zones with no deadline can have nothing late in them, so
  // there it is simply the first number nobody has — which is how spare capacity
  // comes to finish the file.
  /** @type {number[]} */
  const places = [];
  const byRank = [...windows].sort(
    (left, right) => (right.priority ?? 0) - (left.priority ?? 0) || left.from - right.from
  );
  for (const zone of byRank) {
    if (places.length >= howMany) {
      break;
    }
    const at = gapAt(zone.from, zone.to);
    if (at === null || places.includes(at)) {
      continue;
    }
    places.push(at);
    placedHere.push(at);
  }

  // AND WHERE TO SPLIT WHAT IS LEFT, for the capacity the map has not spent.
  //
  // The search above proposes only what is LATE, so once one encoder covers a
  // zone in time that zone proposes nothing more — and a machine that holds four
  // ran one. Finishing a contiguous stretch soonest with several machines of the
  // same speed means dividing it between them, which is where these come from:
  // the widest run of film between two encoders, split.
  //
  // Proposing is not spending. The score decides whether another process is
  // worth it, and its first term — how late the film is — always outranks its
  // second, so this can never take capacity from somebody waiting.
  while (places.length < howMany) {
    const edges = [...places].sort((left, right) => left - right);
    let widestFrom = null;
    let widest = 0;
    for (let index = 0; index <= edges.length; index += 1) {
      const from = index === 0 ? firstOf(windows) : edges[index - 1] + 1;
      const to = index === edges.length ? lastOf(windows) : edges[index] - 1;
      const room_ = coverage.unmadeRunFrom(from);
      if (to >= from && room_ > widest) {
        // WHERE THE TWO OF THEM MEET, calculated rather than halved. Halving is
        // the answer only when both encoders are fresh and owe the same, and it
        // was applied to every case — one already working is partway through a
        // piece while a new one owes its whole start, so the point where they
        // finish together lies further on. Nothing back means a second encoder
        // does not pay for itself here at all: two under this host's measured
        // contention against one at full speed, a comparison halving never made.
        const meet = splitAt(from, Math.min(from + room_ - 1, to));
        if (meet !== null) {
          widest = room_;
          widestFrom = meet;
        }
      }
    }
    if (widestFrom === null) {
      break;
    }
    const at = coverage.firstGapFrom(widestFrom, lastOf(windows));
    if (at === null || places.includes(at)) {
      break;
    }
    places.push(at);
    placedHere.push(at);
  }

  // These are CANDIDATES, not decisions. What is late proposes first, because
  // that is what a viewer feels; what is merely unmade proposes after it. The
  // score decides which of them are worth a process, and a paused viewer, who
  // states no deadline at all, therefore still leaves the file being finished
  // rather than the machine falling idle.
  return places.sort((left, right) => left - right);
}

