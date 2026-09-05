/**
 * @file One running encoder: its process, the stretch it was given, where it
 * has got to, and how it ended.
 *
 * Until now a run was ten fields on a session — the process, the run state, the
 * directory, the start and end numbers, a generation counter, the superseded
 * processes, the run number, its label, its argument list — and there could be
 * exactly one of them, because there was nowhere to put a second. It is an
 * object here so that an output can have as many as the machine affords, and so
 * that a run belongs to a STRETCH of an output rather than to a viewer.
 *
 * **The identity check disappears with the fields.** Every handler used to open
 * with "is this still the session's process", because a replaced run's exit
 * would otherwise write the session's error, its state and its failure tally —
 * one set of fields for however many processes had lived. A run writes its own
 * state and nothing else's, so a predecessor dying after its replacement has
 * spawned can no longer be mistaken for the current run failing. That mistake
 * cost a hardware encoder: on any host with one, every seek downgraded the
 * proxy to libx264 for good.
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
 * What to do about an ending — fall back to software, wait for the input to
 * come back, stop retrying a position that keeps failing — belongs to whoever
 * owns the output. This carries a decision out and reports what happened.
 */

import { ENCODE_RUN_EVENT, ENCODE_RUN_STATE, INITIAL_RUN_STATE, nextState } from "./encode-run-state.js";
import { classifyEncodeExit, ENCODE_EXIT } from "./encode-exit.js";

/** Microseconds in a second, as ffmpeg's `out_time_ms` counts them. */
const MICROSECONDS_PER_SECOND = 1_000_000;


/**
 * @typedef {object} RunEnded
 * @property {EncodeRun} run - The run itself. It has no name: what identifies
 *   it is that it IS itself, and what identifies it in a line is its output and
 *   the stretch it was given, which no other live run of that output holds.
 * @property {string} address
 * @property {string} ending - One of {@link ENCODE_EXIT}.
 * @property {string} because - Why, in words, including who asked when we did.
 * @property {number | null} code
 * @property {string | null} signal
 * @property {number} from
 * @property {number} to
 * @property {number} reached - The last number it finished, or `from - 1` when
 *   it finished none.
 * @property {number} livedMs
 * @property {boolean} normal - Whether this ending is the expected one.
 * @property {string} lastError - The last thing ffmpeg said on stderr.
 */

/**
 * The last number this run was given, or Infinity when it was given no end.
 *
 * ONE reading of one convention. "No end" is written as a `to` below `from` —
 * the session layer returns -1 for it and the log prints `#-1` — and every place
 * that has to compare against it read that for itself. One place did not: the
 * coverage map was handed the raw -1, `Math.max(from, -1)` made the claim one
 * segment long, and the plan then saw the rest of the film as free. Field,
 * 2026-09-05: an encoder was started and killed every five seconds, each one
 * producing 0-2 segments, for as long as anybody watched.
 *
 * @param {{ from: number, to: number }} run
 * @returns {number}
 */
export function endOfRun(run) {
  const from = Number(run?.from);
  const to = Number(run?.to);
  return Number.isInteger(to) && to >= from ? to : Number.POSITIVE_INFINITY;
}

export class EncodeRun {
  /** @type {import("node:child_process").ChildProcess | null} */
  #process = null;

  /** @type {string} */
  #state = INITIAL_RUN_STATE;

  /** Numbers this run has finished. @type {Set<number>} */
  #produced = new Set();

  /** @type {number} */
  #startedAt = 0;

  /** Half a name left over from the last chunk of the encoder's own channel. */
  #closedTail = "";

  /**
   * When this run was told to stop, so the death itself can be priced.
   *
   * The plan weighs moving an encoder against letting it drive on, and dying is
   * one of the terms. It was measured in the field at 430-729 ms — larger than
   * the start it is added to — by a log line that lived in the one place that
   * killed a run. That place is gone, so the run times its own death.
   */
  #stopOrderedAt = 0;

  /**
   * When the first thing this run ever produced appeared.
   *
   * The other term the plan needs: a run started where nothing is downloaded
   * waits for the swarm before it can encode a frame, and that wait is the
   * largest part of what a restart costs. Nothing measured it before.
   */
  #firstOutputAt = 0;

  /** @type {number} */
  #speedX = 0;

