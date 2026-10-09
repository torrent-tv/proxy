/**
 * The encoders of this proxy, from the plan's decision to the end of the process.
 *
 * The plan (`EncodePlan`, through `EncodeOrchestrator`) decides where a run goes;
 * this builds it with the arguments its output needs, follows what it produces,
 * says how far it got, and accounts for how it ended. Nothing here decides where
 * an encoder should be.
 */

import path from "node:path";
import { spawn } from "node:child_process";
import { contentionPenalty } from "./contention.js";
import { ENCODE_RUN_STATE, liveRunsOf, runStateOf, wireState } from "./encode-run-state.js";
import { ENCODE_EXIT } from "./encode-exit.js";
import { EncodeRun } from "./EncodeRun.js";
import { computeOutputDimensions } from "./args.js";
import { buildAdmittedCommand } from "./admitted-command.js";
import { buildOriginalCommand } from "./source-command.js";
import { writeAdmittedInput } from "./AdmittedInput.js";
import { cutOf, judgeNeighbors, judgePiece } from "./piece-completeness.js";
import { presentationSegment } from "./segment-formats/presentation-segment.js";
import { InputFailures, failedAdmittedInput } from "./InputFailures.js";


/**
 * @typedef {Object} SegmentFiles
 * @property {(address: string) => string} pathFor
 * @property {(address: string) => Buffer | null} initOf
 * @property {(address: string) => string} directoryFor
 * @property {(address: string, makingName: string, format: object, read?: { mediaRanges?: object | null }) => string | null} publish
 * @property {(address: string, makingName: string) => Buffer} closedBytesOf
 * @property {(address: string, index: number, where?: { startSeconds?: number }) => object | undefined} mediaRangesOf
 * @property {(address: string, index: number, because: string) => void} remove
 */
// How far the accounting of a backward restart looks for work about to be done
// twice. It runs on the restart path and a session an hour in has thousands of
// segments; the figure is for a comparison, not an inventory.
const BACKWARD_RESTART_SCAN_SEGMENTS = 300;
const PROGRESS_LOG_INTERVAL_MS = 5_000;
/**
 * Format a seconds value as `HH:MM:SS`, or `"n/a"` if not finite.
 *
 * @param {number} seconds
 * @returns {string}
 */
export function formatSeconds(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "n/a";
  }
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}
/**
 * Where this session's encoding begins: the earliest number any live run of it
 * was given.
 *
 * @param {object[] | Set<object>} runs
 * @returns {number | null}
 */
export function earliestRunStart(runs) {
  const live = liveRunsOf(runs);
  return live.length > 0 ? live[0].from : null;
}
/**
 * The live run of this session that was given this number, if any.
 *
 * A run with an explicit stretch owns the whole of it. One WITHOUT an end owns
 * only as far as it has actually got: claiming the rest of the film would make
 * it the owner of every number in front of it, including ones another run was
 * expressly given.
 *
 * @param {object[] | Set<object>} runs
 * @param {number} index
 * @returns {object | null}
 */
function ownRunMaking(runs, index) {
  let answer = null;
  for (const run of liveRunsOf(runs)) {
    if (run.from > index) {
      break; // Ordered by start, so nothing further can hold this number.
    }
    if (Number.isInteger(run.to) && run.to >= run.from && index > run.to) {
      continue; // Its stretch ends before this number.
    }
    answer = run;
  }
  return answer;
}

/**
 * Whether an encoder run died because its INPUT went away, rather than because
 * of anything about the encode itself.
 *
 * These are the messages the read path and ffmpeg's HTTP client produce when
 * the torrent is gone, being re-added, or has no data for the range yet — all
 * of them temporary by nature: the source can be added again and the pieces
 * fetched again.
 *
 * @param {string} message
 * @returns {boolean}
 */
export function isInputUnavailable(message) {
  const text = typeof message === "string" ? message : "";
  return (
    /Error reading HTTP response/i.test(text) ||
    /not found in (?:magnet|torrent):/i.test(text) ||
    /Unknown source/i.test(text) ||
    /is gone and cannot be re-added/i.test(text) ||
    /Read error at pos/i.test(text) ||
    /Server returned 5\d\d/i.test(text) ||
    /Input\/output error/i.test(text) ||
    /Connection reset by peer/i.test(text) ||
    /End of file/i.test(text)
  );
}

/**
 * The ffmpeg command as one readable line.
 *
 * Everything is shown as passed except the list of cut times, which is one
 * value per segment — 830 of them on a two-hour film, about 7 KB of log for a
 * single run, repeated on every restart. The count and the two ends say
 * everything the list is ever consulted for: whether cutting was explicit at
 * all, how far it reaches, and where it starts.
 *
 * @param {string[]} args
 * @returns {string}
 */
export function describeFfmpegArgs(args) {
  const parts = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    // Both take the same list, and a keyframe-grid variant passes it twice.
    // `-force_key_frames` also takes an expression, which is short and is left
    // alone — only a list is folded.
    if (
      (value === "-segment_times" || value === "-force_key_frames") &&
      typeof args[index + 1] === "string" &&
      args[index + 1].includes(",")
    ) {
      const times = args[index + 1].split(",");
      parts.push(value, `<${times.length} cuts ${times[0]}..${times[times.length - 1]}>`);
      index += 1;
      continue;
    }
    parts.push(value);
  }
  return parts.join(" ");
}

export class EncodeRuns {
  #inputState = new WeakMap();

  /**
   * Live runs by the number their input reads carry, so the stream route can
   * say which run's input is waiting.
   *
   * @type {Map<number, import("./EncodeRun.js").EncodeRun>}
   */
  #runsByInputToken = new Map();

  #lastInputToken = 0;
  #inputFailures = new InputFailures();
  /** What this reads and asks of the rest of the proxy, and nothing else. @type {object} */
  #host;

  /**
   * Whether a re-decision of what encoders should exist is already queued for
   * the end of this turn. See `planEncodersSoon`.
   * @type {boolean}
   */
  #planScheduled = false;

  /**
   * @param {object} host - `logger`, `viewerSecondsOn`, `noteRunSpeedMeasured`, `inputOf`, `producedNumbers`, `servesAudioSeparately`, `disposeSession`, `contentionPenalties`, `encodeCost`, `encodeOrchestrator`, `encoders`, `ffmpegBin`, `outputTimes`, `outputs`, `priority`, `segmentDurationSec`, `segmentFiles`, `videoEncoder`
   * @param {(session: object, run: object) => void} [host.noteRunSpeedMeasured] -
   *   A run of this output has measured its processing speed.
   * @param {(session: object, runToken: number) => object} host.inputOf - The
   *   addresses a run reads; `runToken` marks them as that run's.
   * @param {SegmentFiles} host.segmentFiles - The storage operations used to
   *   write and inspect output files.
   */
  constructor(host) {
    this.#host = host;
  }

