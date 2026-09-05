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
import { RunCosts } from "../encode/run-costs.js";
import { SegmentDemand } from "../encode/SegmentDemand.js";

export class EncodeOrchestrator {
  /** Output address to what has been made of it. @type {Map<string, CoverageMap>} */
  #coverage = new Map();

  /** Output address to the runs on it. @type {Map<string, import("../encode/EncodeRun.js").EncodeRun[]>} */
  #runs = new Map();


  /** How runs have ended, by cause. @type {Map<string, number>} */
  #endings = new Map();

  /** The last state said out loud, so an unchanged state is not repeated. */
  #lastDescribed = "";

  /** What a stop and a start have cost on this host. */
  #costs = new RunCosts();

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
   * @param {number} params.restartCostSec - Measured: 0.12 s on the addon host.
   * @param {{ info: (line: string) => void, warn: (line: string) => void }} params.logger
   * @param {() => number} [params.now]
   */
  constructor({
    maxRunsFor,
    makeRun,
    segmentSeconds,
    restartCostSec,
    refetchSecPerFilmSecond = () => 0,
    segmentStore = null,
    lookaheadSegments = 0,
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
    this.makeRun = makeRun;
    this.segmentSeconds = segmentSeconds;
    this.restartCostSec = restartCostSec;
    // How far in front of its viewer a run is allowed to get. It is what bounds
    // the claim of a run that was given no end — see #claimFor.
    this.lookaheadSegments = Number.isFinite(lookaheadSegments) && lookaheadSegments > 0
      ? Math.ceil(lookaheadSegments)
      : 0;
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
    this.coverageOf(address).markReadyAll(indexes);
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
  want({ claimant, address, from, to, priority = 0 }) {
    this.demand.state({ claimant, address, from, to, priority, statedAt: this.now() });
  }

  /**
   * A viewer has gone.
   *
   * @param {string} claimant
   */
  release(claimant) {
    this.demand.forget(claimant);
  }

  /**
   * A segment has been finished, by whichever run made it.
   *
   * @param {string} address
   * @param {number} index
   */
  noteProduced(address, index) {
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
    const coverage = this.coverageOf(address);
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
    // Carrying the priority through, because the filling takes the work in that
    // order: what a viewer must have before they set off comes before what is
    // merely in front of them, which comes before the rest of the track. Passed
    // as a plain number so the plan stays arithmetic.
    const windows = this.demand.windowsOn(address).map((window) => ({
      from: window.from,
      to: window.to,
      priority: Number(window.priority) || 0
    }));
    const live = this.runsOn(address).filter((run) => run.isAlive);
    const actions = planEncoders({
      coverage,
      windows,
      // The runs themselves. The plan is arithmetic and reads four numbers off
      // each; what it hands back names the run by BEING it, so nothing has to
      // invent a token to refer to one by.
      runs: live,
      maxRuns: Math.max(0, this.maxRunsFor(address)),
      segmentSeconds: this.segmentSeconds,
      restartCostSec: this.restartCostSec,
      // Measured from this host's own runs, rather than written into the code
      // from one machine's reading.
      ...this.#costs.seconds(),
      // What a second of film costs to fetch again, in seconds of swarm time.
      // Answered by whoever measures the film's own byte rate and the swarm's;
      // zero until they have, which makes driving through look cheaper than it
      // is and is stated here so the bias is known.
      refetchSecPerFilmSecond: this.refetchSecPerFilmSecond(address)
    });

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
      this.#claimFor(coverage, action.run, action.from, action.to);
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
    const onThisOutput = this.#runs.get(address) ?? [];
    onThisOutput.push(run);
    this.#runs.set(address, onThisOutput);
    this.coverageOf(address).claim(run, from, endOfRun({ from, to }));
    run.start(because);
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
    this.#claimFor(this.coverageOf(address), run, run.from, run.to);
  }

  /**
   * What a run holds, as far as the map is concerned.
   *
   * A run given an end holds exactly that stretch. A run given NO end — `to`
   * below `from`, which is how this is written everywhere here — would hold the
   * rest of the film, and that is what must not be claimed: a second viewer
   * opening the same film further in would find every number taken and get no
   * encoder at all, waiting instead for the first run to encode its way there,
   * which on a long film is an hour.
   *
   * What bounds it in practice is the look-ahead: a run is suspended once it is
   * that far in front of the segment its viewer last asked for, and past that it
   * produces nothing until somebody asks. So that is the honest extent of the
   * claim, and it is a measured figure rather than a chosen one — the same
   * allowance the browser sizes its cushion from. `planRunInterval` has applied
   * this rule since runs got intervals; this path did not, which is how an
   * encoder came to be started and killed every five seconds in the field.
   *
   * @param {CoverageMap} coverage
   * @param {object} run
   * @param {number} from
   * @param {number} to
   */
  #claimFor(coverage, run, from, to) {
    const end = endOfRun({ from, to });
    if (Number.isFinite(end)) {
      coverage.claim(run, from, end);
      return;
    }
    const head = Number.isFinite(run?.head) ? run.head : from;
    coverage.claim(run, from, Math.max(from, head + this.lookaheadSegments));
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
    // that file's name is indistinguishable from a finished one's.
    if (ended.ending !== ENCODE_EXIT.COMPLETE && this.segmentStore) {
      void this.segmentStore
        .discardOpenPieceOf(ended.address, { from: ended.from, to: ended.to })
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
      const stated = this.demand.windowsOn(address);
      const windows = stated.map((w) => ({ from: w.from, to: w.to }));
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
      parts.push(
        `${address.slice(0, 60)} ready=${coverage.stats().ready} ` +
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