  /** @type {boolean} */
  #stopping = false;

  /** @type {string} */
  #stopReason = "";

  /** @type {boolean} */
  #ended = false;

  /**
   * Whether this platform refuses to suspend a process.
   *
   * Asked once and remembered: `SIGSTOP` does not exist on Windows, and asking
   * again every look-ahead pass would log the same refusal for the life of the
   * run.
   * @type {boolean}
   */
  #pauseUnsupported = false;

  /**
   * @param {object} params
   * @param {string} params.address - The output this run makes segments of.
   * @param {import("./Encoder.js").Encoder} params.encoder
   * @param {number} params.from - First segment number it is to make.
   * @param {number} params.to - Last segment number it is to make, inclusive;
   *   below `from` means it was given no end.
   * @param {() => string[]} params.buildArgs - The full argument list for this
   *   run. Supplied rather than built here: what to map, where to read from and
   *   how to cut belong to whoever knows the source, and this owns the process.
   * @param {(args: string[]) => import("node:child_process").ChildProcess} params.spawn
   * @param {{ info: (line: string) => void, warn: (line: string) => void, error?: (line: string) => void }} params.logger
   * @param {() => number} [params.now]
   * @param {(ended: RunEnded) => void} [params.onEnded]
   * @param {(name: string) => void} [params.onClosed] - Called with the file name
   *   of every piece the encoder has FINISHED writing, as the encoder itself
   *   names it on its own channel.
   * @param {(progress: { processedSeconds: number | null, speed: string | null }) => void} [params.onProgress]
   *   Called for every `-progress` report. Seconds count from the START OF THIS
   *   RUN on both branches — neither `-output_ts_offset` nor `-copyts` changes
   *   what `-progress` reports, both measured — so rebasing them onto the
   *   source's timeline is the caller's, which is the only side that knows
   *   where this run began.
   * @param {() => number | null} [params.lastSegmentIndex] - The film's last
   *   segment number, for telling "reached the end" from "the input dried up".
   *   ffmpeg exits zero for both, and over a torrent it cannot tell them apart.
   * @param {(message: string) => boolean} [params.inputUnavailable] - Whether
   *   ffmpeg's own message names a missing input rather than a bad encode.
   * @param {string} [params.argsDescribed] - The command as one readable line,
   *   kept so a failure can quote what produced it.
   * @param {boolean} [params.usesExplicitCuts] - Whether this run cuts at times
   *   it was given, which decides how a segment is judged finished.
   */
  constructor({
    address,
    encoder,
    from,
    to,
    buildArgs,
    spawn,
    logger,
    now,
    onEnded,
    onClosed,
    onProgress,
    lastSegmentIndex,
    inputUnavailable,
    argsDescribed = "",
    usesExplicitCuts = false
  }) {
    this.address = address;
    this.encoder = encoder;
    this.from = from;
    this.to = to;
    this.buildArgs = buildArgs;
    this.spawnProcess = spawn;
    this.logger = logger;
    this.now = typeof now === "function" ? now : Date.now;
    this.onEnded = typeof onEnded === "function" ? onEnded : () => {};
    this.onProgress = typeof onProgress === "function" ? onProgress : () => {};
    // Told the NAME of every piece the encoder has closed. The name is the
    // proof it is whole; nothing else here can prove that.
    this.onClosed = typeof onClosed === "function" ? onClosed : () => {};
    this.lastSegmentIndex = typeof lastSegmentIndex === "function" ? lastSegmentIndex : () => null;
    this.inputUnavailable = typeof inputUnavailable === "function" ? inputUnavailable : () => false;
    this.argsDescribed = argsDescribed;
    this.usesExplicitCuts = usesExplicitCuts === true;
    /** The last thing ffmpeg said on stderr, which is what a failure is explained by. */
    this.lastError = "";
  }

  /** @returns {string} */
  get state() {
    return this.#state;
  }

  /** @returns {number} */
  get speedX() {
    return this.#speedX;
  }

  /** @returns {number} When it was spawned, or 0 before that. */
  get startedAt() {
    return this.#startedAt;
  }

