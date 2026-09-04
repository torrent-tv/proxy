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
import { RUN_ENDING } from "../encode/EncodeRun.js";
import { SegmentDemand } from "../encode/SegmentDemand.js";

export class EncodeOrchestrator {
  /** Output address to what has been made of it. @type {Map<string, CoverageMap>} */
  #coverage = new Map();

  /** Output address to the runs on it. @type {Map<string, import("../encode/EncodeRun.js").EncodeRun[]>} */
  #runs = new Map();

  /** How runs have ended, by cause. @type {Map<string, number>} */
  #endings = new Map();

  /** @type {number} */
  #runSerial = 0;

  /**
   * @param {object} params
   * @param {(address: string) => number} params.maxRunsFor - How many encoders
   *   this machine can afford on one output. The same arithmetic that decides
   *   the quality offer; measured per host, never chosen here.
   * @param {(params: { address: string, runId: string, from: number, to: number }) =>
   *   import("../encode/EncodeRun.js").EncodeRun} params.makeRun - Build a run
   *   for a stretch. What to read, what to map and how to cut belong to whoever
   *   knows the source.
   * @param {number} params.segmentSeconds
   * @param {number} params.restartCostSec - Measured: 0.12 s on the addon host.
   * @param {{ info: (line: string) => void, warn: (line: string) => void }} params.logger
   * @param {() => number} [params.now]
   */
  constructor({ maxRunsFor, makeRun, segmentSeconds, restartCostSec, logger, now }) {
    this.demand = new SegmentDemand();
    this.maxRunsFor = maxRunsFor;
    this.makeRun = makeRun;
    this.segmentSeconds = segmentSeconds;
    this.restartCostSec = restartCostSec;
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
   */
  want({ claimant, address, from, to }) {
    this.demand.state({ claimant, address, from, to, statedAt: this.now() });
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
   * @param {string} runId
   * @param {number} speedX
   */
  noteSpeed(address, runId, speedX) {
    for (const run of this.runsOn(address)) {
      if (run.id === runId) {
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
      if (!run.isAlive) {
        this.noteEnded({
          address,
          runId: run.id,
          ending: RUN_ENDING.GONE,
          because: "it is no longer running, and it did not say so"
        });
      }
    }
    const windows = this.demand.windowsOn(address).map((window) => ({
      from: window.from,
      to: window.to
    }));
    const live = this.runsOn(address).filter((run) => run.isAlive);
    const actions = planEncoders({
      coverage,
      windows,
      runs: live.map((run) => ({
        id: run.id,
        from: run.from,
        to: run.to,
        head: run.head,
        speedX: run.speedX
      })),
      maxRuns: Math.max(0, this.maxRunsFor(address)),
      segmentSeconds: this.segmentSeconds,
      restartCostSec: this.restartCostSec
    });

    for (const action of actions) {
      if (action.type === "stop") {
        this.#stop(address, action.runId, action.because);
        continue;
      }
      if (action.type === "move") {
        // A running encoder's position cannot be changed — it is fixed when the
        // process starts — so a move is this one ending and another beginning
        // where the material is missing. Both halves are recorded as what they
        // are, which is why the ending of a moved run is not called normal.
        this.#stop(address, action.runId, action.because);
        this.#start(address, action.from, action.to, action.because);
        continue;
      }
      if (action.type === "start") {
        this.#start(address, action.from, action.to, action.because);
        continue;
      }
      // A run that stays keeps its claim current: the free stretch ahead of it
      // may have shrunk since it was given one.
      coverage.claim(action.runId, action.from, action.to);
    }
  }

  /**
   * @param {string} address
   * @param {number} from
   * @param {number} to
   * @param {string} because
   */
  #start(address, from, to, because) {
    this.#runSerial += 1;
    const runId = `${this.#runSerial}`;
    const run = this.makeRun({ address, runId, from, to });
    if (!run) {
      // Not necessarily a failure: making an encoder can take a probe and a
      // keyframe read, and this call is arithmetic that must not wait on
      // either. Whoever builds one answers with nothing while it is on its way,
      // and the next pass sees it.
      this.logger.info(`encode: an encoder for #${from}..#${to} of ${address} is not there yet`);
      return;
    }
    const onThisOutput = this.#runs.get(address) ?? [];
    onThisOutput.push(run);
    this.#runs.set(address, onThisOutput);
    this.coverageOf(address).claim(run.id, from, to);
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
    if (!run || typeof run.id !== "string") {
      return;
    }
    const onThisOutput = this.#runs.get(address) ?? [];
    if (onThisOutput.some((known) => known.id === run.id)) {
      return;
    }
    onThisOutput.push(run);
    this.#runs.set(address, onThisOutput);
    this.coverageOf(address).claim(run.id, run.from, run.to);
  }

  /**
   * @param {string} address
   * @param {string} runId
   * @param {string} because
   */
  #stop(address, runId, because) {
    for (const run of this.runsOn(address)) {
      if (run.id === runId) {
        run.stop(because);
      }
    }
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
    this.coverageOf(ended.address).release(ended.runId);
    const remaining = this.runsOn(ended.address).filter((run) => run.id !== ended.runId);
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
    for (const ending of Object.values(RUN_ENDING)) {
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
      const windows = this.demand.windowsOn(address).map((w) => ({ from: w.from, to: w.to }));
      const waiting = firstUnmetWant(coverage, windows);
      const runs = this.runsOn(address)
        .map((run) => `${run.id}:#${run.head}..#${run.to}@${run.speedX.toFixed(1)}x`)
        .join(" ");
      parts.push(
        `${address.slice(0, 60)} ready=${coverage.stats().ready} ` +
        `viewers=${windows.length} runs=[${runs}] ` +
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
