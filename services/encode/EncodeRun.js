/**
 * @file One running encoder: the stretch it was given, where it has got to, and
 * how it ended.
 *
 * Until now a run was a handful of fields on a session — the process, the run
 * state, the directory, the start index, the generation counter, the progress —
 * and there could be exactly one of them, because there was nowhere to put a
 * second. It is an object here so that an output can have as many as the
 * machine affords, and so that a run belongs to a STRETCH of an output rather
 * than to a viewer.
 *
 * **A run has an end.** Neither `-to` nor `-t` appeared anywhere in the
 * arguments this proxy built, so every run went until something killed it from
 * outside. Given an end it finishes by itself, and two runs on one output
 * cannot write over each other because their stretches do not overlap.
 *
 * **Every start and every end is recorded, with its cause** (required by the
 * user 2026-09-04, because abnormal endings are frequent here). Exactly one
 * ending is normal: the run reached the end of the stretch it was given and
 * exited by itself. Every other ending, our own kill included, is abnormal and
 * says so — with the code, the signal, how far it got, how long it lived, and
 * what was cleared up after it.
 *
 * **Nothing here decides anything.** Where a run belongs, whether it should be
 * moved and whether it should exist at all are `EncodePlan`'s, from numbers.
 * This carries a decision out and reports what happened.
 */

import { ENCODE_RUN_EVENT, ENCODE_RUN_STATE, INITIAL_RUN_STATE, nextState } from "./encode-run-state.js";

/**
 * Why a run ended.
 *
 * @readonly
 */
export const RUN_ENDING = Object.freeze({
  /** It reached the end of its stretch and exited by itself. The only normal one. */
  COMPLETED: "completed",
  /** We stopped it on purpose — moved, no longer wanted, the output was dropped. */
  STOPPED: "stopped",
  /** It exited by itself before the end of its stretch. */
  SHORT: "short",
  /** It exited non-zero, or a signal we did not send took it. */
  FAILED: "failed",
  /**
   * It was found to be over without having said so.
   *
   * Only an ADOPTED run can end this way: one built here reports its own
   * ending, while a run handed over from elsewhere — a session whose encoder
   * stopped — makes no such promise. Counted apart from the rest precisely
   * because it means nobody watched it end, and a class that is meant to stand
   * at zero has to be told apart from one that is meant to happen.
   */
  GONE: "gone"
});

/**
 * @typedef {object} RunEnded
 * @property {string} runId
 * @property {string} address
 * @property {string} ending - One of {@link RUN_ENDING}.
 * @property {string} because - Why, in words, including who asked when we did.
 * @property {number | null} code
 * @property {string | null} signal
 * @property {number} from
 * @property {number} to
 * @property {number} reached - The last number it finished, or `from - 1` when
 *   it finished none.
 * @property {number} livedMs
 * @property {boolean} normal - Whether this ending is the expected one.
 */

export class EncodeRun {
  /** @type {import("node:child_process").ChildProcess | null} */
  #process = null;

  /** @type {string} */
  #state = INITIAL_RUN_STATE;

  /** Numbers this run has finished. @type {Set<number>} */
  #produced = new Set();

  /** @type {number} */
  #startedAt = 0;

  /** @type {number} */
  #speedX = 0;

  /** @type {boolean} */
  #stopping = false;

  /** @type {string} */
  #stopReason = "";

  /**
   * @param {object} params
   * @param {string} params.id
   * @param {string} params.address - The output this run makes segments of.
   * @param {import("./Encoder.js").Encoder} params.encoder
   * @param {number} params.from - First segment number it is to make.
   * @param {number} params.to - Last segment number it is to make, inclusive.
   * @param {string} params.dirPath - Where it writes.
   * @param {() => string[]} params.buildArgs - The full argument list for this
   *   run. Supplied rather than built here: what to map, where to read from and
   *   how to cut belong to whoever knows the source, and this owns the process.
   * @param {(args: string[]) => import("node:child_process").ChildProcess} params.spawn
   * @param {{ info: (line: string) => void, warn: (line: string) => void }} params.logger
   * @param {() => number} [params.now]
   * @param {(ended: RunEnded) => void} [params.onEnded]
   */
  constructor({ id, address, encoder, from, to, dirPath, buildArgs, spawn, logger, now, onEnded }) {
    this.id = id;
    this.address = address;
    this.encoder = encoder;
    this.from = from;
    this.to = to;
    this.dirPath = dirPath;
    this.buildArgs = buildArgs;
    this.spawnProcess = spawn;
    this.logger = logger;
    this.now = typeof now === "function" ? now : Date.now;
    this.onEnded = typeof onEnded === "function" ? onEnded : () => {};
  }

  /** @returns {string} */
  get state() {
    return this.#state;
  }

  /** @returns {number} */
  get speedX() {
    return this.#speedX;
  }

  /**
   * The next number this run will produce.
   *
   * Its position, and the figure the plan compares against what is already
   * covered. Before it has finished anything that is where it started.
   *
   * @returns {number}
   */
  get head() {
    let head = this.from;
    while (this.#produced.has(head)) {
      head += 1;
    }
    return head;
  }

  /**
   * The last number it finished, or one before its start when it finished none.
   *
   * @returns {number}
   */
  get reached() {
    return this.head - 1;
  }