  /**
   * The process itself, for the two things only a handle can answer: whether it
   * has exited, and its pid. Nothing outside may kill it — that is `stop`, which
   * records the cause.
   *
   * @returns {import("node:child_process").ChildProcess | null}
   */
  get process() {
    return this.#process;
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

  /**
   * Whether this run can still produce.
   *
   * A run told to stop cannot, whatever its process is still doing about the
   * signal: the exit arrives a turn or two later, and until then everything
   * asking "is anything encoding" would be answered yes by a run that is on its
   * way out — and a caller deciding whether to start one would decide not to.
   *
   * @returns {boolean}
   */
  get isAlive() {
    return this.#process !== null && !this.#ended && !this.#stopping;
  }

  /**
   * Whether it has been told to stop and its exit has not arrived yet.
   *
   * Asked by whoever sweeps for runs that ended without saying so: this one is
   * going to say so.
   *
   * @returns {boolean}
   */
  get isStopping() {
    return this.#stopping && !this.#ended;
  }

  /** @returns {boolean} Whether it is stopped where it stands, producing nothing. */
  get isSuspended() {
    return this.#state === ENCODE_RUN_STATE.SUSPENDED;
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
      `encode-run #${this.from}..#${this.to} of ${this.address} ` +
      `by ${this.encoder?.name ?? "?"}: ${because} ` +
      `:: ffmpeg ${this.argsDescribed || args.join(" ")}`
    );
    this.#process = this.spawnProcess(args);
    this.#transition(ENCODE_RUN_EVENT.SPAWNED);
    this.#wire(this.#process);
  }

  /**
   * Everything the process says about itself: how far it has got, how fast, and
   * what went wrong.
   *
   * No handler asks whether this process is still the current one. It writes
   * this run's own fields and nothing shared, so a predecessor still dying
   * after its replacement has spawned cannot be mistaken for the current run.
   *
   * @param {import("node:child_process").ChildProcess} process
   */
  #wire(process) {
    process.stdout?.on("data", (chunk) => this.#readProgress(String(chunk)));
    // THE CHANNEL THE ENCODER NAMES ITS FINISHED PIECES ON.
    //
    // A name arrives here when ffmpeg CLOSES the file, so the name is proof the
    // piece is whole — measured on the addon host 2026-09-05. Nothing else can
    // prove it: a file on disk may still be being written, and the only other
    // evidence available was the existence of the NEXT file, which never comes
    // for the last piece of a run.
    //
    // Lines can arrive split, so what is left over is kept for the next chunk.
    process.stdio?.[3]?.on("data", (chunk) => this.#readClosedPieces(String(chunk)));
    process.stderr?.on("data", (chunk) => {
      const line = String(chunk).trim();
      if (line.length > 0) {
        this.lastError = line;
        this.logger.warn(`ffmpeg #${this.from}..#${this.to} of ${this.address}: ${line}`);
      }
    });
    process.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.#finish(ENCODE_EXIT.FAILED, `the process could not be started: ${message}`, null, null);
    });
    process.on("exit", (code, signal) => this.#onExit(code, signal));
  }