  #inputStateFor(output) {
    let state = this.#inputState.get(output);
    if (!state) {
      state = {
        inputRetryCount: 0,
        backwardRestarts: { count: 0, segmentsBack: 0, worstBack: 0, remade: 0 },
        firstWantedAt: new Map(),
        /** Bytes the swarm has delivered to this output's own input reads. */
        inputBytes: 0,
        /** The mismatch between the held init and the run's size last said, so it is said once. */
        initSizeSaid: ""
      };
      this.#inputState.set(output, state);
    }
    return state;
  }

  noteWanted(output, index, at = Date.now()) {
    const wanted = this.#inputStateFor(output).firstWantedAt;
    if (!wanted.has(index)) wanted.set(index, at);
  }

  resetInputRetry(output) {
    this.#inputStateFor(output).inputRetryCount = 0;
  }

  /**
   * Count bytes the swarm has delivered to one output's own input read.
   *
   * Called by the `/stream` route for every fragment it writes to an encoder.
   * Cheap on purpose — one addition, no clock, no log — because it runs per
   * fragment on the path that feeds ffmpeg.
   *
   * @param {string} outputId
   * @param {number} bytes
   * @returns {void}
   */
  noteInputBytes(outputId, bytes) {
    if (!outputId || !(bytes > 0)) {
      return;
    }
    const output = this.#host.outputs.get(outputId);
    if (output) {
      this.#inputStateFor(output).inputBytes += bytes;
    }
  }

  /**
   * An input read of one run starts or stops waiting for bytes. Called by the
   * `/stream` route around every wait for the next part of the file; see
   * `RunClock` for what the time is used for.
   *
   * @param {number} runToken - From the read's own URL.
   * @param {boolean} waiting
   * @returns {void}
   */
  noteInputWaiting(runToken, waiting) {
    const run = this.#runsByInputToken.get(runToken);
    if (!run) {
      return;
    }
    if (waiting) {
      run.inputWaitBegins();
    } else {
      run.inputWaitEnds();
    }
  }

  originalInputOf(runToken) {
    return this.#runsByInputToken.get(runToken)?.originalInput ?? null;
  }

  /**
   * @param {object} output
   * @returns {number}
   */
  inputBytesOf(output) {
    return output ? this.#inputStateFor(output).inputBytes : 0;
  }

  runsOf(output) {
    return output ? this.#host.encodeOrchestrator.runsOn(output.outputKey) : [];
  }

  /**
   * Where the earliest live encoder of this output began, or null with none.
   *
   * @param {object} output
   * @returns {number | null}
   */
  earliestStartOf(output) {
    return earliestRunStart(this.runsOf(output));
  }

  isLive(output) {
    return Boolean(output && this.#host.outputs.get(output.id) === output);
  }

  liveRunsOf(output) {
    return liveRunsOf(this.runsOf(output));
  }

  runStateOf(output) {
    if (this.#host.encodeInputs?.failureOf(output)) return ENCODE_RUN_STATE.ENDED_FAILED;
    if (output && this.liveRunsOf(output).length === 0 && this.#inputFailures.reason(output.outputKey)) return ENCODE_RUN_STATE.ENDED_FAILED;
    return output ? this.#host.encodeOrchestrator.stateOf(output.outputKey) : runStateOf([]);
  }

  lastErrorOf(output) {
    const failedInput = this.#host.encodeInputs?.failureOf(output);
    if (failedInput) return `${failedInput.reason}: ${failedInput.message ?? ""}`;
    const failed = output && this.#inputFailures.reason(output.outputKey);
    if (failed) return failed;
    return output ? this.#host.encodeOrchestrator.errorOf(output.outputKey) : "";
  }

  /**
   * Whether this output's encoding has failed for good.
   *
   * @param {object} output
   * @returns {boolean}
   */
  hasFailed(output) {
    return this.runStateOf(output) === ENCODE_RUN_STATE.ENDED_FAILED;
  }

  /**
   * Whether this output's input went away and is being fetched again.
   *
   * @param {object} output
   * @returns {boolean}
   */
  isWaitingForInput(output) {
    return this.runStateOf(output) === ENCODE_RUN_STATE.RETRY_WAIT;
  }

  /**
   * The run state in the words the browser is told.
   *
   * @param {object} output
   * @returns {string}
   */
  wireStateOf(output) {
    return wireState(this.runStateOf(output));
  }

  /**
   * What went wrong, when this output's encoding has failed; empty otherwise.
   *
   * @param {object} output
   * @returns {string}
   */
  failureOf(output) {
    return this.hasFailed(output) ? this.lastErrorOf(output) : "";
  }

  /**
   * The media intervals of a closed file that holds the whole of its piece,
   * null where its format reads none, or false where it is not to be published:
   * short of its cut, without playable media, or unreadable.
   *
   * @param {HlsSession} session
   * @param {string} name - The working name the encoder closed it under.
   * @param {number} index
   * @returns {object | null | false}
   */
  #wholeClosedPiece(session, name, index, admitted = false, bytes = null) {

    const format = session.segmentFormat;
    if (!format?.readMediaRanges || !Number.isInteger(index) || index < 0) {
      return null;
    }
    const address = session.outputKey ?? "";
    try {
      const mediaRanges = format.readMediaRanges(bytes ?? this.#host.segmentFiles.closedBytesOf(address, name));

      const cut = cutOf(session.timeline, index);
      const grid = session.timeline.published ?? session.timeline.boundaries;
      const interval = admitted ? { from: grid?.[index], to: grid?.[index + 1],
        ...(index === session.timeline.segmentCount - 1 ? { sourceEnds: Object.fromEntries(
          (admitted.tracks ?? []).filter(input => Number.isFinite(input.sourceEndSeconds))
            .map(input => [input.track.type === "video" ? "vide" : "soun", input.sourceEndSeconds])) } : {}),
        requiredKinds: [session.spec.carries !== "audio-only" ? "vide" : null,
          session.spec.audio && !this.#host.servesAudioSeparately(session) ? "soun" : null].filter(Boolean) } : undefined;
      const { whole, throughSeconds, reason } = judgePiece(format, mediaRanges, cut, interval);
      if (!whole) {
        this.#host.logger.warn(
          `encode: not publishing piece ${index} of ${address.slice(0, 60)}: ` +
            (reason ?? (throughSeconds === null ? "it holds no playable media" : `produced through ${throughSeconds}s, cut ${cut}s`)) +
            (interval ? ` expected=${interval.from}..${interval.to} tracks=${JSON.stringify(mediaRanges.tracks.map(track => ({
              kind: track.kind, timescale: track.timescale, frame: track.productionFrame,
              first: track.ranges[0], last: track.ranges.at(-1), count: track.ranges.length })),
              (_key, value) => typeof value === "bigint" ? String(value) : value)}` : "")
        );
        return false;
      }
      if (admitted) {
        const produced = this.#host.producedNumbers(session);
        for (const neighbor of [index - 1, index + 1]) {
          if (!produced.includes(neighbor)) continue;
          const ranges = this.#host.segmentFiles.mediaRangesOf(address, neighbor,
            { startSeconds: grid[neighbor] });
          if (!ranges) continue;
          const judged = neighbor < index ? judgeNeighbors(ranges, mediaRanges) : judgeNeighbors(mediaRanges, ranges);
          if (!judged.whole) {
            this.#host.logger.warn(`encode: not publishing piece ${index} of ${address}: ${judged.reason}`);
            return false;
          }
        }
      }
      return mediaRanges;
    } catch (error) {
      this.#host.logger.warn(`encode: could not read the media of ${name}: ${error instanceof Error ? error.message : String(error)}`);
      if (/^E[A-Z]+$/.test(error?.code ?? "")) throw error;
      return false;
    }
  }

  /**
   * The media intervals of a stored piece of this output that holds the whole
   * of its stretch, or undefined. A stored piece short of its cut — left by an
   * earlier process — is taken off the disk here, where its cut is known.
   *
   * @param {HlsSession} output
   * @param {number} index
   * @returns {object | undefined}
   */
  finishedMediaRangesOf(output, index) {
    const address = output.outputKey ?? "";
    const timeline = output.timeline;
    const ranges = this.#host.segmentFiles.mediaRangesOf(address, index, {
      startSeconds: timeline.publishedStartOf(index)
    });
    if (!ranges || !output.segmentFormat?.producedThroughSeconds) {
      return ranges;
    }
    const cut = cutOf(timeline, index);
    const { whole, throughSeconds } = judgePiece(output.segmentFormat, ranges, cut);
    if (whole || throughSeconds === null) {
      return ranges;
    }
    this.#host.segmentFiles.remove(address, index, `produced through ${throughSeconds}s, short of its cut at ${cut}s`);
    return undefined;
  }

  progressOf(output, index = null) {
    if (!output) {
      return null;
    }
    const at = Number.isInteger(index)
      ? index
      : this.#host.outputTimes.segmentIndexForTime(output, this.#host.viewerSecondsOn(output));
    const progress = this.#host.encodeOrchestrator.progressOf(output.outputKey, at);
    if (progress) {
      return progress;
    }
    const start = this.#host.viewerSecondsOn(output);
    const total = Number(output.file?.durationSeconds);
    return {
      processedSeconds: start,
      startPositionSeconds: start,
      totalSeconds: Number.isFinite(total) && total > 0 ? total : null,
      percent: 0,
      remainingSeconds: Number.isFinite(total) && total > 0 ? Math.max(0, total - start) : null,
      updatedAt: this.#host.outputs.startedAt(output) ?? Date.now()
    };
  }

  planEncodersNow() {
    const byOutput = this.#outputsWithSessions();
    for (const [address, sessions] of byOutput) {
      // From the TIMELINE, which is where how a file is cut has lived since
      // 2.76.0. Read off the session it left, this was `undefined` on every
      // session ever made: the map then held no length, and the walk that
      // gives a run its end ran to MAX_SAFE_INTEGER — the main thread spun at
      // 100% and the proxy answered nothing, measured on the addon host
      // 2026-09-05 with the stack read out of the live process.
      const segmentCount = Number(sessions[0].timeline?.segmentCount) || 0;
      if (segmentCount > 0) {
        this.#host.encodeOrchestrator.setSegmentCount(address, segmentCount);
      }
    }
    // THE MAP IS BUILT ONCE, IN ITS OWN LAYER, AND BOTH SIDES READ THAT ONE.
    //
    // It used to be built twice: once here, per viewer, converted and stated to
    // the encoding as a window each, and once again inside `publishFor` for the
    // downloading. Two answers to one question, and the encoding's copy carried
    // the viewer's NAME as the key of a claim — against the rule that the
    // encoding and the viewer are not connected at all.
    this.#host.priority.publishFor({
      sessionGroups: byOutput.values(),
    });
    // FROM THE VIEWERS OF THAT OUTPUT, not from the viewers of the film.
    //
    // Both scopes are right for what asks them: the swarm is asked for bytes of
    // a FILE, which every output of it reads, and encoders are placed per
    // OUTPUT, which a person watching 480p wants nothing of at 1080p. Handed the
    // film's map, the plan wanted an encoder on every output of it, and what
    // stopped the unwatched ones was this class killing them by its own
    // judgement — while the viewer's own move announced itself and had the plan
    // start them again.
    //
    // Converted into each output's own numbering, because two outputs of one
    // film are cut independently and the same second is a different number in
    // each: 454 pieces against 401 on the field file.
    for (const [address, sessions] of byOutput) {
      const timeline = sessions[0].timeline;
      const spec = sessions[0].spec;
      this.#host.encodeOrchestrator.notePriorityMap(
        address,
        timeline?.inSegments?.(
          this.#host.priority.mapForOutput(address),
          Number(timeline?.segmentCount) || 0,
          { runsPastEnd: Boolean(spec?.audio) && spec?.transcodesAudio !== true }
        ) ?? []
      );
    }
    this.#host.encodeOrchestrator.reconcile();
  }

  /**
   * Re-decide what encoders should exist, once, after the change that is being
   * made now.
   *
   * COALESCED, NOT DELAYED. One turn of the event loop may carry several
   * changes — a viewer arrives and is placed and states their soundtrack — and
   * each of them is a reason to re-decide, while re-deciding three times in a
   * row would give the same answer three times and could act on a half-built
   * state. So the decision is taken once, after the current turn, and no
   * interval is involved: there is nothing to choose and nothing to tune.
   *
   * @returns {void}
   */
  planEncodersSoon() {
    if (this.#planScheduled) {
      return;
    }
    this.#planScheduled = true;
    queueMicrotask(() => {
      this.#planScheduled = false;
      try {
        this.planEncodersNow();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#host.logger.warn(`transcode could not re-plan encoders: ${message}`);
      }
    });
  }

  /**
   * The live sessions grouped by the output they produce.
   *
   * @returns {Map<string, HlsSession[]>}
   */
  #outputsWithSessions() {
    /** @type {Map<string, HlsSession[]>} */
    const byOutput = new Map();
    for (const session of this.#host.outputs.values()) {
      const address = session.outputKey ?? "";
      if (!address) {
        continue;
      }
      byOutput.set(address, [...(byOutput.get(address) ?? []), session]);
    }
    return byOutput;
  }

  forgetEncodingOfGone(output) {
    this.#host.encodeInputs?.forget(output);
    if (this.#host.outputs.outputsOn(output.outputKey).length === 0) {
      this.#inputFailures.forget(output.outputKey);
      this.#host.encodeOrchestrator.forgetOutput(output.outputKey);
    }
  }

  /**
   * Make an encoder for this output, beginning at this segment.
   *
   * Another run of the SAME session, not another session. A run at another
   * position is not a different output — the material, the tracks, the grid and
   * the box are all the same, and only where it begins differs, which changes
   * no byte of what is produced. Both write into the output's one directory and
   * either viewer is served whatever either has made.
   *
   * @param {string} address
   * @param {number} from
   * @param {number} to
   * @param {string} because - The plan's own words for why it placed this one.
   * @returns {object | null}
   */
  makeRunAt(address, from, to, because) {
    let base = null;
    for (const session of this.#host.outputs.values()) {
      if (session.outputKey === address) {
        base = session;
        break;
      }
    }
    if (!base) {
      return null;
    }
    // A position that has already failed to start, this many times running,
    // will fail again: nothing about it has changed between the attempts, which
    // is exactly why the attempts keep taking the same fraction of a second and
    // ending the same way.
    //
    // The plan is arithmetic over coverage and demand, and neither of them
    // knows that a process refused to start — so without asking here, the plan
    // commands the same start, the run ends, the ended stretch goes back to the
    // map, and the plan commands it again. Measured 2026-09-05 with ffmpeg
    // absent: fifty passes of the plan in the time a probe took to notice, as
    // fast as spawning could fail. The five-second timer this decision used to
    // sit on hid that, at the price of hiding it in the field too — the loop
    // seen there ran for sixteen minutes and read as "a restart every five
    // seconds".
    //
    // A DIFFERENT position is unaffected and gets its own budget, and the count
    // resets the moment a run at this one does real work.
    if (!this.#host.encodeInputs && !this.#host.encodeOrchestrator.mayStartAt(address, from)) {
      return null;
    }
    // The encoder is built and handed back in this same call. Nothing here
    // waits: the one thing this path used to wait for was the death of the run
    // it was replacing, and that killing is gone. Answering with nothing while
    // the encoder was built behind the answer is what let the same stretch be
    // started over and over — 684 starts in 482 seconds of field 2026-09-05.
    try {
      return this.#startEncodeRun(base, from, because, { to });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#host.logger.warn(`transcode could not start a run at #${from} of ${address}: ${message}`);
      return null;
    }
  }

  /**
   * How many encoders this machine can afford on one output at once.
   *
   * Measured rather than chosen, and it is the same arithmetic that decides
   * which quality steps are offered: what a second job costs here is not
   * assumed to be nothing. Field 2026-09-03 on the addon host, `testsrc2`
   * through libx264 `ultrafast` — at 854x480 one run makes 7.12x and two make
   * 4.20x and 4.16x, so both stay far above realtime and a second is
   * affordable; at 1920x1080 one makes 1.96x and two make 0.99x and 0.98x, so
   * the machine is full at one.
   *
   * @param {string} address
   * @returns {number}
   */
  maxRunsForOutput(address) {
    const alone = this.#host.encodeCost.speedForOutput(address);
    if (!(alone > 0)) {
      // The host measured nothing at all, which is a broken startup rather than
      // a state to plan around. One encoder is what it keeps.
      return 1;
    }
    let affordable = 1;
    for (;;) {
      const { penalty, measured, from } = contentionPenalty(affordable, this.#host.contentionPenalties);
      // An UNMEASURED penalty is 1, and that is the honest answer to "what does
      // a second job cost" only in the sense that nothing has been measured —
      // it is not a statement that a second job is free. Measured on the addon
      // host it is 1.70x at 854x480 and 1.98x at 1920x1080, so taking 1 would
      // let a machine that cannot hold two runs start two. Where nothing has
      // been measured, one is what it has.
      //
      // `from` is the concurrency the reading came from, and past the measured
      // range `contentionPenalty` HOLDS the largest reading rather than continue
      // a curve two points cannot describe. Held is the right answer to "what
      // does this cost", and the wrong one to "may I start another": it would
      // price a fifth encoder at what a second was measured to cost, and a fast
      // host would keep dividing until some chosen ceiling stopped it. So the
      // ladder stops where the measurements stop — the bound on how many
      // encoders may run is measured, like the budget itself, and there is no
      // constant here to overrule it.
      if (!measured || from !== affordable || !(alone / penalty >= 1)) {
        break;
      }
      affordable += 1;
    }
    return affordable;
  }

  /**
   * A segment this run made has just been served.
   *
   * The one event whose raising is guarded by the state, and the guard is a
   * READ of the state rather than a second copy of it: "something has been
   * produced" is a level, not an edge, so without the guard every served
   * segment would raise it and the log would fill with refusals.
   *
   * Whose file it is decides the rest, and the directory answers that outright:
   * runs write into one each, and serving searches them newest-first, so a
   * segment left by an EARLIER run is served routinely. Comparing indices
   * instead would have been fooled by the ordinary case of a backward seek —
   * the new run starts at #10, the old one left #50 on disk, and #50 is above
   * the new run's start index while saying nothing about it.
   *
   * @param {HlsSession} session
   * @param {string} filePath - Where the served segment was actually found.
   * @returns {void}
   */
  noteRunProducedSegment(session, filePath) {
    if (typeof filePath !== "string" || path.dirname(filePath) !== this.#host.segmentFiles.pathFor(session.outputKey ?? "")) {
      return;
    }
    const index = session.segmentFormat.segmentIndexFromName(path.basename(filePath));
    if (index === null) {
      return;
    }
    // Whichever run was given this number. An output has as many runs as the
    // machine affords, and a segment moves the one it belongs to out of
    // starting — not whichever happens to be listed first.
    ownRunMaking(this.runsOf(session), index)?.noteProduced(index);
  }

  /**
   * Say so when a run is about to encode a picture the init segment already in
   * the player's hands does not describe.
   *
   * This is the whole class of fault named in one line, and it exists because
   * the fault is otherwise SILENT: no layer reports an error, the encoder is
   * healthy, segments are served in milliseconds, and what the viewer gets is
   * either a band of macroblock garbage or a picture that never appears. The
   * shape is the one 2.48.0 uses for the TIME a run begins at — a run states
   * where it really landed, and a disagreement with what was published is
   * named rather than left to be inferred from a browser's own reading.
   *
   * The size the init describes is read from the init's own bytes, not taken
   * from our record of what the encoder was told, because those two disagreeing
   * IS the fault. The size the run will produce is computed by the same
   * arithmetic the scale filter performs, so a source smaller than the target
   * box is not reported as a disagreement.
   *
   * Said once per distinct pair of sizes: a run repeated at the same wrong size
   * has nothing further to say.
   *
   * @param {HlsSession} session
   * @returns {void}
   */
  #warnIfRunLeavesTheInitBehind(session) {
    const initBytes = this.#host.segmentFiles.initOf(session.outputKey ?? "");
    if (!session.spec.transcodesVideo || !initBytes || initBytes.length === 0) {
      return; // nothing served yet, or nothing being encoded
    }
    const format = session.segmentFormat;
    if (typeof format?.initVideoSize !== "function") {
      return; // a self-describing container (MPEG-TS) cannot have this fault
    }
    const described = format.initVideoSize(initBytes);
    if (!described) {
      return;
    }
    if (!(session.output.encodeWidth > 0) || !(session.output.encodeHeight > 0)) {
      return; // the run keeps the encoder's own default box; nothing was told
    }
    const producing = computeOutputDimensions(
      session.output.encodeWidth,
      session.output.encodeHeight,
      session.file.width,
      session.file.height
    );
    if (!producing) {
      return; // the source size is unknown, so nothing can be predicted
    }
    if (described.width === producing.w && described.height === producing.h) {
      return;
    }
    const said = `${described.width}x${described.height}->${producing.w}x${producing.h}`;
    const inputState = this.#inputStateFor(session);
    if (inputState.initSizeSaid === said) {
      return;
    }
    inputState.initSizeSaid = said;
    this.#host.logger.warn(
      `transcode ${session.id} is about to encode ${producing.w}x${producing.h} while the init segment ` +
        `the player holds describes ${described.width}x${described.height} "${session.file.name}" — ` +
        `every fragment of this run will be decoded against parameter sets for a picture that is not ` +
        `being made. A change of size is a change of variant; nothing here should have moved it.`
    );
  }

  /**
   * How far a run starting here may work before it meets somebody else's
   * material — read off the ONE coverage map, never worked out again here.
   *
   * This replaced `planRunInterval`, which was a second authority over the same
   * question and answered it by different rules: it walked the whole track for
   * the first free number, MOVED the start there itself, and counted every live
   * run as claiming up to `head + look-ahead`. Measured in the field
   * 2026-09-05: the plan commanded a start at #46, this moved it to #78 — the
   * "run moved forward from #46 to #78" line — and the plan, seeing a run
   * outside the window it had asked for, killed it as unwanted and commanded
   * the same start again, 350-700ms per cycle, dozens of times, the viewer's
   * picture stopped for 125 seconds.
   *
   * Where a run STARTS is the plan's decision and arrives here as an argument.
   * All this answers is where it must stop, and the answer is a fact of the
   * map: the free stretch from that number on. `-1` means the end of the track,
   * which is what "no end" is written as everywhere here.
   *
   * @param {object} session
   * @param {number} startIndex
   * @param {object | null} exceptRun - The run being replaced, whose own claim
   *   is not somebody else's material.
   * @returns {number} The last number to work through, or `-1` for the end.
   */
  #runEndFrom(session, startIndex, exceptRun = null) {
    return this.#host.encodeOrchestrator.freeStretchEnd({
      address: session.outputKey ?? "",
      from: startIndex,
      exceptRun,
      segmentCount: Number(session.timeline?.segmentCount) || 0
    });
  }

  // Returns the encoder it built, or nothing when there was nothing to build.
  // It waits for nothing: the one thing it used to wait for was the death of
  // the run it was replacing, and that killing is gone.
  #startEncodeRun(session, startIndex, because, ordered = null) {
    if (!this.isLive(session)) {
      return null;
    }
    this.#host.encodeInputs?.retain(session, this.#host.encodeOrchestrator.wantedSegmentsOn(session.outputKey));
    // THE LAST NUMBER THIS RUN MAY REACH is the plan's; how far its input
    // really reaches is the input's answer. An original input is one copied
    // stretch, and the run is given exactly that stretch (torrent-tv/meta#158).
    const segmentCount = Number(session.timeline?.segmentCount) || 0;
    const mayReach = Number.isInteger(ordered?.to) && ordered.to >= startIndex ? ordered.to
      : segmentCount > startIndex ? segmentCount - 1 : startIndex;
    const admittedInput = this.#host.encodeInputs?.take(session, startIndex, mayReach) ?? null;
    if (!admittedInput) return null;
    const inputEnd = admittedInput.original ? admittedInput.to : startIndex;
    // The stretch is part of an original input's identity: two stretches from
    // one start can hold the same padded bytes, and a stretch that failed is
    // refused only while it is the same stretch.
    const inputParameters = admittedInput ? { outputKey: session.outputKey, encoder: this.#host.videoEncoder.name,
      width: session.output.encodeWidth, height: session.output.encodeHeight, fps: session.output.outputFps,
      preset: session.output.softwarePreset, tonemap: session.output.applyTonemap,
      rateControl: session.spec.video?.encode?.rateControl ?? null,
      ...(admittedInput.original ? { interval: [startIndex, inputEnd] } : {}) } : null;
    const inputKey = admittedInput ? this.#inputFailures.key(admittedInput, inputParameters) : null;
    if (inputKey && this.#inputFailures.failure(session.outputKey, startIndex, inputKey)) {
      admittedInput.release();
      return null;
    }
    try {
    // Where a restart's seconds go. A seek costs 5-8 s in the field and the
    // recorded reason — waiting for the previous ffmpeg to exit, measured at
    // 0.54-1.47 s — does not account for it. Before rebuilding the hottest path
    // in the proxy on a guess, make each stage state its own cost.
    const restartEnteredAt = Date.now();
    // Reads where the old run began BEFORE the new one takes its place, and
    // does not await: everything below is the restart path, which is measured
    // in milliseconds and has been worked on twice to keep it that way.
    this.#accountBackwardRestart(session, startIndex);
    // STARTING AN ENCODER STOPS NOTHING. It used to stop any live run whose own
    // start was not below this one's — a rule left over from when a session
    // held exactly one run and "the previous one" meant "the only one". Once a
    // an output could hold several, that rule began killing runs the plan had
    // decided to keep: 294 stops for this reason in eight minutes of field
    // 2026-09-05, against four starts asked for by a viewer. Who is stopped is
    // decided in one place, and it is not this one.
    //
    // HOW FAR IT MAY WORK is decided by the same one place and arrives here as
    // an argument. Reading it off the coverage map a second time was the last
    // remaining second answer to that question: the plan computed `to`, passed
    // it, and the parameter list did not name it.
    const runEnd = admittedInput ? inputEnd : Number.isInteger(ordered?.to)
      ? ordered.to
      : this.#runEndFrom(session, startIndex, null);
    // The restart backs off a segment or two from what was asked for, so the
    // request that prompted it is recorded under a HIGHER index than the run
    // starts at. Looking it up by the start index alone found nothing and the
    // line never printed once.
    let wantedAt = null;
    const inputState = this.#inputStateFor(session);
    for (const [index, at] of inputState.firstWantedAt) {
      if (index >= startIndex && (wantedAt === null || at < wantedAt)) {
        wantedAt = at;
      }
    }
    if (typeof wantedAt === "number") {
      this.#host.logger.info(
        `transcode ${session.id} restart for #${startIndex} decided ` +
        `${restartEnteredAt - wantedAt}ms after it was first asked for`
      );
    }
    // Cleared with the run that could not answer them. These are "how long has
    // this segment gone unanswered", and the question only means anything about
    // the run in force: a timestamp kept from an abandoned scan probe minutes
    // ago says a fresh request has already waited long enough, which is how the
    // behind-head repair came to fire on the very first poll instead of waiting
    // for the seek that should move the encoder. It also stops the map growing
    // for the life of a session.
    inputState.firstWantedAt.clear();
    // WHERE THIS NUMBER REALLY BEGINS, when a produced piece has said so and
    // the table the player holds still says otherwise.
    //
    // Only a soundtrack, and only because a soundtrack has no keyframes: it
    // begins exactly where it is asked to, to within one audio frame, while the
    // picture can begin nowhere but a real keyframe and so moves forward to the
    // next one — up to three seconds, measured 2026-08-17. Left at the published
    // time, the sound of one film starts up to that far from its picture after
    // every restart, each correctly labelled with where it really is, and the
    // viewer gets sound with no new picture for the difference.
    //
    // DERIVED HERE rather than handed in. It used to arrive as an argument from
    // the one caller that knew it — the correction that had just measured it —
    // which meant the instant was only ever right for a run that caller
    // started. Any run the plan placed at a corrected number got the published
    // time and landed apart again. It is a fact of the FILE's cutting, held in
    // the live table every session of the file shares, so it is read from
    // there.
    // What is still read off the session for a run. The list is the measure of
    // how far a session still is from being the three things a run is built
    // from — the material, what is produced of it, and the stretch — and it
    // shrinks in place as those are taken off. There is deliberately no method
    // wrapping it: a named adapter with one caller is a thing to remember to
    // delete, and this is a thing that disappears by being emptied.
    this.#lastInputToken += 1;
    const inputToken = this.#lastInputToken;
    if (admittedInput) admittedInput.runTag = `${startIndex}r${inputToken}`;
    const buildCommand = admittedInput.original ? buildOriginalCommand : buildAdmittedCommand;
    const { args, safeIndex, startSeconds, cutTimes } = buildCommand({
      admittedInput,
      inputToken,
      baseUrl: this.#host.localBaseUrl,
      keyframes: session.file.keyframes,

      timeline: session.timeline,
      output: session.output,
      segmentFormat: session.segmentFormat,
      transcodeVideo: session.spec.transcodesVideo,
      transcodeAudio: session.spec.transcodesAudio,
      audioOnly: session.spec.carries === "audio-only",
      audioSeparate: this.#host.servesAudioSeparately(session),
      audioSourceTrackIndex: session.spec.audioSourceTrackIndex,
      rateControl: session.spec.video?.encode?.rateControl ?? null,
      startIndex,
      endIndex: admittedInput.original ? inputEnd
        : Number.isInteger(ordered?.to) ? ordered.to : runEnd >= startIndex ? runEnd : session.timeline.segmentCount - 1,
      videoEncoder: this.#host.videoEncoder,
      segmentDurationSec: this.#host.segmentDurationSec
    });

    // The exact command, every run. An encode failure is otherwise reported
    // with ffmpeg's message and nothing about what it was asked to do, and the
    // two are not always deducible from each other: 2026-08-04 a run died with
    // "Cannot write moov atom before AC3 packets" although both muxing paths
    // were verified to handle a copied AC-3 track on this very host, so the
    // arguments that run actually received are the missing evidence. One line
    // per run, and a run happens at most every few seconds.
    // Numbered, because a burst of seeks starts several runs in one second and
    // every line about them carries the SESSION id, which is the same for all.
    // Without a run number the command that failed cannot be told from the two
    // that succeeded around it — which is exactly the state the unexplained
    // `Cannot write moov atom before AC3 packets` was found in.

    // One directory for the output, and every run writes straight into it.
    //
    // Runs used to be kept apart by a directory each, because two of them
    // writing one segment name at the same time produce a file belonging to
    // neither — which was also the only reason a restart ever had to wait for
    // its predecessor to die. Intervals remove that by construction: a run is
    // given a stretch nobody else holds and stops at the end of it, so no two
    // runs ever want the same number. What is left of the old reason — a run
    // killed mid-piece leaving a partial file — is not a correctness problem
    // either, because the store serves a segment only once its closure is
    // proven, and it is cleared up when the run ends.
    const run = new EncodeRun({
      address: session.outputKey ?? session.id,
      encoder: this.#host.videoEncoder,
      from: safeIndex,
      to: runEnd,
      makingTag: admittedInput?.runTag ?? String(safeIndex),
      buildArgs: () => args,
      argsDescribed: describeFfmpegArgs(args),
      // Whether this run cuts at times we gave it. Decides how a segment is
      // judged finished — see getFileStream.
      usesExplicitCuts: Boolean(admittedInput || (cutTimes && cutTimes.length > 0)),
      startSeconds,
      totalSeconds: Number(session.file.durationSeconds) || null,
      spawn: (spawnArgs) =>
        spawn(this.#host.ffmpegBin, spawnArgs, {
          cwd: this.#host.segmentFiles.directoryFor(session.outputKey ?? "", session.segmentFormat),
          // A fourth channel: the encoder names every piece it has CLOSED on it,
          // which is the only proof a piece is whole.
          stdio: ["pipe", "pipe", "pipe", "pipe"]
        }),
      logger: this.#host.logger,
      // The film's last segment number, which is what tells "it reached the
      // end" from "its input dried up": ffmpeg exits zero for both and over a
      // torrent cannot tell them apart.
      lastSegmentIndex: () =>
        run.to,
      inputUnavailable: (message) => isInputUnavailable(message),
      onProgress: (report) => this.#noteRunProgress(session, run, report),
      indexOfName: (name) => session.segmentFormat.segmentIndexFromName(
        session.segmentFormat.servedNameOf?.(name) ?? name),
      // Why this encoder exists, recorded with its argument list. It used to be
      // handed to a separate `start` call; there is no separate call now.
      because,
      onClosed: (name, following) => {

        const index = session.segmentFormat.segmentIndexFromName(
          session.segmentFormat.servedNameOf?.(name) ?? name);
        // Encoder flush can create a partial file beyond its assigned interval.
        // It belongs to no requested output segment and must not condemn the
        // complete input or overwrite a neighboring run's segment.
        if (Number.isInteger(index) && (index < safeIndex || index > run.to)) return null;
        let bytes = null;
        if (admittedInput && session.segmentFormat.id === "fmp4" && session.spec.carries !== "audio-only" &&
          (admittedInput.original || session.spec.audio && !this.#host.servesAudioSeparately(session))) {
          try {
            const address = session.outputKey ?? "";
            const grid = session.timeline.published ?? session.timeline.boundaries;
            bytes = presentationSegment(this.#host.segmentFiles.closedBytesOf(address, name),
              following ? this.#host.segmentFiles.closedBytesOf(address, following) : null,
              { from: grid[index], to: grid[index + 1] });
          } catch (error) {
            this.#host.logger.warn(`encode: could not partition closed segment ${index}: ${error.message}`);
            throw error;
          }
        }
        const mediaRanges = this.#wholeClosedPiece(session, name, index, admittedInput, bytes);
        if (mediaRanges === false) throw Object.assign(new Error(`Closed piece #${index} has incomplete media.`),
          { code: "ERR_INCOMPLETE_MEDIA" });
        const published = this.#host.segmentFiles.publish(session.outputKey ?? "", name, session.segmentFormat, { mediaRanges, bytes });
        if (!published) throw new Error(`Closed piece #${index} could not be stored.`);
        return published;

      },
      onSpeedMeasured: () => this.#host.noteRunSpeedMeasured?.(session, run),
      onEnded: (ended) => {
        this.#runsByInputToken.delete(inputToken);
        if (admittedInput.original) {
          const reads = admittedInput.reads?.();
          if (reads) {
            const since = (at) => at ? `${at - run.startedAt}ms` : "never";
            this.#host.logger.info(`encode input of run #${run.from}..#${run.to} on ${session.outputKey}: ` +
              `${reads.count} read(s), ${reads.bytes} bytes, first at ${since(reads.firstAt)}, last at ${since(reads.lastAt)}, ` +
              `ended at ${Date.now() - run.startedAt}ms`);
          }
          this.#noteOpen(session, run, ended);
          admittedInput.release();
        }
        this.noteRunEnded(session, run, ended);
        this.#host.encodersChanged?.();
      }
    });
    if (admittedInput.original) {
      run.originalInput = admittedInput;
      run.inputFingerprint = admittedInput.fingerprint;
      // Every number of the stretch answers to its one key, so a failure
      // anywhere inside it is recorded against the stretch that was commanded.
      run.admittedInputKeys = new Map(Array.from({ length: inputEnd - safeIndex + 1 }, (_, offset) => [safeIndex + offset, inputKey]));
      // What this run can make is what its input holds, and that is what it
      // claims; the plan's longer bound would read as made by a run that
      // cannot reach it.
      run.inputThrough = inputEnd;
      run.process.stdin.end();
    } else if (admittedInput) {
      run.inputFingerprint = admittedInput.fingerprint;
      run.admittedInputKeys = new Map([[safeIndex, inputKey]]);
      let nextIndex = startIndex + 1;
      const canAppend = index => this.isLive(session) && run.isAlive &&
        this.#host.encodeOrchestrator.wantedSegmentsOn(session.outputKey).some(window => index >= window.from && index <= window.to) &&
        !this.liveRunsOf(session).some(other => other !== run && index >= other.from && index <= other.to) &&
        !this.#host.producedNumbers(session).includes(index);
      void writeAdmittedInput(admittedInput, run.process.stdin, { next: async () => {
        if (nextIndex > (ordered?.to ?? startIndex) || !canAppend(nextIndex)) return null;
        const next = await this.#host.encodeInputs.acquire(session, nextIndex, nextIndex);
        if (!next) return null;
        if (!canAppend(nextIndex)) { next.release(); return null; }
        run.admittedInputKeys.set(nextIndex, this.#inputFailures.key(next, inputParameters));
        run.to = nextIndex++;
        return next;
      } }).catch(error => {
        this.#host.logger.warn(`encode input output=${session.outputKey} segment=${safeIndex} write failed: ${error.message}`);
        run.process?.stdin?.destroy();
      });
    }
    this.#runsByInputToken.set(inputToken, run);
    this.#host.encodersChanged?.();
    // THE ONE FAULT THAT IS OTHERWISE SILENT, asked before this run produces a
    // frame. It lost its caller in a refactor on 2026-09-04 and had none until
    // 2026-09-15 — not by a decision, which is why it is back rather than gone.
    this.#warnIfRunLeavesTheInitBehind(session);

    this.#host.logger.info(
      `transcode ${session.id} encode-run #${safeIndex}..#${runEnd} from segment #${safeIndex} ` +
      `(+${Date.now() - restartEnteredAt}ms since the restart was asked for) ` +
        `(${formatSeconds(startSeconds)}) "${session.file.name}"`
    );
    // The four numbers a run is positioned by, said once, because their
    // disagreement is invisible everywhere else. The two tables are printed
    // side by side: while they differ, every cut of this run is off by the
    // difference, and nothing downstream can tell that from a bad index.
    const liveStart = this.#host.outputTimes.segmentStartTime(session, safeIndex);
    this.#host.logger.info(
      `transcode ${session.id} run #${safeIndex}..#${runEnd} positioned at ${startSeconds.toFixed(3)}s ` +
        `for boundary #${safeIndex} (published ${startSeconds.toFixed(3)}s, ` +
        `live ${liveStart.toFixed(3)}s, apart ${(liveStart - startSeconds).toFixed(3)}s), ` +
        `numbering from #${safeIndex}`
    );
    return run;
    } catch (error) {
      admittedInput?.release();
      if (inputKey && failedAdmittedInput({ ending: ENCODE_EXIT.FAILED,
        code: error.code ? null : 1, because: error.message },
        session.spec.transcodesVideo && this.#host.videoEncoder.kind !== "software")) {
        this.#inputFailures.note(session.outputKey, startIndex, inputKey, error.message);
        this.#host.invalidateWaits(session);
        this.#host.productionFailed(session);
      }
      throw error;
    }
  }

  /**
   * How long this run took to open its original input, for sizing the next
   * stretch: from its spawn to the name of its first closed piece, less what
   * encoding that piece costs at the run's speed — its own where it measured
   * one, else the output's. Nothing is noted where either is unknown.
   *
   * @param {object} session
   * @param {import("./EncodeRun.js").EncodeRun} run
   * @param {import("./EncodeRun.js").RunEnded} ended
   * @returns {void}
   */
  #noteOpen(session, run, ended) {
    const grid = session.timeline?.published ?? session.timeline?.boundaries;
    const pieceSeconds = Number(grid?.[run.from + 1]) - Number(grid?.[run.from]);
    const speed = run.speedX > 0 ? run.speedX : this.#host.encodeOrchestrator.speedOn?.(session.outputKey) ?? 0;
    if (!Number.isFinite(ended.firstNamedMs) || !(pieceSeconds > 0) || !(speed > 0)) return;
    const openSeconds = Math.max(0, ended.firstNamedMs / 1000 - pieceSeconds / speed);
    this.#host.encodeInputs?.noteOpen(session, openSeconds);
    this.#host.logger.info(`encode input of run #${run.from}..#${run.to} on ${session.outputKey}: opened in ` +
      `${openSeconds.toFixed(2)}s (first piece named at ${ended.firstNamedMs}ms, ${pieceSeconds.toFixed(3)}s of film at ${speed.toFixed(2)}x)`);
  }

  /**
   * Log a report from a run that still belongs to this output. The run owns the
   * clock and has already placed its relative ffmpeg time on the source
   * timeline.
   *
   * @param {HlsSession} session
   * @param {import("./EncodeRun.js").EncodeRun} run
   * @param {object} progress
   * @returns {void}
   */
  #noteRunProgress(session, run, progress) {
    if (!this.isLive(session) || !this.runsOf(session).includes(run)) {
      return;
    }
    if (run.progress.shouldLog(PROGRESS_LOG_INTERVAL_MS)) {
      this.#host.logger.info(
        `transcode ${session.id} "${session.file.name}" ${progress.percent.toFixed(1)}% ` +
          `(${formatSeconds(progress.processedSeconds)} / ${formatSeconds(progress.totalSeconds)})` +
          ` speed=${run.speedX > 0 ? `${run.speedX.toFixed(2)}x` : "n/a"}`
      );
    }
  }

  /**
   * What to do about a run that has ended.
   *
   * The run says how it ended and why; this decides what follows, which is a
   * question about the SESSION and the machine rather than about the process:
   * whether to condemn a hardware encoder, whether to wait for the input to
   * come back, whether a position has failed often enough to stop retrying it.
   *
   * An ending from a run the session has already replaced is not ignored — it
   * is simply not about this session's current run, so nothing that describes
   * the current run is written from it. That is what the identity check used to
   * be for, and it is one condition now instead of one at the head of every
   * handler.
   *
   * @param {HlsSession} session
   * @param {import("./EncodeRun.js").EncodeRun} run
   * @param {import("./EncodeRun.js").RunEnded} ended
   * @returns {void}
   */
  noteRunEnded(session, run, ended) {
    // First, and for every run whatever else follows: the stretch it held goes
    // back to the map. A run whose claim is never released tells the plan that
    // numbers nobody is making are being made, and nothing is ever started
    // there again.
    // WAS this run still the session's when it ended? Asked before it is
    // removed, because after the removal the question always answers "no" —
    // and it was asked after, so every line below this point was unreachable.
    //
    // Measured 2026-09-05 over both of the field host's log files: zero
    // occurrences of this handler's own `encode-run #… failed:` line and zero
    // of `fast failure at segment`, across every session this proxy has ever
    // run. So the fallback from a failed hardware encoder to software, the
    // retry when the torrent data goes away, the limit on retrying a position
    // that keeps failing, and the error line naming the ffmpeg command have all
    // been dead code — which is also why nothing ever stopped the restart loop
    // recorded in the field the same day.
    const wasCurrent = this.runsOf(session).includes(run);
    const inputFailed = run.admittedInputKeys && failedAdmittedInput(ended,
      session.spec.transcodesVideo && this.#host.videoEncoder.kind !== "software");
    if (inputFailed) {
      const index = run.head;
      const key = run.admittedInputKeys.get(index);
      if (key) {
        this.#inputFailures.note(session.outputKey, index, key, ended.because);
        this.#host.logger.warn(`encode: unchanged input will not be retried output=${session.outputKey} segment=${index} input=${key} reason=${ended.because}`);
      }
    }
    this.#host.encodeOrchestrator.noteEnded(ended);
    // What this admitted encode was seen to do, kept for the next time this
    // host prices the same mode (roadmap item 97, step 14). Whatever the
    // ending: a run that failed still ran at the speed it ran at, and the
    // segments it closed still carried what they carried.
    this.#host.observeEncodeEnded?.(session);
    // A stretch went back to the map, so what should be running has changed.
    // Said here rather than waited for: this is the moment it became true.
    this.planEncodersSoon();
    // ANYBODY ALREADY WAITING IS TOLD, and it is asked HERE because every
    // ending passes this line while the handlers below return one by one. It
    // used to be the last statement of this method, which the `SHORT` branch —
    // ffmpeg exiting 0 having produced less than the playlist promises —
    // returns before reaching. That ending is terminal (`ENDED_FAILED`), so a
    // request arriving after it is answered with the failure at once while a
    // wait that BEGAN before it sat out its whole deadline, or, where the page
    // states none, until the viewer disconnected.
    //
    // THE CONDITION IS THE OUTPUT'S ACTUAL STATE, not this run's ending.
    // `stateOf` answers from the LIVE runs and falls back to the last ending
    // only when none remain, so one run of several ending in failure wakes
    // nobody — something is still making it — and the last one does. Asked
    // after `noteEnded` has recorded the ending, so the woken request reads the
    // final state; and it re-reads the disk first, because a piece already made
    // is served whatever became of the encoder.
    if (this.hasFailed(session)) {
      this.#host.invalidateWaits(session);
      // A move to this output being prepared for a viewer waits for a segment
      // that nothing will now make, and no publication will ever end that wait.
      // This is the event that does (roadmap item 97, step 12).
      this.#host.productionFailed(session);
    }
    if (!this.isLive(session)) {
      this.forgetEncodingOfGone(session);
      return;
    }
    if (!wasCurrent) {
      // A run the session had already replaced. It has logged its own ending;
      // nothing about the session follows from it.
      return;
    }
    const lastError = this.lastErrorOf(session) || ended.because;
    if (ended.ending === ENCODE_EXIT.STOPPED || ended.ending === ENCODE_EXIT.GONE) {
      return;
    }
    if (ended.ending === ENCODE_EXIT.COMPLETE) {
      this.#host.logger.info(`transcode ${session.id} encode-run complete "${session.file.name}"`);
      return;
    }
    if (ended.ending === ENCODE_EXIT.SHORT) {
      // ffmpeg exits 0 both when it reaches the end of the file and when its
      // input simply stops producing bytes — over HTTP the two look identical
      // to it. Field 2026-08-05: the torrent's download died, the read ended,
      // and a run that had made 188 segments of 624 reported itself complete;
      // the player then consumed what was on disk and froze on the first
      // segment nobody was making. So the claim is checked against the playlist
      // we published, and a run that stopped short is a FAILURE that can be
      // restarted, not a finished file.
      this.#host.logger.error(
        `transcode ${session.id} encode-run #${ended.from}..#${ended.to} ended early: ` +
        `${ended.because} "${session.file.name}"`
      );
      return;
    }
    // Runtime safety net: if a hardware encode fails, downgrade this proxy to
    // software encoding for all sessions and restart this one, so playback is
    // never permanently broken by a hardware/driver issue.
    //
    // Asked only of a genuine encoder failure. It used to be asked of every
    // non-zero exit, so a run whose TORRENT DATA went away — which says nothing
    // whatever about the encoder — condemned a working NVENC or QuickSync to
    // software for the life of the process, and started an extra run at the old
    // index while it was at it.
    if (ended.ending === ENCODE_EXIT.FAILED && session.spec.transcodesVideo && this.#host.videoEncoder.kind !== "software") {
      const failed = this.#host.encoders.useSoftware();
      const failedEncoder = failed?.name ?? this.#host.videoEncoder.name;
      this.#host.logger.warn(
        `transcode ${session.id} hardware encoder ${failedEncoder} failed ` +
          `(${lastError}); falling back to software libx264, and every output named by ${failedEncoder} is closed`
      );
      // An output IS its format, and the encoder is part of it: pieces from
      // another encoder cannot be decoded with the header this output's viewers
      // already hold. So the outputs made by the failed encoder end here, and
      // the next request for that picture names a format built on the new one.
      //
      // THE ONE DISPOSAL THAT DOES NOT ASK WHETHER ASSIGNMENTS STILL HOLD IT, and
      // deliberately. Every other one asks, because a repeat of a request must be
      // answered by what answered it first. Here what answered it first has no
      // encoder that can go on making it: holding the output keeps only a name
      // whose next segment nobody will produce. A response already being sent is
      // not cut short by this — it reads from a file already opened.
      for (const other of [...this.#host.outputs.values()]) {
        if (other.spec.video?.encode?.encoder === failedEncoder) {
          void this.#host.disposeSession(other.id);
        }
      }
      this.planEncodersSoon();
      return;
    }
    // Losing the INPUT is not the session failing — it is the data not being
    // there YET. The torrent can be re-added and re-downloaded, so the honest
    // answer to the viewer is "still working", not an error screen. Field
    // 2026-08-06: a torrent evicted mid-seek took the film with it, the run
    // died on `File 0 not found`, the session went terminal and answered 500 to
    // every request from then on — although the swarm was there and the data
    // would have come back in seconds. The circuit breaker below stays for what
    // it was built for, a target that genuinely cannot be encoded; it must not
    // condemn a session whose data merely went away.
    if (ended.ending === ENCODE_EXIT.INPUT_LOST) {
      const inputState = this.#inputStateFor(session);
      inputState.inputRetryCount += 1;
      this.#host.logger.warn(
        `transcode ${session.id} encode-run #${ended.from}..#${ended.to} lost its input ` +
          `(${lastError}) (attempt ${inputState.inputRetryCount})`
      );
      // HOW LONG TO WAIT IS THE PLAN'S, and this says only what happened. The
      // delay used to be timed here, against the dead run, which the plan never
      // consults — so it placed a fresh run at the same spot as fast as ffmpeg
      // could fail there: 2432 starts in 23 minutes in the field 2026-09-12,
      // against a delay that had reached its 15 s ceiling long before. The
      // orchestrator holds it now, beside the decision it governs.
      if (run.state === ENCODE_RUN_STATE.RETRY_WAIT) {
        run.retryDue();
      }
      return;
    }
    // A run that exits THIS fast never did real work: it failed at the start
    // itself — opening the input, spawning the process — rather than
    // mid-stream. Consecutive fast failures at the SAME position are counted so
    // that whoever commands a start can stop commanding one that keeps failing.
    //
    // COUNTED AT EVERY POSITION, #0 included. It used to be counted only past
    // #0, because it was written for seek restarts and a seek is never to the
    // beginning. That left the one position the plan commands FIRST with no
    // count at all, and the plan re-commanding a start that cannot succeed is
    // an unbounded loop: measured 2026-09-05, ffmpeg failing to spawn produced
    // fifty passes of the plan before a probe stopped it, as fast as the
    // failures arrived.
    const failure = inputFailed ? { count: 0 } : this.#host.encodeOrchestrator.noteStartFailure(
      session.outputKey,
      ended.from,
      ended.livedMs
    );
    if (failure.count > 0) {
      this.#host.logger.warn(
        `transcode ${session.id} fast failure at segment #${ended.from} ` +
          `(${ended.livedMs}ms) — ${failure.count}/${failure.limit} consecutive`
      );
      if (failure.blocked) {
        this.#host.logger.error(
          `transcode ${session.id} will not be started at #${ended.from} again: ` +
          `${failure.count} starts there failed within ${failure.fastMs}ms each ` +
          `(${lastError}) "${session.file.name}"`
        );
      }
    }
    this.#host.logger.error(
      `transcode ${session.id} encode-run #${ended.from}..#${ended.to} failed: ${lastError}` +
        ` — ${this.#describeTrackSelection(session)}` +
        `\n  ffmpeg ${run.argsDescribed || "(command not recorded)"}`
    );
  }

  /**
   * What this run asked the source for, against what the source said it has.
   *
   * Written for one failure in particular: every `-map` this proxy builds ends
   * in `?`, so ffmpeg drops a mapping for an absent stream without complaint,
   * and a run whose mappings ALL drop produces a file with nothing in it —
   * reported as `Output file does not contain any stream`, exit 255. Read from
   * the exit code alone that is indistinguishable from any other refusal. Read
   * beside the tracks the file actually holds it is unmistakable, and it names
   * which side is wrong: an audio index past the end of the list is ours, no
   * streams at all is the source's.
   *
   * @param {HlsSession} session
   * @returns {string}
   */
  #describeTrackSelection(session) {
    const wanted = [];
    // Named exactly as the command line names them, second input included: a
    // refusal whose message describes a different mapping than the one that was
    // refused is the reading that cost a wrong diagnosis before.
    const audioInput = 0;
    const audioTrack = 0;
    if (session.spec.carries === "audio-only") {
      wanted.push(`audio 0:a:${audioTrack}`);
    } else if (this.#host.servesAudioSeparately(session)) {
      wanted.push("video 0:v:0");
    } else {
      wanted.push("video 0:v:0", `audio ${audioInput}:a:${audioTrack}`);
    }
    const counts = session.file.streamCounts;
    const held = counts
      ? `the source holds ${counts.video} video, ${counts.audio} audio, ` +
        `${counts.subtitle} subtitle` +
        (counts.other > 0 ? `, ${counts.other} other` : "")
      : "what the source holds was not recorded";
    return `this run asked for ${wanted.join(" + ")}, and ${held}`;
  }

  /**
   * Stop this session's encoder without replacing it.
   *
   * A variant nobody is watching must not go on encoding: the host has one
   * encoder's worth of capacity, and the whole point of switching quality
   * seamlessly is that the new rung gets it. The session itself stays — its
   * produced segments remain servable, and switching back restarts it from
   * where the viewer then is.
   *
   * @param {HlsSession} session
   * @param {string} reason - Named in the log; a stopped encoder is otherwise
   *   indistinguishable from one that died.
   * @returns {void}
   */
  stopEncodeRun(session, reason) {
    const running = this.liveRunsOf(session);
    if (running.length === 0) {
      return;
    }
    // Every run this session has going. The callers all mean the session's
    // encoding as a whole: a rung nobody is watching any more, a session being
    // disposed. A run that had already finished or failed is not among them,
    // which is what keeps a stop from erasing how it actually ended.
    for (const run of running) {
      // The run resumes itself if it was suspended — a stopped process does not
      // act on SIGTERM until it is continued — records the cause, and answers
      // its own exit. Nothing here has to null a field so that the exit is read
      // correctly, because there is no shared field left to misread.
      run.stop(reason);
      // Nothing is cleared up from here. What this run left open is under its
      // own working name, and the encoding layer removes it when the run's
      // ending reaches it — one place, and it needs neither the stretch nor the
      // init bytes this method used to fetch to judge a file by its contents.
    }
    this.#host.logger.info(`transcode ${session.id} ${running.length} encoder(s) stopped: ${reason}`);
  }

  /**
   * What moving the encoder BACKWARDS costs, said out loud when it happens.
   *
   * Nothing already written is lost — every run keeps its own directory and
   * {@link SegmentStore#pathOfName} serves the union of all of them
   * — so the price of a restart is not the files. It is two other things, and
   * neither was ever counted:
   *
   *  - **work done twice.** The new run begins at the target and encodes
   *    forward through segments the old run had already finished. ffmpeg cannot
   *    know they exist, so it makes them again.
   *  - **the viewer in front.** While the run walks back up to where it already
   *    was, nothing new is being made ahead of them, and their cushion drains.
   *
   * Both are what decides whether a session should be allowed a SECOND
   * concurrent run instead — roadmap item 64. That question cannot be answered
   * from taste, and this is the reading it needs: how often it happens at all,
   * how far back, and how much of the walk is a repeat.
   *
   * Nothing here is awaited by the caller. Everything below the call site is
   * the restart path, which is measured in milliseconds and has been worked on
   * twice to keep it that way; a reading that delays the thing it is reading
   * about is not a reading. The figures that MUST be taken before the new run
   * exists are taken synchronously, and only the file counting is left to run
   * on its own — against the directories that existed at this instant, so what
   * the new run is about to write cannot be counted as already there.
   *
   * @param {HlsSession} session
   * @param {number} startIndex - Where the new run will begin.
   * @returns {void}
   */
  #accountBackwardRestart(session, startIndex) {
    const previousStart = earliestRunStart(this.runsOf(session));
    if (!Number.isInteger(previousStart) || !Number.isInteger(startIndex) || startIndex >= previousStart) {
      // A first run, or one moving forward. Neither costs anything here: a
      // forward restart skips material it never made.
      return;
    }
    const processed = Number(this.progressOf(session)?.processedSeconds);
    const head = Number.isFinite(processed)
      ? Math.max(previousStart, this.#host.outputTimes.segmentIndexForTime(session, processed))
      : previousStart;
    // Bounded: a session an hour in has thousands of segments, and the count is
    // for a comparison, not an inventory.
    const last = Math.min(head, startIndex + BACKWARD_RESTART_SCAN_SEGMENTS);
    const accounting = this.#inputStateFor(session).backwardRestarts;
    accounting.count += 1;
    accounting.segmentsBack += previousStart - startIndex;
    accounting.worstBack = Math.max(accounting.worstBack, previousStart - startIndex);

    void (async () => {
      let alreadyOnDisk = 0;
      for (const index of this.#host.producedNumbers(session)) {
        if (index >= startIndex && index <= last) {
          alreadyOnDisk += 1;
        }
      }
      accounting.remade += alreadyOnDisk;
      this.#host.logger.info(
        `transcode ${session.id} moving the encoder BACK from #${previousStart} to #${startIndex} ` +
        `(head was #${head}): ${alreadyOnDisk} of the ${last - startIndex + 1} segment(s) it will walk through ` +
        `are already on disk and will be made again, and nothing is produced ahead of #${head} until it gets ` +
        `back there — ${accounting.count} backward restart(s) this session, worst ${accounting.worstBack} ` +
        `segment(s) back, ${accounting.remade} segment(s) remade in total (roadmap 64)`
      );
    })().catch(() => {
      // silent-ok: a reading that fails is not worth ending a restart over.
    });
  }
}
