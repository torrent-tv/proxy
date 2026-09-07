/**
 * @file How many encoders run on this proxy, on which outputs, and over which
 * stretches.
 *
 * The application layer over `encode/`. It holds four things and owns none of
 * their rules:
 *
 * 1. what viewers want (`SegmentDemand`), stated once each and read as a union;
 * 2. what has been made and what is being made, one `CoverageMap` per output;
 * 3. the encoders that are running (`EncodeRun`), each over a stretch;
 * 4. a tally of how every run ended, which is what makes "abnormal endings do
 *    not happen" a number rather than an impression.
 *
 * The decision itself is `EncodePlan.planEncoders`, from numbers alone. This
 * carries it out, and everything it cannot know is injected: how many encoders
 * this machine can afford, how a run is built for a given stretch, and which
 * segments already exist.
 *
 * **No viewer reaches the decision.** A viewer states a window and is forgotten
 * as a name; what the plan sees is a union of windows. That is the rule the
 * layer exists for, stated by the user 2026-09-04: requests come from any
 * viewers in any number, encoders are managed to suit them, and viewers get the
 * result when it is ready.
 */

import { CoverageMap } from "../encode/CoverageMap.js";
import { firstUnmetWant, planEncoders } from "../encode/EncodePlan.js";
import { endOfRun } from "../encode/EncodeRun.js";
import { ENCODE_EXIT } from "../encode/encode-exit.js";
import { affordableRuns } from "../encode/run-budget.js";
import { RunCosts } from "../encode/run-costs.js";
import { contentionPenalty } from "../encode/contention.js";
import { SegmentDemand } from "../encode/SegmentDemand.js";

export class EncodeOrchestrator {
  /** Output address to what has been made of it. @type {Map<string, CoverageMap>} */
  #coverage = new Map();

  /** Output address to the runs on it. @type {Map<string, import("../encode/EncodeRun.js").EncodeRun[]>} */
  #runs = new Map();


  /** The fastest speed measured on one output, kept across restarts. @type {Map<string, number>} */
  #lastSpeed = new Map();

  /** How runs have ended, by cause. @type {Map<string, number>} */
  #endings = new Map();

  /** The last state said out loud, so an unchanged state is not repeated. */
  #lastDescribed = "";

  /** What a stop and a start have cost on this host. */
  #costs = new RunCosts();

  /** The last reason a budget was cut, so the same one is not said twice. */
  #lastBudgetReason = new Map();

  /** The last unmet want said out loud, so a stuck one is said once. */
  #lastUnmet = new Map();

  /**
   * @param {object} params
   * @param {(address: string) => number} params.maxRunsFor - How many encoders
   *   this machine can afford on one output. The same arithmetic that decides
   *   the quality offer; measured per host, never chosen here.
   * @param {(params: { address: string, from: number, to: number }) =>
   *   import("../encode/EncodeRun.js").EncodeRun} params.makeRun - Build a run
   *   for a stretch. What to read, what to map and how to cut belong to whoever
   *   knows the source.
   * @param {number} params.segmentSeconds
   * @param {import("../encode/contention.js").ContentionPenalties | null}
   *   [params.contentionPenalties] - How much slower one encoder runs beside
   *   others, MEASURED on this host at startup and keyed by how many others
   *   there are. Null until something has measured it, and then the penalty is
   *   1 — a number invented here would be the same mistake as an invented
   *   encoding speed.
   * @param {{ info: (line: string) => void, warn: (line: string) => void }} params.logger
   * @param {() => number} [params.now]
   */
  constructor({
    maxRunsFor,
    makeRun,
    segmentSeconds,
    contentionPenalties = null,
    refetchSecPerFilmSecond = () => 0,
    startingSpeedFor = () => 0,
    segmentStore = null,
    logger,
    now
  }) {
    // The store of produced segments — the layer below this one. It is asked to
    // clean up after a run that ended other than by reaching the end of its
    // stretch, which is the one thing an ending must not leave behind: a file
    // under a name that promises a whole segment.
    this.segmentStore = segmentStore;
    this.demand = new SegmentDemand();
    this.maxRunsFor = maxRunsFor;
    // Seconds of swarm time per second of film: what re-encoding material that
    // already exists costs the download, over and above the encoder's own time.
    // Injected, because the film's byte rate and the swarm's are measured
    // elsewhere and this class must not reach for them.
    this.refetchSecPerFilmSecond = refetchSecPerFilmSecond;
    // Measured per host: what a second encoder costs the first. Unmeasured is 1,
    // and then only the budget bounds how many there are.
    this.contentionPenalties = contentionPenalties instanceof Map ? contentionPenalties : null;
    // WHAT THIS HOST ENCODES AT BEFORE ANY RUN HAS REPORTED. The startup
    // benchmark measures it — a real pipeline over real clips, before a viewer
    // exists — so the plan is never asked to compare arrivals with no speed to
    // compute them from. Every run that then works refines it.
    this.startingSpeedFor = startingSpeedFor;
    this.makeRun = makeRun;
    this.segmentSeconds = segmentSeconds;
    this.logger = logger;
    this.now = typeof now === "function" ? now : Date.now;
  }

