/**
 * @file What encoding this file costs THIS machine, and which heights follow.
 *
 * One subject: seconds of work per second of video. Everything here is that
 * question asked about something — a picture being re-encoded, a soundtrack, a
 * copy, everything running beside the rung being judged — and the last method
 * turns the answers into the list of heights the machine can hold.
 *
 * It decides what a viewer is offered, so being wrong in either direction costs
 * them: too generous and they are given a rung that runs below realtime, which
 * is a slideshow; too mean and they are refused quality the host could hold.
 *
 * Nothing here is chosen. Every figure is a measurement — the startup
 * benchmarks, what an encoder has since been seen doing on this very file, what
 * a second job costs on this host, what share of the machine is free — and where
 * a term has not been measured it contributes nothing rather than a guess.
 *
 * What it is given, and why each is passed rather than reached for: which
 * sessions belong to one file (`liveOutputs`), the host's own readings, which
 * key names a soundtrack, how many encoders are running, and what the file costs
 * merely by being fetched. The learned costs it holds itself: they are what an
 * encoder taught it, and it is their only reader.
 */

import { correctForAvailability } from "../available-share.js";
import { contentionPenalty } from "../contention.js";
import { TRANSCODE_FPS } from "../encode/args.js";
import { processCanBeSignalled, runStateOf } from "../encode/encode-run-state.js";
import { canSustainOutput, speedBar } from "../hwaccel.js";
import { logger } from "../../utils/logger.js";

export class EncodeCost {
  /**
   * What a soundtrack encoder has been seen to cost, by the key naming that
   * track. Written by whoever learns from a run; read here and nowhere else.
   *
   * Public for now because the three that learn are still methods of the
   * session manager. Moving them here is the next step, and until then two
   * objects must not each keep a copy of the same reading.
   *
   * @type {Map<string, { costSec: number, readings: number[], version: number }>}
   */
  audioCost = new Map();

  /** What copying a file's picture has been seen to cost. @type {Map<string, { costSec: number, readings: number[], version: number }>} */
  copyCost = new Map();

  /** What decoding a file has been seen to cost. @type {Map<string, { costSec: number, readings: number[], version: number }>} */
  decodeCost = new Map();

  /**
   * What each height was last predicted to do, kept so a session started at
   * that height can be compared against the prediction once it runs.
   *
   * @type {Map<number, number | null> | null}
   */
  lastPredictedByHeight = null;

  // The last refusal printed. The offer is recomputed on the path that serves
  // every playlist, init and segment, and the figures behind it move every few
  // seconds — so the line is written when the ANSWER changes, not when it is
  // asked again.
  #lastOfferLine = "";

  #liveOutputs;
  #host;
  #audioCostKey;
  #runningEncoders;
  #encodersRunningNow;
  #torrentCostSecFor;

  /**
   * @param {{
   *   liveOutputs: import("../output/LiveOutputs.js").LiveOutputs,
   *   host: () => { benchmark: object[] | null, decodeModel: object | null, contentionPenalties: object | null, availability: { known: boolean, share: number } | null },
   *   audioCostKey: (session: object) => string,
   *   runningEncoders: () => number,
   *   encodersRunningNow: () => number,
   *   torrentCostSecFor: (session: object) => number
   * }} deps
   */
  constructor({ liveOutputs, host, audioCostKey, runningEncoders, encodersRunningNow, torrentCostSecFor }) {
    this.#liveOutputs = liveOutputs;
    // Asked at the moment of the question, not copied: the share of the machine
    // that is free is re-read every few seconds, and a copy taken when this was
    // built would price every later rung against a machine that has gone.
    this.#host = host;
    this.#audioCostKey = audioCostKey;
    this.#runningEncoders = runningEncoders;
    this.#encodersRunningNow = encodersRunningNow;
    this.#torrentCostSecFor = torrentCostSecFor;
  }