  /**
   * ffmpeg's `-progress` stream: `key=value` lines, one block per report.
   *
   * @param {string} text
   */
  #readProgress(text) {
    for (const line of text.split(/\r?\n/)) {
      const normalized = line.trim();
      if (!normalized) {
        continue;
      }
      const separator = normalized.indexOf("=");
      if (separator <= 0) {
        continue;
      }
      const key = normalized.slice(0, separator);
      const value = normalized.slice(separator + 1);
      if (key === "out_time_ms") {
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric >= 0) {
          this.onProgress({ processedSeconds: numeric / MICROSECONDS_PER_SECOND, speed: null });
        }
      } else if (key === "out_time") {
        this.onProgress({ processedSeconds: null, speed: null, outTime: value });
      } else if (key === "speed") {
        this.noteSpeed(Number.parseFloat(value));
        this.onProgress({ processedSeconds: null, speed: value });
      }
    }
  }

  /**
   * A segment this run has finished.
   *
   * @param {number} index
   */
  noteProduced(index) {
    if (Number.isInteger(index) && index >= this.from) {
      this.#produced.add(index);
      if (this.#firstOutputAt === 0) {
        this.#firstOutputAt = this.now();
      }
      if (this.#state === ENCODE_RUN_STATE.STARTING) {
        this.#transition(ENCODE_RUN_EVENT.FIRST_SEGMENT);
      }
    }
  }

  /**
   * What ffmpeg says about its own speed.
   *
   * @param {number} speedX - Times realtime.
   */
  /**
   * Names of finished pieces, as the encoder writes them.
   *
   * @param {string} text
   */
  #readClosedPieces(text) {
    this.#closedTail += text;
    const lines = this.#closedTail.split(/\r?\n/);
    // The last piece of the chunk may be half a name; it waits for the rest.
    this.#closedTail = lines.pop() ?? "";
    for (const line of lines) {
      const name = line.trim();
      if (name.length === 0) {
        continue;
      }
      this.onClosed(name);
    }
  }

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
    if (this.#process === null || this.#ended) {
      return;
    }
    this.#stopping = true;
    this.#stopReason = because;
    this.#stopOrderedAt = this.now();
    this.#transition(ENCODE_RUN_EVENT.STOP_ORDERED);
    // A suspended process does not act on SIGTERM until it is continued, so the
    // wait for its exit would never end. Let it run before asking it to stop.
    this.#continue();
    try {
      this.#process.kill("SIGTERM");
    } catch {
      // Best effort: it may already be gone, and its exit will say so.
    }
  }

  /**
   * Stop it where it stands, producing nothing, without ending it.
   *
   * What the look-ahead does when a run is far enough in front of every viewer:
   * the process keeps its decoder, its position and its open piece, and costs
   * no processor at all until it is let go again.
   *
   * @param {string} reason
   * @returns {boolean} Whether it was suspended by this call.
   */
  pause(reason) {
    if (this.#state === ENCODE_RUN_STATE.SUSPENDED || this.#pauseUnsupported || !this.#process?.pid) {
      return false;
    }
    try {
      globalThis.process.kill(this.#process.pid, "SIGSTOP");
    } catch (error) {
      this.#pauseUnsupported = true;
      this.logger.info(
        `encode-run #${this.from}..#${this.to} cannot suspend the encoder on this platform ` +
          `(${error instanceof Error ? error.message : String(error)}); look-ahead stays unbounded`
      );
      return false;
    }
    this.#transition(ENCODE_RUN_EVENT.SUSPEND_ORDERED);
    this.logger.info(`encode-run #${this.from}..#${this.to} suspended — ${reason}`);
    return true;
  }

  /**
   * Let it go again.
   *
   * @param {string} reason
   * @returns {boolean} Whether anything was actually resumed. Two records of
   *   one moment must not contradict each other: a line saying the encoder
   *   resumed, beside a return value saying nothing was, is the sort of pair
   *   that costs an hour of reading a field log.
   */
  resume(reason) {
    if (this.#state !== ENCODE_RUN_STATE.SUSPENDED || !this.#process?.pid) {
      return false;
    }
    const continued = this.#continue();
    this.logger.info(
      continued
        ? `encode-run #${this.from}..#${this.to} resumed — ${reason}`
        : `encode-run #${this.from}..#${this.to} could not be resumed (the process is gone) — ${reason}`
    );
    return continued;
  }

  /**
   * Send `SIGCONT` without deciding anything about it.
   *
   * @returns {boolean}
   */
  #continue() {
    if (this.#state !== ENCODE_RUN_STATE.SUSPENDED || !this.#process?.pid) {
      return false;
    }
    let continued = true;
    try {
      globalThis.process.kill(this.#process.pid, "SIGCONT");
    } catch {
      // The process is gone; its exit handler will deal with it. The state is
      // moved either way — but nothing was resumed, and saying so is what stops
      // a dead run being reported as producing again.
      continued = false;
    }
    this.#transition(ENCODE_RUN_EVENT.RESUMED);
    return continued;
  }

  /**
   * @param {number | null} code
   * @param {string | null} signal
   */
  #onExit(code, signal) {
    if (this.#stopping) {
      this.#finish(ENCODE_EXIT.STOPPED, this.#stopReason, code, signal);
      return;
    }
    // What "it finished" means is the end of its own STRETCH where it was given
    // one, and the end of the film where it was not. A run told to make #10..#14
    // that exits cleanly at #11 has not finished, whatever the film's length;
    // and a run with no end has nothing but the film to be measured against.
    const endOfWork = Number.isFinite(endOfRun(this)) ? this.to : this.lastSegmentIndex();
    const outcome = classifyEncodeExit({
      code,
      producedThrough: this.#produced.size > 0 ? this.reached : null,
      lastSegmentIndex: endOfWork,
      inputUnavailable: this.inputUnavailable(this.lastError)
    });
    if (outcome === ENCODE_EXIT.COMPLETE) {
      this.#finish(ENCODE_EXIT.COMPLETE, "it reached the end of what it was given", code, signal);
      return;
    }
    if (outcome === ENCODE_EXIT.SHORT) {
      // ffmpeg exits zero both at the end of a file and when its input simply
      // stops producing bytes; over a torrent the two look identical to it. A
      // run that stopped short of the film has not finished it.
      this.#finish(
        ENCODE_EXIT.SHORT,
        `it exited cleanly at #${this.reached} of #${endOfWork ?? "?"} — its input stopped`,
        code,
        signal
      );
      return;
    }
    if (outcome === ENCODE_EXIT.INPUT_LOST) {
      this.#finish(ENCODE_EXIT.INPUT_LOST, `its input went away: ${this.lastError}`, code, signal);
      return;
    }
    this.#finish(ENCODE_EXIT.FAILED, `it exited with code ${code ?? "?"}: ${this.lastError}`, code, signal);
  }

  /**
   * @param {string} ending - One of {@link ENCODE_EXIT}.
   * @param {string} because
   * @param {number | null} code
   * @param {string | null} signal
   */
  #finish(ending, because, code, signal) {
    if (this.#ended) {
      return;
    }
    this.#ended = true;
    this.#process = null;
    // A run we stopped is already in STOPPED, ordered before the signal was
    // sent; its exit is the answer to that order and not a second event.
    if (ending !== ENCODE_EXIT.STOPPED) {
      this.#transition(
        ending === ENCODE_EXIT.COMPLETE
          ? ENCODE_RUN_EVENT.EXITED_COMPLETE
          : ending === ENCODE_EXIT.SHORT
            ? ENCODE_RUN_EVENT.EXITED_SHORT
            : ending === ENCODE_EXIT.INPUT_LOST
              ? ENCODE_RUN_EVENT.EXITED_INPUT_LOST
              : ENCODE_RUN_EVENT.EXITED_FAILED
      );
    }
    const livedMs = this.#startedAt > 0 ? this.now() - this.#startedAt : 0;
    /** @type {RunEnded} */
    const ended = {
      run: this,
      address: this.address,
      ending,
      because,
      code: code ?? null,
      signal: signal ?? null,
      from: this.from,
      to: this.to,
      reached: this.reached,
      livedMs,
      // How long dying took, and how long the first output took to appear.
      // Null where the run was never told to stop, or never produced anything:
      // an absent measurement says so rather than reading as zero.
      dyingMs: this.#stopOrderedAt > 0 ? this.now() - this.#stopOrderedAt : null,
      firstOutputMs:
        this.#firstOutputAt > 0 && this.#startedAt > 0
          ? this.#firstOutputAt - this.#startedAt
          : null,
      normal: ending === ENCODE_EXIT.COMPLETE,
      lastError: this.lastError
    };
    const line =
      `encode-run ${ending} #${this.from}..#${this.to} of ${this.address}, ` +
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
   * The wait after a lost input is over, and something is about to start
   * again.
   *
   * The run itself is finished; this moves it out of the waiting state so that
   * a second timer firing on the same run cannot start a second attempt.
   */
  retryDue() {
    this.#transition(ENCODE_RUN_EVENT.RETRY_DUE);
  }

  /**
   * Report an ending nobody watched: the run was found to be over without
   * having said so. Only for a run handed over from elsewhere.
   *
   * @param {string} because
   */
  reportGone(because) {
    this.#finish(ENCODE_EXIT.GONE, because, null, null);
  }

  /**
   * @param {string} event
   */
  #transition(event) {
    const from = this.#state;
    const to = nextState(from, event);
    if (to === null) {
      this.logger.warn(`run-state #${this.from}..#${this.to} ${from} + ${event} — no such edge; ignored`);
      return from;
    }
    this.#state = to;
    this.logger.info(`run-state #${this.from}..#${this.to} of ${this.address} ${from} --${event}--> ${to}`);
    return to;
  }
}