  /**
   * The map of one output, made on first mention.
   *
   * @param {string} address
   * @returns {CoverageMap}
   */
  coverageOf(address) {
    let map = this.#coverage.get(address);
    if (!map) {
      map = new CoverageMap();
      this.#coverage.set(address, map);
    }
    return map;
  }

  /**
   * Put the map's picture of what is ready back in step with the disk.
   *
   * ONE AUTHORITY ON WHAT EXISTS, AND IT IS THE STORE. The map holds no memory
   * of readiness between calls: it is handed the whole answer, replacing
   * whatever it had, immediately before anything is decided from it. So a
   * segment whose file was discarded with the run that had it open, dropped to
   * make room, or reopened by a run restarting on it stops being ready in the
   * same breath — without anything having to notice and say so.
   *
   * The map used to be filled from outside, by the session manager, with a
   * method that only ever added. Nothing anywhere took a number back. Field
   * 2026-09-07: the map claimed all 482 segments of a film while the directory
   * held nothing, so every arrangement scored perfect, the only encoder was
   * stopped as unnecessary and none was placed again — two sessions in a row
   * with no picture at all.
   *
   * A store is optional here only in the sense that an authority which was not
   * supplied cannot be consulted: without one the map keeps what it was told
   * directly, which is how this class is exercised with plain numbers.
   *
   * @param {string} address
   * @returns {CoverageMap}
   */
  #upToDateCoverage(address) {
    const coverage = this.coverageOf(address);
    if (this.segmentStore) {
      coverage.setReady(this.segmentStore.provenNumbers(address));
    }
    return coverage;
  }

  /**
   * Where a run started here must stop: the free stretch in front of it.
   *
   * Asked of the one map, brought up to date first. It used to be worked out by
   * the session manager, which reached into this layer for the map and into the
   * store for what was on the disk and put the two together itself — one fact
   * with two owners and a third party carrying it between them, which is how the
   * two came to disagree.
   *
   * @param {object} params
   * @param {string} params.address
   * @param {number} params.from - Where the run will start.
   * @param {object | null} [params.exceptRun] - The run being replaced, whose
   *   own claim is not somebody else's material.
   * @param {number} [params.segmentCount] - The output's length, when known.
   * @returns {number} The last number to work through, or `-1` for the end of
   *   the film.
   */
  freeStretchEnd({ address, from, exceptRun = null, segmentCount = 0 }) {
    if (!address) {
      return -1;
    }
    if (segmentCount > 0) {
      this.coverageOf(address).setSegmentCount(segmentCount);
    }
    const coverage = this.#upToDateCoverage(address);
    const start = Math.max(0, from);
    const free = coverage.freeRunFrom(start, exceptRun);
    if (!Number.isFinite(free)) {
      return -1;
    }
    const end = start + Math.max(1, free) - 1;
    return segmentCount > 0 && end >= segmentCount - 1 ? -1 : end;
  }

  /**
   * @param {string} address
   * @returns {import("../encode/EncodeRun.js").EncodeRun[]}
   */
  runsOn(address) {
    return this.#runs.get(address) ?? [];
  }

  /**
   * How long an output is, once its playlist is known.
   *
   * @param {string} address
   * @param {number} segmentCount
   */
  setSegmentCount(address, segmentCount) {
    this.coverageOf(address).setSegmentCount(segmentCount);
  }

  /**
   * Segments that already exist — from a previous life of this process, or
   * because somebody else made them. Told to the map, which is what stops an
   * encoder being started to make them again.
   *
   * @param {string} address
   * @param {Iterable<number>} indexes
   */
  noteAlreadyMade(address, indexes) {
    for (const index of indexes) {
      this.noteProduced(address, index);
    }
  }

  /**
   * A viewer states what it is waiting for. Replaces whatever it said before.
   *
   * @param {object} params
   * @param {string} params.claimant
   * @param {string} params.address
   * @param {number} params.from
   * @param {number} params.to
   * @param {number} [params.priority] - Higher is sooner. One viewer states
   *   several stretches at once — what must be ready before they set off, what
   *   is reachable while they watch it, the rest of the track — and the filling
   *   takes them in this order. Absent means one undifferentiated want, which
   *   is what a caller that knows only a position states.
   */
  /**
   * What is wanted of one output, in its own segment numbers.
   *
   * ONE MAP, ALREADY MERGED, AND WITH NOBODY'S NAME ON IT. It is built once per
   * film by the layer that knows where the viewers are; this layer receives it
   * converted into an output's own numbering and never asks who is in it.
   *
   * That replaced a window per viewer per band stated here and merged here,
   * which was the same work done twice in two layers, with the viewer's name as
   * the key of a claim — against the rule that the encoding and the viewer are
   * not connected at all.
   *
   * An empty map says nobody is coming anywhere in this output, and the plan
   * stops its encoders for it. Nothing has to be released when somebody leaves:
   * the map that arrives next simply does not have them in it.
   *
   * @param {string} address
   * @param {{ from: number, to: number, priority: number, withinSeconds: number }[]} zones
   */
  notePriorityMap(address, zones) {
    this.demand.state(address, zones);
  }

  /**
   * A segment has been finished, by whichever run made it.
   *
   * @param {string} address
   * @param {number} index
   */
  noteProduced(address, index) {
    // TOLD TO THE AUTHORITY, not only to the map. A piece being closed is a fact
    // about the disk, and the store is what holds those; told to the map alone
    // it would survive exactly until the next time the map is brought back into
    // step, and then be gone with no file to show for it.
    this.segmentStore?.markClosed(address, index);
    this.coverageOf(address).markReady(index);
    for (const run of this.runsOn(address)) {
      run.noteProduced(index);
    }
  }

  /**
   * @param {string} address
   * @param {object} run
   * @param {number} speedX
   */
  noteSpeed(address, wanted, speedX) {
    for (const run of this.runsOn(address)) {
      if (run === wanted) {
        run.noteSpeed(speedX);
      }
    }
    // HOW FAST THIS MACHINE ENCODES THIS OUTPUT is a property of the machine and
    // the material, not of one process. Read off `run.speedX` alone it was lost
    // at every restart: a moved encoder is a new object that has measured
    // nothing, so the plan fell back to "nothing is known" and stopped comparing
    // arrivals at all — which is every decision in this layer.
    if (speedX > 0 && speedX > (this.#lastSpeed.get(address) ?? 0)) {
      this.#lastSpeed.set(address, speedX);
    }
  }

  /**
   * Decide and act, for every output anybody wants anything of and every output
   * that still has an encoder on it.
   *
   * Safe to call as often as anything changes: the plan is a function of the
   * state, so a pass that finds nothing to change does nothing.
   */
  reconcile() {
    const addresses = new Set([...this.demand.addresses(), ...this.#runs.keys()]);
    for (const address of addresses) {
      this.#reconcileOne(address);
    }
    // WHAT THIS CLASS BELIEVES, said by this class. `describe()` was written
    // and called from nowhere, so on 2026-09-05 the question "why did the plan
    // not see the gap the viewer was stopped at" had to be answered by
    // inference from start and stop lines, and was not answered at all.
    //
    // Printed on CHANGE rather than on a timer: a quiet session says nothing, a
    // session that is deciding something says what it decided, and there is no
    // interval to choose.
    const state = this.describe();
    if (state !== this.#lastDescribed) {
      this.#lastDescribed = state;
      this.logger.info(state);
    }
  }

  /**
   * @param {string} address
   */
  #reconcileOne(address) {
    // WHAT EXISTS IS ASKED OF THE DISK, HERE, EVERY TIME. The plan is arithmetic
    // over what is made, what is being made and what is wanted, and the first of
    // those is not this layer's to remember.
    const coverage = this.#upToDateCoverage(address);
    // A run that has ended and said nothing. One built here reports its own
    // ending and is released by `noteEnded`; one ADOPTED from elsewhere — a
    // session whose encoder stopped — has no such promise, and its claim would
    // otherwise sit in the map for the life of the process, telling the plan
    // that a stretch nobody is making is being made. Nothing would ever be
    // started there again.
    for (const run of this.runsOn(address)) {
      if (!run.isAlive && !run.isStopping) {
        this.noteEnded({
          address,
          run,
          ending: ENCODE_EXIT.GONE,
          because: "it is no longer running, and it did not say so"
        });
      }
    }
    // ONE MAP, NOT ONE WINDOW PER VIEWER PER ZONE.
    //
    // Two viewers a few seconds apart state stretches that overlap, and the plan
    // puts one encoder on each stretch it is given — so unmerged windows buy an
    // encoder per viewer for film they both want, which is the opposite of what
    // sharing the output is for. Merged, the highest rank and the soonest time
    // per number win and the stretches do not overlap, so one encoder serves
    // everyone standing in front of it.
    //
    // Asked of the register, which is the thing that holds the windows. This
    // used to reach into the layer that STATES them for the same arithmetic,
    // which is the coupling the layer rule forbids; the arithmetic itself now
    // lives where it belongs to nobody.
    const windows = this.demand.mapOn(address);
    const live = this.runsOn(address).filter((run) => run.isAlive);
    // Asked ONCE. It is arithmetic over measurements, but it also says out loud
    // when the reason it cuts the budget changes, so asking it three times in
    // one pass is three chances to say a thing that happened once.
    const maxRuns = this.#affordableOn(address, live);
    const actions = planEncoders({
      coverage,
      windows,
      // The runs themselves. The plan is arithmetic and reads four numbers off
      // each; what it hands back names the run by BEING it, so nothing has to
      // invent a token to refer to one by.
      runs: live,
      maxRuns,
      segmentSeconds: this.segmentSeconds,
      // What a start and a kill cost, measured from this host's own runs rather
      // than written into the code from one machine's reading. Zero until
      // something has been measured, which is the same convention as the
      // refetch price below and is stated so the bias is known.
      ...this.#costs.seconds(),
      // What a second of film costs to fetch again, in seconds of swarm time.
      // Answered by whoever measures the film's own byte rate and the swarm's;
      // zero until they have, which makes driving through look cheaper than it
      // is and is stated here so the bias is known.
      refetchSecPerFilmSecond: this.refetchSecPerFilmSecond(address),
      // How much slower one encoder runs beside others, read off this host's own
      // startup measurement. A pure function over a measured table: beyond what
      // was measured it holds the largest reading rather than continuing a curve
      // nothing observed.
      contentionPenaltyFor: (others) => contentionPenalty(others, this.contentionPenalties).penalty,
      // The best figure this host has: what a run here is doing now, what one
      // was last measured doing, or what the startup benchmark predicted. The
      // first two are this output's own; the third exists before either.
      speedX: Math.max(
        live.reduce((best, run) => Math.max(best, run.speedX || 0), 0),
        this.#lastSpeed.get(address) ?? 0,
        this.startingSpeedFor(address) || 0
      )
    });

    // A move is the plan taking a running encoder away from where it already
    // stands, which is exactly the decision that was found wandering back and
    // forth in the field on 2026-09-07 with no way to see why: the "because"
    // line names the comparison in words, never the numbers it was decided
    // from. Said here, once per reconcile, and only when a move actually
    // happens — everything a rerun of the same decision needs: the windows
    // this call saw (priority, the real time, which side of the viewers),
    // the budget, and where every live run stood.
    if (actions.some((action) => action.type === "move")) {
      this.logger.info(
        `encode-plan move on ${address}: windows=${JSON.stringify(windows)} ` +
        `maxRuns=${maxRuns} ` +
        `live=${JSON.stringify(live.map((run) => ({ from: run.from, to: run.to, head: run.head, speedX: run.speedX })))}`
      );
    }
    for (const action of actions) {
      if (action.type === "stop") {
        this.#stop(action.run, action.because);
        continue;
      }
      if (action.type === "move") {
        // A running encoder's position cannot be changed — it is fixed when the
        // process starts — so a move is this one ending and another beginning
        // where the material is missing. Both halves are recorded as what they
        // are, which is why the ending of a moved run is not called normal.
        this.#stop(action.run, action.because);
        this.#start(address, action.from, action.to, action.because);
        continue;
      }
      if (action.type === "start") {
        this.#start(address, action.from, action.to, action.because);
        continue;
      }
      // A run that stays keeps its claim current: the free stretch ahead of it
      // may have shrunk since it was given one.
      //
      // THE CLAIM IS THE STRETCH IT WAS GIVEN, and there is one rule for that
      // everywhere. It used to be narrowed here to what the run had already
      // MADE whenever the run had no end, which meant a run claimed the single
      // number it was writing and nothing beyond. The plan then read the road
      // in front of a working encoder as free and started more encoders on it:
      // three processes writing one directory with the same names, field
      // 2026-09-06, and a piece of the film lost for good when the first of
      // them was cleaned up after.
      //
      // The worry that narrowing was written for is real and is answered where
      // it belongs — a viewer opening the same film further in must not find
      // every number taken. That is the plan's business, and the plan can take
      // road away from a run that has no end, because such a run carries no
      // `-to` and simply stops when its head meets somebody else's claim.
      coverage.claim(action.run, action.from, endOfRun({ from: action.from, to: action.to }));
    }

    // NOBODY IS MAKING WHAT SOMEBODY IS WAITING FOR. Said here, with the numbers
    // the decision was taken from, because it is the one state in which a viewer
    // waits for ever and every line above it reads as a healthy proxy.
    //
    // Field 2026-09-07, twice in one evening: the last word about an output was
    // "the film is no worse off without it", and after it nothing — no run, no
    // refusal, no answer to the browser's request for the header. The wait ended
    // at the browser's own timeout with a message naming no cause, and the
    // proxy's log named none either.
    //
    // SAID ONCE PER STATE, not once per pass. A stuck output is reconciled on
    // every event that touches it, and a line repeated for as long as the state
    // lasts is what buried the last one: 49 295 copies of `send queue stuck` in
    // a 159 090-line file, 31 % of the log, all of one wedge.
    const wanting = firstUnmetWant(coverage, windows);
    const stillRunning = this.runsOn(address).filter((run) => run.isAlive);
    if (wanting === null || stillRunning.length > 0) {
      this.#lastUnmet.delete(address);
    } else if (this.#lastUnmet.get(address) !== wanting) {
      this.#lastUnmet.set(address, wanting);
      const held = this.segmentStore ? this.segmentStore.filesHeld(address) : -1;
      this.logger.warn(
        `encode: #${wanting} of ${address} is wanted and NO ENCODER IS MAKING IT — ` +
        `ready=${coverage.stats().ready} of ${coverage.segmentCount} ` +
        `files=${held < 0 ? "?" : held} maxRuns=${maxRuns} ` +
        `windows=${JSON.stringify(windows)}`
      );
    }
  }

  /**
   * @param {string} address
   * @param {number} from
   * @param {number} to
   * @param {string} because
   */
  #start(address, from, to, because) {
    // The encoder is built here and now: whoever builds one waits for nothing,
    // so it exists by the time this line returns. That is what makes the
    // stretch held from this instant — this class knows what it is making
    // because it has just made it, and no second encoder can be started for the
    // same stretch on the next pass.
    //
    // It was not always so. The builder used to answer with nothing and start
    // the encoder behind the answer, so the stretch stayed FREE for as long as
    // that took, and every pass in between started another one: 684 starts in
    // 482 seconds of field 2026-09-05, of which 973 answers said the encoder
    // was not there yet — every start without exception.
    //
    // The run names itself: identity is a property of the thing, and two
    // places minting names is how one stops being unique.
    const run = this.makeRun({ address, from, to });
    if (!run) {
      // A refusal, not a wait: no session serves this output, or this position
      // has failed to start too many times running.
      this.logger.warn(`encode: no encoder could be made for #${from}..#${to} of ${address}`);
      return;
    }
    // What this machine has been measured to do on this output, carried over.
    // A restart does not make the machine slower, and without this every moved
    // encoder began as one whose speed nothing had measured — which the plan
    // reads as "no arrival can be computed" and answers by comparing nothing.
    const known = this.#lastSpeed.get(address) ?? 0;
    if (known > 0) {
      run.noteSpeed(known);
    }
    const onThisOutput = this.#runs.get(address) ?? [];
    onThisOutput.push(run);
    this.#runs.set(address, onThisOutput);
    // This run rewrites the stretch it was given, so what was closed inside that
    // stretch is no longer closed. Without this a number closed by an earlier run
    // stays servable while a later one is halfway through writing it again.
    //
    // Bounded by the run's own end, which is the same number the claim below
    // carries. Unbounded it unproved the whole film beyond the start of any run,
    // and readiness is now a projection of what is proven — so a one-segment run
    // at the beginning would have declared the rest of the output unmade.
    const runsTo = endOfRun({ from, to });
    this.segmentStore?.forgetClosed(address, from, runsTo);
    this.coverageOf(address).claim(run, from, runsTo);
    run.start(because);
  }

  /**
   * How many encoders may run on this output, from every limit at once.
   *
   * The processor is one of them and is answered from outside, where the
   * machine is measured. The other two are known here: what the swarm delivers,
   * through the seconds of swarm time a second of film costs, and — once it is
   * supplied — the memory the piece store may hold against what one encoder's
   * reader keeps.
   *
   * Said out loud when it is not the processor that decided, because "why is
   * there only one encoder" is otherwise a question no log can answer.
   *
   * @param {string} address
   * @param {{ speedX: number }[]} live
   * @returns {number}
   */
  #affordableOn(address, live) {
    const byProcessor = Math.max(0, this.maxRunsFor(address));
    // The best figure this host has: what a run here is doing now, what one was
    // last measured doing, or what the startup benchmark predicted. The first
    // two are this output's own; the third exists before either, so the budget
    // is never asked to price encoders at a speed of zero.
    const fastest = Math.max(
      live.reduce((best, run) => Math.max(best, run.speedX || 0), 0),
      this.#lastSpeed.get(address) ?? 0,
      this.startingSpeedFor(address) || 0
    );
    const budget = affordableRuns({
      byProcessor,
      speedX: fastest,
      refetchSecPerFilmSecond: this.refetchSecPerFilmSecond(address),
      // How much slower one encoder runs beside others, read off this host's own
      // startup measurement. A pure function over a measured table: beyond what
      // was measured it holds the largest reading rather than continuing a curve
      // nothing observed.
      contentionPenaltyFor: (others) => contentionPenalty(others, this.contentionPenalties).penalty
    });
    if (budget.runs !== byProcessor && budget.because !== this.#lastBudgetReason.get(address)) {
      this.#lastBudgetReason.set(address, budget.because);
      this.logger.info(
        `encode: ${budget.runs} encoder(s) on ${address.slice(0, 60)} — ${budget.because} ` +
        `(the processor alone would allow ${byProcessor})`
      );
    }
    return budget.runs;
  }

  /**
   * Take charge of a run this class did not start.
   *
   * The browser asks for a stream and a run begins for it, long before this
   * class has an opinion. Left unknown, that run would be invisible to the plan
   * — which would then start a second encoder over the same numbers, believing
   * nothing was being made there. So whoever starts one hands it over, and from
   * then on it is planned like any other.
   *
   * @param {string} address
   * @param {{ id: string, from: number, to: number, head: number, speedX: number, isAlive: boolean, stop: (because: string) => void }} run
   */
  adopt(address, run) {
    if (!run) {
      return;
    }
    const onThisOutput = this.#runs.get(address) ?? [];
    if (onThisOutput.includes(run)) {
      return;
    }
    onThisOutput.push(run);
    this.#runs.set(address, onThisOutput);
    this.coverageOf(address).claim(run, run.from, endOfRun(run));
  }

  /**
   * @param {object} run
   * @param {string} because
   */
  #stop(run, because) {
    run.stop(because);
  }

  /**
   * A run has ended, however it ended. Its stretch goes back to the map — what
   * it finished stays made — and the ending is counted.
   *
   * Wired by whoever builds the run, so that a run built outside this class is
   * still accounted for.
   *
   * @param {import("../encode/EncodeRun.js").RunEnded} ended
   */
  noteEnded(ended) {
    this.#costs.note(ended);
    // Exactly one ending is normal — the run reached the end of the stretch it
    // was given and closed its last file. Every other leaves a piece open, and
    // that file looks finished however the run ended: stopped, ffmpeg writes it
    // out and names it like any other; killed harder, it leaves the bytes it
    // had. Either way it decodes and holds less film than its number promises.
    // So what is kept is what the run PROVED it finished, and nothing beyond.
    if (ended.ending !== ENCODE_EXIT.COMPLETE && this.segmentStore) {
      void this.segmentStore
        .discardOpenPieceOf(ended.address, { from: ended.from, to: ended.to }, null, ended.provenName)
        .catch(() => {});
    }
    this.coverageOf(ended.address).release(ended.run);
    const remaining = this.runsOn(ended.address).filter((run) => run !== ended.run);
    if (remaining.length === 0) {
      this.#runs.delete(ended.address);
    } else {
      this.#runs.set(ended.address, remaining);
    }
    this.#endings.set(ended.ending, (this.#endings.get(ended.ending) ?? 0) + 1);
  }

  /**
   * How runs have ended over the life of this process, by cause.
   *
   * The abnormal classes are meant to stand at zero. Without the count,
   * "we understand why it ended" is indistinguishable from "we noticed it once".
   *
   * @returns {Record<string, number>}
   */
  endings() {
    /** @type {Record<string, number>} */
    const tally = {};
    for (const ending of Object.values(ENCODE_EXIT)) {
      tally[ending] = this.#endings.get(ending) ?? 0;
    }
    return tally;
  }

  /**
   * One line saying what this proxy is encoding and whether anybody is waiting.
   *
   * `waiting` is the point of it: a proxy with encoders running and a viewer
   * still stopped at a segment nobody is making is the failure this layer was
   * built to remove, and it is visible here rather than inferred from a log.
   *
   * @returns {string}
   */
  describe() {
    const parts = [];
    for (const address of new Set([...this.demand.addresses(), ...this.#runs.keys()])) {
      const coverage = this.coverageOf(address);
      const stated = this.demand.mapOn(address);
      const windows = stated.map((zone) => ({ from: zone.from, to: zone.to }));
      const waiting = firstUnmetWant(coverage, windows);
      const runs = this.runsOn(address)
        .map((run) => `#${run.head}..#${run.to}@${run.speedX.toFixed(1)}x`)
        .join(" ");
      // The zones as they were stated, with their order, so a plan that is
      // working at the wrong end of the film is visible rather than inferred.
      const zones = [...stated]
        .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0) || left.from - right.from)
        .map((w) => `p${w.priority ?? 0}:#${w.from}..#${w.to}`)
        .join(" ");
      // THE WHOLE ADDRESS. Cut to sixty characters, every output of one film
      // printed the same string — the picture, its quality steps and each
      // soundtrack are told apart only by the tail — so three lines of this
      // could not be matched to the three things they describe. Read on
      // 2026-09-07 while accounting for a session that produced nothing, and
      // the accounting had to be done by which line carried a run.
      //
      // And WHAT THE DISK HOLDS beside what is proven closed. They are two
      // different statements: files with nothing proving them closed reads as a
      // reporting fault, no files at all reads as an output yet to be made, and
      // the difference decides where to look.
      const held = this.segmentStore ? this.segmentStore.filesHeld(address) : -1;
      parts.push(
        `${address} ready=${coverage.stats().ready}` +
        `${held < 0 ? "" : ` of ${held} file(s) on disk`} ` +
        `zones=[${zones}] runs=[${runs}] ` +
        `waiting=${waiting === null ? "nobody" : `#${waiting}`}`
      );
    }
    const tally = this.endings();
    const endings = Object.entries(tally)
      .map(([cause, count]) => `${cause}=${count}`)
      .join(" ");
    return `encode: ${parts.length === 0 ? "nothing wanted" : parts.join(" | ")} :: endings ${endings}`;
  }
}