  /**
   * What a running re-encode of the picture costs, in seconds of work per
   * second of video.
   *
   * Measured first: `lastAloneSpeed` is what this very rung did with the
   * machine to itself. Failing that, the encode model that decides every rung —
   * the same benchmark, the same decode term — applied to this rung's own pixel
   * rate. There is no third answer: a rung whose cost cannot be derived at all
   * contributes nothing rather than a number somebody invented.
   *
   * @param {HlsSession} session
   * @returns {number}
   */
  #pictureCostOf(session) {
    if (Number.isFinite(session.lastAloneSpeed) && session.lastAloneSpeed > 0) {
      return 1 / session.lastAloneSpeed;
    }
    const benchmark = this.#host().benchmark;
    const width = Number(session.output.encodeWidth) || 0;
    const height = Number(session.output.encodeHeight) || 0;
    const fps = Number(session.output.outputFps) || TRANSCODE_FPS;
    if (!Array.isArray(benchmark) || benchmark.length === 0 || width <= 0 || height <= 0) {
      return 0;
    }
    const { speed } = canSustainOutput({
      benchmark,
      decodeModel: this.#host().decodeModel,
      source: session.file.decode ?? null,
      outputPixelsPerSec: width * height * fps,
      observedDecodeCostSec: null,
      concurrentCostSec: 0
    });
    return Number.isFinite(speed) && speed > 0 ? 1 / speed : 0;
  }

  /**
   * What everything OTHER than this session is costing right now, or null when
   * any of it is unpriced.
   *
   * Used to recover a soundtrack's own share from a reading taken beside the
   * picture — the only kind of reading a rendition ever gives, since it runs
   * exactly as long as the picture does. Refusing to answer when something
   * running has no price is the point: unpriced work would otherwise be
   * attributed to the soundtrack, and an overpriced soundtrack refuses quality
   * steps the host could actually hold.
   *
   * @param {HlsSession} session
   * @returns {number | null}
   */
  pricedConcurrentCost(session) {
    let cost = 0;
    for (const member of this.#liveOutputs.familyOf(session)) {
      if (member === session || !processCanBeSignalled(runStateOf(member))) {
        continue;
      }
      if (member.audioOnly === true) {
        const audio = this.audioCost.get(this.#audioCostKey(member));
        if (!audio || !(audio.costSec > 0)) {
          return null;
        }
        cost += audio.costSec;
        continue;
      }
      if (member.transcodeVideo !== true) {
        const copy = this.copyCost.get(member.file.key);
        if (!copy || !(copy.costSec > 0)) {
          return null;
        }
        cost += copy.costSec;
        continue;
      }
      const picture = this.#pictureCostOf(member);
      if (!(picture > 0)) {
        return null;
      }
      cost += picture;
    }
    // Encoders outside this family are counted by number only — there is no
    // price to look up for another film's session — so a reading taken while
    // one is running cannot be attributed either.
    return this.#runningEncoders() > this.#liveOutputs.familyOf(session).filter(
      (member) => processCanBeSignalled(runStateOf(member))
    ).length
      ? null
      : cost;
  }

  /**
   * What each height of this family is costing RIGHT NOW, for the heights an
   * encoder is actually running at.
   *
   * Exists so a height can be judged against what the machine spends on
   * everything else — a step being warmed is running while it is judged, and
   * charged its own cost it refuses itself.
   *
   * @param {HlsSession} session
   * @returns {Map<number, number>}
   */
  runningCostByHeight(session) {
    /** @type {Map<number, number>} */
    const byHeight = new Map();
    for (const member of this.#liveOutputs.familyOf(session)) {
      if (member.audioOnly === true || member.transcodeVideo !== true) {
        continue;
      }
      if (!processCanBeSignalled(runStateOf(member))) {
        continue;
      }
      const height = this.#liveOutputs.variantHeightOf(member);
      if (height > 0) {
        byHeight.set(height, (byHeight.get(height) ?? 0) + this.#pictureCostOf(member));
      }
    }
    return byHeight;
  }

  /**
   * Seconds of work per second of video this family is ALREADY committed to,
   * beside any rung being considered.
   *
   * Every encoder of the family that is actually running: the picture, whether
   * it is copied or re-encoded, and each audio rendition. The rung the viewer
   * is watching and the source's own copied height are never withdrawn by the
   * caller, so charging for the encoder that serves them cannot strand anyone —
   * what it does is stop the NEXT rung being offered as though the machine were
   * idle, which is what the field disproved on 2026-08-15.
   *
   * Anything whose cost is neither measured nor derivable contributes nothing.
   * A guess here would refuse rungs on arithmetic nobody performed.
   *
   * @param {HlsSession} session
   * @returns {number}
   */
  committedCostOf(session) {
    let cost = 0;
    for (const member of this.#liveOutputs.familyOf(session)) {
      // Only what still HAS an encoder. A quality step the viewer left keeps
      // its session and its segments but not a process, and it produces nothing
      // for anybody — charging the machine for it would refuse steps on work
      // nobody is doing.
      //
      // A SUSPENDED encoder is charged, deliberately, and this is not the same
      // question. The unit here is seconds of work per second of VIDEO, not per
      // second of wall clock: a copy running at 8x costs 0.125 s/s whether it
      // is producing right now or parked by the look-ahead cap, because over an
      // hour of watching it still produces an hour of video. Suspension is how
      // that cost is spread, not a discount on it — and pricing a parked
      // encoder at zero would offer a step on the strength of a pause that ends
      // the moment the viewer catches up.
      if (!processCanBeSignalled(runStateOf(member))) {
        continue;
      }
      if (member.audioOnly === true) {
        // A soundtrack encoder, priced from its own measured speed. Nothing is
        // charged for a track nobody has measured: a guess here refuses rungs
        // on arithmetic no one performed.
        const audio = this.audioCost.get(this.#audioCostKey(member));
        cost += audio && audio.costSec > 0 ? audio.costSec : 0;
        continue;
      }
      if (member.transcodeVideo !== true) {
        const observed = this.copyCost.get(member.file.key);
        cost += observed && observed.costSec > 0 ? observed.costSec : 0;
        continue;
      }
      // A picture being RE-ENCODED beside the rung being judged — the warm-up
      // that makes a quality switch seamless is two encoders by design, and
      // that overlap is exactly where the field measured 0.504x on a rung
      // predicted at 1.58x (2026-08-15). Priced by what it has been SEEN doing
      // when it had the machine to itself, and otherwise by the same model that
      // judges every rung — which is a prediction, not a guess.
      cost += this.#pictureCostOf(member);
    }
    // And what the FILE costs simply by being fetched and delivered while it is
    // watched: a viewer consumes it at its own byte rate, and every one of
    // those bytes is downloaded, verified and pushed by this process. Priced
    // per megabyte from readings taken while nothing was encoding, so the two
    // measurements do not contain each other.
    cost += this.#torrentCostSecFor(session);
    return cost;
  }

  /**
   * The speed each rung of this family was last seen running at, when it was
   * running alone.
   *
   * A rung that has been watched failing is refused on that evidence; a rung
   * nobody has run says nothing about itself and is judged by the startup
   * measurement like any other.
   *
   * @param {HlsSession} base
   * @returns {Map<number, number>}
   */
  measuredRungSpeeds(base) {
    /** @type {Map<number, number>} */
    const speeds = new Map();
    for (const session of this.#liveOutputs.familyOf(base)) {
      if (session.transcodeVideo !== true || !Number.isFinite(session.lastAloneSpeed)) {
        continue;
      }
      const height = this.#liveOutputs.variantHeightOf(session);
      if (height > 0) {
        speeds.set(height, session.lastAloneSpeed);
      }
    }
    return speeds;
  }

  /**
   * Drop the rungs this host cannot hold at realtime.
   *
   * Every rung below the source height is a full re-encode — decode the whole
   * source, encode a smaller picture — and on a weak host that is dearer than
   * the copy it replaces. Measured 2026-08-14: 1080p was copied at 7.8-8.9x
   * while the offered 240p rung ran at 0.388-0.947x, its first segment took
   * 30 s and later ones were held 22 s, so choosing a LOWER quality is what
   * broke playback. A rung that cannot be produced faster than it is watched
   * must not be offered at all.
   *
   * The session's OWN height always stays: an encoder is already producing it,
   * and removing it would point the player at a rung nobody is encoding.
   *
   * @param {{ heights: number[], ownHeight: number, sourceWidth: number, sourceHeight: number, fps: number, source: { megapixelsPerSecond: number, megabitsPerSecond: number } | null, transcodeVideo: boolean }} params
   * @returns {number[]}
   */
  sustainableHeights({
    heights,
    ownHeight,
    // Every height a viewer has on screen, not one: two viewers of one picture
    // can be on two rungs, and a rung is never withdrawn while somebody is
    // watching it — their next segment would 404 on a stream that is playing.
    playingHeights = new Set(),
    sourceWidth,
    sourceHeight,
    fps,
    source,
    transcodeVideo,
    observedDecodeCostSec = null,
    concurrentCostSec = 0,
    runningCostByHeight = null,
    measuredHeights = null,
    requiredSpeed = null
  }) {
    // What this file's own supply demands, measured by its reader — and
    // realtime while it has not been measured. Read once here so the line that
    // reports a refusal names the figure it refused against.
    const bar = speedBar(requiredSpeed);
    const benchmark = this.#host().benchmark;
    if (!Array.isArray(benchmark) || benchmark.length === 0 || sourceHeight <= 0 || sourceWidth <= 0) {
      // Nothing to predict WITH, so nothing is predicted. What has been SEEN
      // still counts: a rung measured running below realtime is withdrawn here
      // too, because the evidence for it does not come from the benchmark. This
      // return used to hand back every height including one measured at 0.4x —
      // found by a check written when this moved out of the session manager,
      // 2026-09-05.
      // The rung on screen is not exempt, for the same reason it is not exempt
      // below: keeping one measured at 0.007x stalls the viewer with no path to
      // a faster rung, which is what the field showed on 2026-08-31.
      return heights.filter((height) => {
        const measured = measuredHeights?.get(height) ?? null;
        return measured === null || measured >= 1;
      });
    }
    /** @type {number[]} */
    const kept = [];
    /** @type {string[]} */
    const dropped = [];
    // What each height was predicted to do on THIS machine, kept so a session
    // started at that height can be compared against it once it runs. The
    // manager holds the last answer, because the offer is computed on the path
    // that serves every request while a session is created elsewhere.
    /** @type {Map<number, number | null>} */
    const predictedByHeight = new Map();
    for (const height of heights) {
      // A rung this session has actually been seen running below realtime is
      // withdrawn on that evidence, whatever the prediction says. This is the
      // one thing a live reading is authority on: itself. It is asked before
      // any exemption so a rung measured failing while on screen does not stay
      // offered because it was on screen when measured — otherwise a step
      // would ask for the one rung this machine has been measured failing at,
      // then fail again, then step down, for ever. A copied source height
      // cannot reach this: `#measuredRungSpeeds` records only sessions that
      // re-encode, so a copy has no reading to be withdrawn on, which is right
      // — it costs no encoder.
      const measured = measuredHeights?.get(height) ?? null;
      if (measured !== null && measured < 1) {
        // Even the rung on screen is withdrawn on measured failure: keeping it
        // would 404 the next segment, but keeping a rung measured at 0.007x
        // (field 2026-08-31, 4K HEVC on CM4) stalls the viewer for minutes with
        // 0.04s buffered and no way to downgrade because every other rung is
        // also dropped. Withdrawing it lets the offer become empty, which the
        // caller turns into an error the viewer can act on (try another proxy
        // or a lower source) instead of an endless spinner.
        dropped.push(`${height}p=${measured.toFixed(2)}x measured`);
        continue;
      }
      // The rung ON SCREEN is kept only when it has not been measured failing
      // above. Keeping a rung measured at 0.007x would stall the viewer with
      // no path to a faster rung, which is what the field showed.
      if (playingHeights.has(height)) {
        kept.push(height);
        continue;
      }
      // The height an encoder is ALREADY producing, and the source's own height
      // when the FAMILY serves it by copy — neither has to be predicted,
      // because it is happening. A copied rung costs no encoder at all, so no
      // measurement of this host can ever be a reason to withdraw it, and the
      // whole point of it is that it is where a viewer on a rung the machine
      // cannot hold goes back to. `transcodeVideo` here is the base's, not the
      // asking session's: a 240p rung re-encodes, and reading its own flag is
      // what withdrew a copied 1080p in the field on 2026-08-15.
      //
      // A source height that would have to be RE-ENCODED is a prediction like
      // any other: on a session whose budget stepped down to 480p, the source's
      // 1080p is neither copied nor being produced, and keeping it unpriced
      // would offer exactly the kind of rung this refuses. Likewise, a rung
      // this session is already producing at 0.007x (field 2026-08-31, 4K HEVC
      // on CM4, 0.1x at 23:45 and 0.007x at 06:57) is not sustainable just
      // because it is running — keeping it offered no path to a faster rung
      // and left the viewer at 0.04s buffered with no downgrade.
      if (
        (height === ownHeight && !transcodeVideo) ||
        (height === sourceHeight && !transcodeVideo)
      ) {
        kept.push(height);
        continue;
      }
      const width = Math.round(((sourceWidth / sourceHeight) * height) / 2) * 2;
      // What the machine is spending on everything EXCEPT this height. A step
      // being warmed for a switch is already running while it is judged, so its
      // own cost is inside the committed total — and charged against itself it
      // is counted twice. Measured against the field figures of 2026-08-15
      // that is 1.83x against 1.03x: below the margin, so the step the viewer
      // had just asked for was dropped from the offer by the act of warming it,
      // and its next segment answered 404 on a stream that was playing.
      const concurrentBesideThis = Math.max(
        0,
        concurrentCostSec - (runningCostByHeight?.get(height) ?? 0)
      );
      const { speed } = canSustainOutput({
        benchmark,
        decodeModel: this.#host().decodeModel,
        source,
        outputPixelsPerSec: width * height * fps,
        observedDecodeCostSec,
        concurrentCostSec: concurrentBesideThis
      });
      // The benchmark behind that figure was taken on a QUIET host — one
      // ffmpeg and nothing else. The machine a step will actually run on is
      // also running the kernel, the container and whatever else its owner
      // does, and on the addon host that was measured at 99 % busy with a
      // quarter of it unattributed. Only the unattributed part is charged
      // here: our own encoders are already in `concurrentBesideThis` and the
      // proxy's own work is already priced per megabyte moved.
      // Two corrections, and they are different facts about the machine. The
      // availability share removes work nobody has been charged for; the
      // contention penalty says what OUR OWN second job costs, because the
      // budget adds independent prices and this host does not behave that way
      // — the same work measured 2.6× dearer beside one encoder and 3.7×
      // beside two (2026-08-18). `concurrentBesideThis` already counts what is
      // committed; this multiplies by how badly running at all together goes.
      const othersRunning = concurrentBesideThis > 0 ? this.#encodersRunningNow() : 0;
      const { penalty } = contentionPenalty(othersRunning, this.#host().contentionPenalties);
      const onThisMachine = correctForAvailability(
        speed === null ? null : speed / penalty,
        this.#host().availability
      );
      // Kept against the step's own session, so that when it runs the field
      // says what the prediction was worth. Without this the only comparison
      // available is between two figures written minutes apart in different
      // lines of the log.
      predictedByHeight.set(height, onThisMachine);
      if (onThisMachine !== null && onThisMachine >= bar) {
        kept.push(height);
        continue;
      }
      dropped.push(`${height}p=${onThisMachine === null ? "n/a" : `${onThisMachine.toFixed(2)}x`}`);
    }
    // Written when the ANSWER changes, not when the answer is recomputed. This
    // is asked on the path that serves every playlist, init and segment, and
    // the figures behind it move every five seconds — so an unconditional line
    // here is roughly seven hundred identical lines an hour into a forwarder
    // that holds five hundred, which buries whatever is worth reading.
    if (dropped.length > 0) {
      const line =
        `transcode: not offering ${dropped.join(" ")} — below ${bar.toFixed(2)}x ` +
        (Number.isFinite(requiredSpeed) && requiredSpeed > 1
          ? "(the speed this file's own interruptions demand) "
          : "(realtime, this file's supply not measured yet) ") +
        // Said with the figures, because a step refused on a busy machine and
        // one refused on an idle machine are different facts about the host.
        (this.#host().availability?.known
          ? `on a machine with ${Math.round(this.#host().availability.share * 100)}% to spare `
          : "") +
        `(offering ${kept.map((height) => `${height}p`).join(" ")})`;
      if (line !== this.#lastOfferLine) {
        this.#lastOfferLine = line;
        logger.info(line);
      }
      this.lastPredictedByHeight = predictedByHeight;
    } else {
      this.lastPredictedByHeight = predictedByHeight;
      this.#lastOfferLine = "";
    }
    return kept;
  }
}