  /** @returns {number[]} */
  get produced() {
    return [...this.#produced].sort((left, right) => left - right);
  }

  /** @returns {boolean} */
  get isAlive() {
    return this.#process !== null && this.#state !== ENCODE_RUN_STATE.ENDED_FAILED;
  }

  /**
   * Start it, and say why it is being started.
   *
   * The reason is not decoration: a start whose cause is not recorded cannot be
   * told from any other start when several runs exist at once, and the argument
   * list alone does not say whether this was a first open, a viewer's seek, a
   * quality step or a move off covered material.
   *
   * @param {string} because
   */
  start(because) {
    const args = this.buildArgs();
    this.#startedAt = this.now();
    this.logger.info(
      `encode-run ${this.id} start #${this.from}..#${this.to} of ${this.address} ` +
      `by ${this.encoder.name}: ${because} :: ffmpeg ${args.join(" ")}`
    );
    this.#process = this.spawnProcess(args);
    this.#transition(ENCODE_RUN_EVENT.SPAWNED);
    this.#process.on("exit", (code, signal) => this.#onExit(code, signal));
    this.#process.on("error", (error) => {
      this.logger.warn(`encode-run ${this.id} could not be started: ${error?.message ?? error}`);
      this.#finish(RUN_ENDING.FAILED, `the process could not be started: ${error?.message ?? error}`, null, null);
    });
  }

  /**
   * A segment this run has finished.
   *
   * @param {number} index
   */
  noteProduced(index) {
    if (Number.isInteger(index) && index >= this.from) {
      this.#produced.add(index);
    }
  }

  /**
   * What ffmpeg says about its own speed.
   *
   * @param {number} speedX - Times realtime.
   */
  noteSpeed(speedX) {
    if (Number.isFinite(speedX) && speedX > 0) {
      this.#speedX = speedX;
    }
  }

  /**
   * Stop it on purpose. Abnormal by the rule above, and recorded as such: our
   * own kill is a thing that happened to a run before it finished, and hiding
   * it among the normal endings would make the count of abnormal endings
   * useless.
   *
   * @param {string} because
   */
  stop(because) {
    if (this.#process === null) {
      return;
    }
    this.#stopping = true;
    this.#stopReason = because;
    this.#transition(ENCODE_RUN_EVENT.STOP_ORDERED);
    this.#process.kill("SIGTERM");
  }

  /**
   * @param {number | null} code
   * @param {string | null} signal
   */
  #onExit(code, signal) {
    if (this.#stopping) {
      this.#finish(RUN_ENDING.STOPPED, this.#stopReason, code, signal);
      return;
    }
    if (code === 0 && this.reached >= this.to) {
      this.#finish(RUN_ENDING.COMPLETED, "it reached the end of its stretch", code, signal);
      return;
    }
    if (code === 0) {
      // ffmpeg exits zero both at the end of a file and when its input simply
      // stops producing bytes; over a torrent the two look identical to it. A
      // run that stopped short of its stretch has not finished it.
      this.#finish(
        RUN_ENDING.SHORT,
        `it exited cleanly at #${this.reached} of #${this.to} — its input stopped`,
        code,
        signal
      );
      return;
    }
    this.#finish(RUN_ENDING.FAILED, `it exited with code ${code ?? "?"}`, code, signal);
  }

  /**
   * @param {string} ending
   * @param {string} because
   * @param {number | null} code
   * @param {string | null} signal
   */
  #finish(ending, because, code, signal) {
    if (this.#process === null && this.#state === ENCODE_RUN_STATE.STOPPED) {
      return;
    }
    this.#process = null;
    // A run we stopped is already in STOPPED, ordered before the signal was
    // sent; its exit is the answer to that order and not a second event.
    if (ending !== RUN_ENDING.STOPPED) {
      this.#transition(
        ending === RUN_ENDING.COMPLETED
          ? ENCODE_RUN_EVENT.EXITED_COMPLETE
          : ending === RUN_ENDING.SHORT
            ? ENCODE_RUN_EVENT.EXITED_SHORT
            : ENCODE_RUN_EVENT.EXITED_FAILED
      );
    }
    const livedMs = this.#startedAt > 0 ? this.now() - this.#startedAt : 0;
    /** @type {RunEnded} */
    const ended = {
      runId: this.id,
      address: this.address,
      ending,
      because,
      code: code ?? null,
      signal: signal ?? null,
      from: this.from,
      to: this.to,
      reached: this.reached,
      livedMs,
      normal: ending === RUN_ENDING.COMPLETED
    };
    const line =
      `encode-run ${this.id} ${ending} #${this.from}..#${this.to} of ${this.address}, ` +
      `reached #${ended.reached} (${this.#produced.size} segment(s)) after ${livedMs}ms` +
      `${code === null ? "" : `, code ${code}`}${signal ? `, signal ${signal}` : ""}: ${because}`;
    if (ended.normal) {
      this.logger.info(line);
    } else {
      this.logger.warn(line);
    }
    this.onEnded(ended);
  }

  /**
   * @param {string} event
   */
  #transition(event) {
    const to = nextState(this.#state, event);
    if (to !== null && to !== this.#state) {
      this.#state = to;
    }
  }
}
