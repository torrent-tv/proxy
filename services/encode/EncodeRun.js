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
import { speedFromWork } from "./encoder-readings.js";
import { RunClock } from "./RunClock.js";
import { RunProgress } from "./RunProgress.js";

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
 * @property {string | null} provenName - The last piece this run named while it
 *   was still running normally, and therefore the last one it is known to have
 *   finished. Anything on disk beyond it was open when the run ended, whatever
 *   ended it. Null where the run named nothing.
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
  #pendingClosed = null;
  #closedTimings = new Map();
  #publicationError = null;
  #inputTruncated = false;
  #stderrReadTail = "";
  #processExited = false;

  /**
   * The last piece named on the ready channel while the run was still running
   * normally — the last one it is KNOWN to have finished.
   *
   * "The encoder named it" was taken to mean "it is whole". That is true of the
   * file and false of the span. On SIGTERM ffmpeg writes out the piece it had
   * open and names it like any other; killed harder, or dying on its own, it
   * leaves that piece unnamed and half-written. Both are readable, and neither
   * covers the span its number promises. Field 2026-09-06: a run stopped
   * mid-piece left `segment-00010.mp4` holding 3.92 s of the 5.589 s the
   * playlist gives #10, and the viewer's picture jumped 1.5 s at 1:02; the
   * soundtrack did the same at 17.5 s, 2.8 s wide, in the same session.
   *
   * Recorded by WHEN the name arrives, so nothing is read and no span is
   * measured: a name that arrives after the stop was ordered is the flush and
   * does not count as proof. A piece genuinely closed in the moment between the
   * last normal name and the stop is then made a second time — the cheaper of
   * the two errors, since the other is a hole the viewer sees.
   *
   * @type {string | null}
   */
  #provenName = null;

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

  /** The film made and the run's own working time, as of the last progress report. */
  #workSample = null;

  /** The work sample taken when this run last measured its speed. */
  #pieceSample = null;

  /** @type {{ speed: number, at: number } | null} */
  #speedReading = null;

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
   * @param {(reading: { speed: number, at: number }) => void} [params.onSpeedMeasured] -
   *   Told each time this run has measured its processing speed, once per
   *   reading.
   * @param {(name: string, following: string | null) => string | null} [params.onClosed] - Called with the
   *   WORKING name of every piece the encoder has finished writing, as the
   *   encoder itself names it on its own channel, and answers with the name that
   *   piece is served under — because making it servable is a rename, and only
   *   whoever owns the disk can perform one.
   * @param {(progress: object) => void} [params.onProgress] - Called with this
   *   run's progress on the source timeline after every `-progress` report.
   * @param {() => number | null} [params.lastSegmentIndex] - The film's last
   *   segment number, for telling "reached the end" from "the input dried up".
   *   ffmpeg exits zero for both, and over a torrent it cannot tell them apart.
   * @param {(message: string) => boolean} [params.inputUnavailable] - Whether
   *   ffmpeg's own message names a missing input rather than a bad encode.
   * @param {string} [params.argsDescribed] - The command as one readable line,
   *   kept so a failure can quote what produced it.
   * @param {boolean} [params.usesExplicitCuts] - Whether this run cuts at times
   *   it was given, which decides how a segment is judged finished.
   * @param {string} params.because - Why this encoder is being put on the
   *   machine, in words. Recorded with the argument list: a start whose cause is
   *   not written down cannot be told from any other when several runs exist.
   * @param {(name: string) => number | null} [params.indexOfName] - The number
   *   a closed piece's name carries. How a piece is named belongs to the format
   *   that writes it, so it arrives as a plain function rather than this class
   *   knowing any naming.
   * @param {number} [params.startSeconds] - Where this run begins on the source timeline.
   * @param {number | null} [params.totalSeconds] - Source duration when known.
   */
  constructor({
    address,
    encoder,
    from,
    to,
    makingTag = String(from),
    buildArgs,
    spawn,
    logger,
    now,
    onEnded,
    onSpeedMeasured,
    onClosed,
    onProgress,
    lastSegmentIndex,
    inputUnavailable,
    argsDescribed = "",
    usesExplicitCuts = false,
    indexOfName,
    startSeconds = 0,
    totalSeconds = null,
    because = "no reason was given"
  }) {
    this.address = address;
    this.encoder = encoder;
    this.from = from;
    this.to = to;
    this.makingTag = makingTag;
    this.buildArgs = buildArgs;
    this.spawnProcess = spawn;
    this.logger = logger;
    this.now = typeof now === "function" ? now : Date.now;
    this.progress = new RunProgress({ startSeconds, totalSeconds, now: this.now });
    /** Where this run's time went: its own work, or waiting, or stopped. */
    this.clock = new RunClock({ now: this.now });
    this.onEnded = typeof onEnded === "function" ? onEnded : () => {};
    this.onProgress = typeof onProgress === "function" ? onProgress : () => {};
    this.onSpeedMeasured = typeof onSpeedMeasured === "function" ? onSpeedMeasured : () => {};
    // Told the NAME of every piece the encoder has closed. The name is the
    // proof it is whole; nothing else here can prove that.
    this.onClosed = typeof onClosed === "function" ? onClosed : (name) => name;
    this.lastSegmentIndex = typeof lastSegmentIndex === "function" ? lastSegmentIndex : () => null;
    this.inputUnavailable = typeof inputUnavailable === "function" ? inputUnavailable : () => false;
    this.argsDescribed = argsDescribed;
    this.usesExplicitCuts = usesExplicitCuts === true;
    this.indexOfName = typeof indexOfName === "function" ? indexOfName : () => null;
    /** The last thing ffmpeg said on stderr, which is what a failure is explained by. */
    this.lastError = "";
    // EXISTING IS RUNNING. There is no moment at which a built run is not yet a
    // process, so there is no second act for two owners to perform.
    this.#begin(because);
  }

  /** @returns {string} */
  get state() {
    return this.#state;
  }

  /**
   * This run's processing speed: film made over its own working time between
   * two closed pieces, with the time its input waited and the time it was
   * stopped taken out (`RunClock`). Zero until two pieces have closed.
   *
   * @returns {number}
   */
  get speedX() {
    return this.#speedReading?.speed ?? 0;
  }

  /**
   * The same speed with the moment it was measured, or null before a second
   * piece has closed.
   *
   * @returns {{ speed: number, at: number } | null}
   */
  get speedReading() {
    return this.#speedReading === null ? null : { ...this.#speedReading };
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

  /**
   * The last piece this run named while it was running normally.
   *
   * Its own statement that a piece is whole, and the only thing that can say so:
   * a piece cut short still decodes, so its contents cannot be asked. Whatever
   * lies beyond this name was open when the run ended, and that is what the
   * clearing-up after a run reads.
   *
   * @returns {string | null}
   */
  get provenName() {
    return this.#provenName;
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

  /** An input read of this run starts waiting for bytes; see {@link RunClock}. */
  inputWaitBegins() {
    this.clock.inputWaitBegins();
  }

  /** An input read of this run has its bytes. */
  inputWaitEnds() {
    this.clock.inputWaitEnds();
  }

  /** @returns {boolean} Whether it is stopped where it stands, producing nothing. */
  get isSuspended() {
    return this.#state === ENCODE_RUN_STATE.SUSPENDED;
  }

  /**
   * Put the process on the machine, and say why.
   *
   * PRIVATE, AND CALLED ONCE, from the constructor. It was public until
   * 2026-09-10, and two places called it: the session manager built a run and
   * started it, then handed it back to the orchestrator, which started it
   * again. Every run of every session therefore had TWO ffmpeg processes on one
   * output writing one set of names — 207 runs against 414 spawns in the field
   * logs of 08-10 September, without a single exception. Only the second was
   * reachable afterwards, because this line overwrote the reference to the
   * first, so `stop` killed one and the other ran on: measured 105 seconds past
   * its own run's death, eleven processes writing at once on a four-core host
   * whose budget said three.
   *
   * The guard against that is not a check but the absence of a second act: a
   * run exists means its process is running, so there is nothing anybody can
   * call twice.
   *
   * The reason is not decoration: a start whose cause is not recorded cannot be
   * told from any other start when several runs exist at once, and the argument
   * list alone does not say whether this was a first open, a viewer's seek, a
   * quality step or a move off covered material.
   *
   * @param {string} because
   */
  #begin(because) {
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
    // The process owns this listener even between admitted input writes.
    process.stdin?.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError ||= message;
      this.logger.warn(`ffmpeg input #${this.from}..#${this.to} of ${this.address}: ${message}`);
    });
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
        const errorText = this.#stderrReadTail + String(chunk);
        this.#inputTruncated ||= /Stream ends prematurely|Input\/output error|Error during demuxing/i.test(errorText);
        this.#stderrReadTail = errorText.slice(-512);
        this.logger.warn(`ffmpeg #${this.from}..#${this.to} of ${this.address}: ${line}`);
      }
    });
    process.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.#finish(ENCODE_EXIT.FAILED, `the process could not be started: ${message}`, null, null);
    });
    // `close` follows drained stdio; `exit` can precede the final filename.
    process.on("exit", () => { this.#processExited = true; });
    process.on("close", (code, signal) => this.#onExit(code, signal));
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
          this.#reportProgress({ processedSeconds: numeric / MICROSECONDS_PER_SECOND });
        }
      } else if (key === "out_time") {
        this.#reportProgress({ processedSeconds: null, outTime: value });
      }
    }
  }

  #reportProgress(report) {
    this.progress.note(report);
    if (Number.isFinite(report.processedSeconds) || typeof report.outTime === "string") {
      const at = this.now();
      this.#workSample = {
        at,
        producedSeconds: Math.max(0, this.progress.processedSeconds - this.progress.startPositionSeconds),
        workingMs: this.clock.workingMs(at)
      };
    }
    this.onProgress(this.progress.snapshot());
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
      const entry = line.trim();
      const csv = /^"?([^",]+)"?,(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(entry);
      const name = csv ? csv[1] : entry;
      if (name.length === 0) {
        continue;
      }
      if (this.#stopping || this.#publicationError) continue;
      if (csv) {
        this.#closedTimings.set(name, {
          endMicros: BigInt(Math.round(Number(csv[3]) * 1_000_000))
        });
      }
      // A subsequent closed file proves the previous one reached a cut.
      // The last file can instead have been flushed by an input failure.
      if (this.#pendingClosed !== null) {
        this.#publishClosed(this.#pendingClosed, name);
      }
      if (this.#publicationError) break;
      const index = this.indexOfName(name);
      const endOfWork = Number.isFinite(endOfRun(this)) ? this.to : this.lastSegmentIndex();
      // A packet crossing the final cut can flush a following file. It may
      // complete its predecessor, but no unadmitted interval can be published.
      if (Number.isInteger(index) && Number.isInteger(endOfWork) && index > endOfWork) {
        this.#closedTimings.delete(name);
        this.#pendingClosed = null;
        continue;
      }
      this.#pendingClosed = name;
    }
  }

  #publishClosed(name, following = null) {
      this.#measureSpeed();
      // ITS SERVED NAME, which is what whoever owns the disk gives it in answer.
      // ffmpeg writes a piece under a working name and reports that; the piece
      // becomes servable by being renamed, and everything below works in the
      // name a request can actually ask for.
      let served;
      try {
        served = this.onClosed(name, following, this.#closedTimings.get(name) ?? null);
      } catch (error) {
        this.#publicationError = error instanceof Error ? error.message : String(error);
        this.lastError = this.#publicationError;
        // A refused closed piece must release this run's claim now, rather
        // than keep its viewer waiting until the rest of the film is encoded.
        this.#continue();
        this.#signal("SIGTERM");
        return false;
      } finally {
        this.#closedTimings.delete(name);
      }

      if (!served) return false;
      if (!this.#stopping) {
        this.#provenName = served;
      }
      // WHAT THIS RUN HAS MADE IS THIS RUN'S OWN FACT, and this channel is where
      // it learns it. It used to be told from outside, by whoever listed the
      // output directory — which every run of an output shares — so a run
      // inherited every number any other run had ever left there. Field
      // 2026-09-06: a run beginning at the piece for 3:39 reported "reached #20
      // (483 segment(s))", having produced none of them, and its head therefore
      // described somebody else's work. Both the claim it holds and the cleanup
      // after it read that head.
      const index = this.indexOfName(served);
      if (Number.isInteger(index)) {
        this.noteProduced(index);
      }
      return true;
  }

  /**
   * A closed piece is the moment this run's speed is read: what it made since
   * the last reading, over its own working time. Measured from the first
   * closed piece rather than from the spawn, so the process start and the wait
   * for its first input bytes, which are charged once as startup, are not
   * counted as processing. A stretch with no progress keeps the earlier sample,
   * and the next reading spans both.
   */
  #measureSpeed() {
    const sample = this.#workSample;
    if (sample === null) {
      return;
    }
    if (this.#pieceSample === null) {
      this.#pieceSample = sample;
      return;
    }
    const speed = speedFromWork(this.#pieceSample, sample);
    if (speed !== null) {
      this.#speedReading = { speed, at: sample.at };
      this.#pieceSample = sample;
      this.onSpeedMeasured(this.speedReading);
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
    // A cut closed before our stop stays complete; the file flushed by the
    // subsequent signal must never be published as that same proof.
    if (this.#pendingClosed !== null && !this.#processExited && !this.#inputTruncated) {
      this.#publishClosed(this.#pendingClosed);
      this.#pendingClosed = null;
    }
    this.#stopping = true;
    this.#stopReason = because;
    this.#stopOrderedAt = this.now();
    this.#transition(ENCODE_RUN_EVENT.STOP_ORDERED);
    // A suspended process does not act on SIGTERM until it is continued, so the
    // wait for its exit would never end. Let it run before asking it to stop.
    this.#continue();
    this.#signal("SIGTERM");
  }

  /**
   * Send a signal to this run's process, and only to it.
   *
   * ONLY A PROCESS THAT STARTED IS SIGNALLED. When the executable cannot be
   * started, Node reports the failure on a later turn, and until then the child
   * holds a handle whose process id is 0. Signalling it then is `kill(0, …)`,
   * which reaches every process in our own process group: the proxy itself, and
   * under `node --test` the test runner. Measured 2026-10-03: a run stopped in
   * the same turn its `ffmpeg` failed to start ended the whole test run
   * ("Interrupted while running") in 5 of 40 runs of one file.
   *
   * Sent through the child object rather than `process.kill(pid)`, so the
   * signal goes to the process this run spawned and to nothing that happens to
   * hold the same number.
   *
   * @param {NodeJS.Signals} signal
   * @returns {boolean} Whether the signal was delivered.
   */
  #signal(signal) {
    const child = this.#process;
    if (!child || !(Number(child.pid) > 0)) {
      return false;
    }
    try {
      return child.kill(signal) !== false;
    } catch {
      // Best effort: it may already be gone, and its exit will say so.
      return false;
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
      // A platform without the signal throws here (ENOSYS), which is what
      // marks suspension unsupported below.
      this.#process.kill("SIGSTOP");
    } catch (error) {
      this.#pauseUnsupported = true;
      this.logger.info(
        `encode-run #${this.from}..#${this.to} cannot suspend the encoder on this platform ` +
          `(${error instanceof Error ? error.message : String(error)}); look-ahead stays unbounded`
      );
      return false;
    }
    this.#transition(ENCODE_RUN_EVENT.SUSPEND_ORDERED);
    this.clock.stopped();
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
    // The process may be gone; its exit handler will deal with it. The state
    // is moved either way — but nothing was resumed, and saying so is what
    // stops a dead run being reported as producing again.
    const continued = this.#signal("SIGCONT");
    this.#transition(ENCODE_RUN_EVENT.RESUMED);
    this.clock.continued();
    return continued;
  }

  /**
   * @param {number | null} code
   * @param {string | null} signal
   */
  #onExit(code, signal) {
    if (this.#publicationError) {
      this.#finish(ENCODE_EXIT.PUBLICATION_FAILED, this.#publicationError, code, signal);
      return;
    }
    if (this.#stopping) {
      this.#finish(ENCODE_EXIT.STOPPED, this.#stopReason, code, signal);
      return;
    }
    // What "it finished" means is the end of its own STRETCH where it was given
    // one, and the end of the film where it was not. A run told to make #10..#14
    // that exits cleanly at #11 has not finished, whatever the film's length;
    // and a run with no end has nothing but the film to be measured against.
    const endOfWork = Number.isFinite(endOfRun(this)) ? this.to : this.lastSegmentIndex();
    const pendingIndex = this.#pendingClosed === null ? null :
      this.indexOfName(this.#pendingClosed);
    const outcome = classifyEncodeExit({
      code,
      producedThrough: this.#inputTruncated ? this.reached :
        (pendingIndex === this.head ? pendingIndex : this.reached),
      producedCount: this.#produced.size + Number(pendingIndex === this.head && !this.#inputTruncated),
      lastSegmentIndex: endOfWork,
      inputUnavailable: this.inputUnavailable(this.lastError)
    });
    if (outcome === ENCODE_EXIT.COMPLETE) {
      if (this.#pendingClosed !== null && !this.#inputTruncated) {
        if (!this.#publishClosed(this.#pendingClosed)) {
          this.#finish(this.#publicationError ? ENCODE_EXIT.PUBLICATION_FAILED : ENCODE_EXIT.SHORT,
            this.#publicationError ?? "its final file could not be published", code, signal);
          return;
        }
        this.#pendingClosed = null;
      }
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
      provenName: this.#provenName,
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
