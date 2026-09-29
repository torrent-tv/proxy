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
 * sessions belong to one file (`outputs`), the host's own readings, how many
 * encoders are running, what the file costs merely by being fetched, and whether
 * a slow run is short of the machine or short of the swarm. The learned costs it
 * holds itself: they are what an encoder taught it, and it is their only writer
 * and their only reader.
 *
 * **Learning them lives here too, and it did not until 2026-09-15.** The three
 * methods that turn a reading off a running encoder into a price were methods of
 * the session manager, writing into these maps from outside — so a fact had one
 * keeper and a different author, and the maps had to be public for it. They are
 * private now, and what leaves this class is an answer rather than a store.
 */

/**
 * Which cost a speed reading from this session is a measurement OF.
 *
 * Three encodes share one reading path and price three different things: a
 * soundtrack published on its own, a picture being re-encoded (whose reading
 * prices this source's DECODING, the encode half being known from the startup
 * benchmark), and a picture being copied (which prices copying).
 *
 * Exported because the routing is where the fault was: a rendition was refused
 * a reading by one guard while the call that would have priced it sat behind
 * another, so the soundtrack was charged at nothing no matter how long it ran.
 * A pure function makes that a test rather than a field session.
 *
 * @param {{ audioOnly?: boolean, transcodeVideo?: boolean }} session
 * @returns {"audio" | "decode" | "copy"}
 */
export function costKindForSession(session) {
  if (session?.spec?.carries === "audio-only") {
    return "audio";
  }
  return session?.spec?.transcodesVideo === true ? "decode" : "copy";
}

/** The narrowest stretch of uninterrupted encoding a speed may be read from. */
const LEARN_WINDOW_MIN_SEC = 3;

import { correctForAvailability } from "../available-share.js";
import { medianOf, movedBeyondScatter, READINGS_KEPT } from "../learned-median.js";
import { speedFromReadings } from "../encoder-readings.js";
import { contentionPenalty } from "../contention.js";
import { ENCODE_RUN_STATE, liveRunsOf, processCanBeSignalled } from "../encode-run-state.js";
import { canSustainOutput, chooseSoftwareEncodeSettings, speedBar } from "../hwaccel.js";
import { throughputAt } from "../throughput.js";
import { computeOutputDimensions, TRANSCODE_FPS } from "../args.js";
import { logger } from "../../../utils/logger.js";
import { qualityStateOf } from "./OutputQualityState.js";

export class EncodeCost {
  /**
   * What a soundtrack encoder has been seen to cost, by the key naming that
   * track. Written and read here and nowhere else.
   *
   * @type {Map<string, { costSec: number, readings: number[], version: number }>}
   */
  #audioCost = new Map();

  /** What copying a file's picture has been seen to cost. @type {Map<string, { costSec: number, readings: number[], version: number }>} */
  #copyCost = new Map();

  /** What decoding a file has been seen to cost. @type {Map<string, { costSec: number, readings: number[], version: number }>} */
  #decodeCost = new Map();

  /**
   * What each height was last predicted to do, kept so a session started at
   * that height can be compared against the prediction once it runs.
   *
   * @type {Map<number, number | null> | null}
   */
  lastPredictedByHeight = null;

  notePredictionFor(session, height) {
    qualityStateOf(session).predictedSpeedWhenOffered = this.lastPredictedByHeight?.get(height) ?? null;
  }

  // The last refusal printed. The offer is recomputed on the path that serves
  // every playlist, init and segment, and the figures behind it move every few
  // seconds — so the line is written when the ANSWER changes, not when it is
  // asked again.
  #lastOfferLine = "";

  #outputs;
  #host;
  #runningEncoders;
  #encodersRunningNow;
  #torrentCostSecFor;
  #boundBy;
  #runsFor;
  #stateFor;
  #progressFor;

  /**
   * @param {{
   *   outputs: import("../output/OutputCatalog.js").OutputCatalog,
   *   host: () => { benchmark: object[] | null, decodeModel: object | null, contentionPenalties: object | null, copySpeedX: number | null, availability: { known: boolean, share: number } | null, encoderKind: string | null },
   *   runningEncoders: () => number,
   *   encodersRunningNow: () => number,
   *   torrentCostSecFor: (session: object) => number,
   *   boundBy: (session: object) => Promise<"cpu" | "download" | "unknown">,
   *   runsFor: (output: object) => object[],
   *   stateFor: (output: object) => string,
   *   progressFor: (output: object, run: object | null) => object | null - The progress of that one run.
   * }} deps
   */
  constructor({ outputs, host, runningEncoders, encodersRunningNow, torrentCostSecFor, boundBy, runsFor, stateFor, progressFor }) {
    this.#outputs = outputs;
    // Asked at the moment of the question, not copied: the share of the machine
    // that is free is re-read every few seconds, and a copy taken when this was
    // built would price every later rung against a machine that has gone.
    this.#host = host;
    this.#runningEncoders = runningEncoders;
    this.#encodersRunningNow = encodersRunningNow;
    this.#torrentCostSecFor = torrentCostSecFor;
    // WHETHER A SLOW RUN IS SHORT OF THE MACHINE OR SHORT OF THE SWARM, which
    // this cannot answer and must not guess at: a run starved of torrent data
    // reports a speed that measures the swarm, and filed as a price it refuses
    // every quality step on the download's account. Asked of whoever holds the
    // torrent's readings; passed in, so this can still be exercised with plain
    // values and no swarm.
    this.#boundBy = boundBy;
    if (typeof runsFor !== "function") {
      throw new TypeError("EncodeCost requires runsFor");
    }
    if (typeof stateFor !== "function") {
      throw new TypeError("EncodeCost requires stateFor");
    }
    if (typeof progressFor !== "function") {
      throw new TypeError("EncodeCost requires progressFor");
    }
    this.#runsFor = runsFor;
    this.#stateFor = stateFor;
    this.#progressFor = progressFor;
  }

  /**
   * The key naming one soundtrack of one file.
   *
   * Static because it is the NAME of a thing this class stores, not a reading
   * about the machine — and because the offer's cache key needs it too, so a
   * caller that has a session can ask without holding an instance.
   *
   * @param {{ file: { key: string }, audioTrackIndex?: number }} session
   * @returns {string}
   */
  static audioKeyOf(session) {
    return `${session.file.key}:${session.spec?.audioSourceTrackIndex ?? 0}`;
  }

  /**
   * What decoding this file has been measured to cost, and how many times that
   * answer has changed.
   *
   * @param {string} fileKey
   * @returns {{ costSec: number, version: number } | null}
   */
  decodeCostFor(fileKey) {
    const entry = this.#decodeCost.get(fileKey);
    return entry ? { costSec: entry.costSec, version: entry.version } : null;
  }

  /**
   * How many times the price of COPYING this file has changed.
   *
   * Asked by the offer's cache key: everything the answer is derived from has
   * to be in what identifies it, or the menu keeps an answer computed before
   * anything was measured.
   *
   * @param {string} fileKey
   * @returns {number}
   */
  copyVersionFor(fileKey) {
    return this.#copyCost.get(fileKey)?.version ?? 0;
  }

  /**
   * How many times the price of this session's soundtrack has changed.
   *
   * @param {object} session
   * @returns {number}
   */
  audioVersionFor(session) {
    return this.#audioCost.get(EncodeCost.audioKeyOf(session))?.version ?? 0;
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
    const state = qualityStateOf(session);
    if (Number.isFinite(state.lastAloneSpeed) && state.lastAloneSpeed > 0) {
      return 1 / state.lastAloneSpeed;
    }
    // WHAT AN ENCODE OF THIS MODE WAS SEEN DOING HERE BEFORE, alone, on
    // material no easier than this (roadmap item 97, step 14): the slowest
    // such reading, on this configuration only. It refines the startup
    // prediction; with nothing seen, the prediction stands.
    const seen = Number(this.#host().observedAloneSpeed?.(session));
    if (Number.isFinite(seen) && seen > 0) {
      return 1 / seen;
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
      concurrentCostSec: 0,
      frame: { width, height }
    });
    return Number.isFinite(speed) && speed > 0 ? 1 / speed : 0;
  }

  /**
   * How fast this machine produces ONE output, in seconds of film per second.
   *
   * THERE IS ALWAYS AN ANSWER, and that is the point of this method. Every
   * decision in the encoding layer is made from arrivals — when would this
   * encoder reach that piece — and an arrival cannot be computed without a
   * speed. A speed that is missing is therefore not a smaller answer, it is no
   * answer at all: the plan then cannot tell a viewer who will be served from
   * one who will be left waiting, and the moment it happens is the cold start,
   * which is when the question matters most.
   *
   * Three sources, most specific first, and every one of them measured:
   *
   * 1. what a run on THIS output has been seen doing. It is this machine, this
   *    material and these settings, so nothing beats it;
   * 2. the startup benchmark, for an output whose picture is re-encoded: the
   *    preset readings and the decode model, applied to this output's own pixel
   *    rate. It exists before any viewer;
   * 3. the startup copy measurement, for an output whose picture is copied.
   *    Copying neither decodes nor encodes, so neither of the above describes
   *    it, and until it was measured this branch had no figure at all.
   *
   * @param {string} address - The output, as the encoding layer names it.
   * @returns {number} Seconds of film per second. Zero only where the host
   *   measured nothing at all, which is a broken startup rather than a state to
   *   plan around.
   */
  speedForOutput(address) {
    const outputs = this.#outputs.outputsOn(address);
    let measured = 0;
    for (const session of outputs) {
      const speed = Number(qualityStateOf(session).lastAloneSpeed);
      if (Number.isFinite(speed) && speed > measured) {
        measured = speed;
      }
    }
    if (measured > 0) {
      return measured;
    }
    for (const session of outputs) {
      if (session.spec.transcodesVideo) {
        const cost = this.#pictureCostOf(session);
        if (cost > 0) {
          return 1 / cost;
        }
        continue;
      }
      const copying = Number(this.#host().copySpeedX);
      if (Number.isFinite(copying) && copying > 0) {
        return copying;
      }
    }
    return 0;
  }

  /**
   * What one encoder on this output costs the machine, in seconds of work per
   * second of film, and what its file costs simply by being fetched.
   *
   * The unit the quality offer already judges every step in, so that "may one
   * more encoder run" and "may this height be offered" are the same arithmetic
   * and cannot disagree. Three kinds, priced from what each was seen doing:
   *
   * 1. a soundtrack, from its own measured speed;
   * 2. a copied picture, from its own measured speed, and otherwise from the
   *    startup copy measurement;
   * 3. a re-encoded picture, from what it did alone, and otherwise from the
   *    encode model applied to its own pixel rate.
   *
   * NULL WHEN NOTHING HAS PRICED IT, and never a guess: a soundtrack nobody has
   * measured yet contributes nothing, as it does to the offer. The caller says
   * so rather than inventing a figure.
   *
   * @param {string} address - The output, as the encoding layer names it.
   * @returns {{ costSec: number | null, fileKey: string, fileCostSec: number } | null}
   *   Null when no output of that address is here.
   */
  loadOfOutput(address) {
    const session = this.#outputs.outputsOn(address)[0] ?? null;
    if (!session) {
      return null;
    }
    const fileKey = session.file?.key ?? "";
    const fileCost = Number(this.#torrentCostSecFor(session));
    const fileCostSec = Number.isFinite(fileCost) && fileCost > 0 ? fileCost : 0;
    const measured = Number(qualityStateOf(session).lastAloneSpeed);
    if (Number.isFinite(measured) && measured > 0) {
      return { costSec: 1 / measured, fileKey, fileCostSec };
    }
    if (session.spec.carries === "audio-only") {
      const audio = this.#audioCost.get(EncodeCost.audioKeyOf(session));
      return { costSec: audio && audio.costSec > 0 ? audio.costSec : null, fileKey, fileCostSec };
    }
    if (!session.spec.transcodesVideo) {
      const copy = this.#copyCost.get(session.file.key);
      if (copy && copy.costSec > 0) {
        return { costSec: copy.costSec, fileKey, fileCostSec };
      }
      const copying = Number(this.#host().copySpeedX);
      return { costSec: Number.isFinite(copying) && copying > 0 ? 1 / copying : null, fileKey, fileCostSec };
    }
    const picture = this.#pictureCostOf(session);
    return { costSec: picture > 0 ? picture : null, fileKey, fileCostSec };
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
    for (const member of this.#outputs.familyOf(session)) {
      if (member === session || !processCanBeSignalled(this.#stateFor(member))) {
        continue;
      }
      if (member.spec.carries === "audio-only") {
        const audio = this.#audioCost.get(EncodeCost.audioKeyOf(member));
        if (!audio || !(audio.costSec > 0)) {
          return null;
        }
        cost += audio.costSec;
        continue;
      }
      if (!member.spec.transcodesVideo) {
        const copy = this.#copyCost.get(member.file.key);
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
    return this.#runningEncoders() > this.#outputs.familyOf(session).filter(
      (member) => processCanBeSignalled(this.#stateFor(member))
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
    for (const member of this.#outputs.familyOf(session)) {
      if (member.spec.carries === "audio-only" || !member.spec.transcodesVideo) {
        continue;
      }
      if (!processCanBeSignalled(this.#stateFor(member))) {
        continue;
      }
      const height = this.#outputs.variantHeightOf(member);
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
    for (const member of this.#outputs.familyOf(session)) {
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
      if (!processCanBeSignalled(this.#stateFor(member))) {
        continue;
      }
      if (member.spec.carries === "audio-only") {
        // A soundtrack encoder, priced from its own measured speed. Nothing is
        // charged for a track nobody has measured: a guess here refuses rungs
        // on arithmetic no one performed.
        const audio = this.#audioCost.get(EncodeCost.audioKeyOf(member));
        cost += audio && audio.costSec > 0 ? audio.costSec : 0;
        continue;
      }
      if (!member.spec.transcodesVideo) {
        const observed = this.#copyCost.get(member.file.key);
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
    for (const session of this.#outputs.familyOf(base)) {
      const speed = qualityStateOf(session).lastAloneSpeed;
      if (!session.spec.transcodesVideo || !Number.isFinite(speed)) {
        continue;
      }
      const height = this.#outputs.variantHeightOf(session);
      if (height > 0) {
        speeds.set(height, speed);
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
    // CALIBRATED WITH NOTHING QUALIFIED is not the same as not calibrated at
    // all (roadmap item 97, step 14): with no mode of this encoder shown to
    // work, nothing re-encoded is offered.
    const nothingQualified = Array.isArray(benchmark) && benchmark.length === 0;
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
      //
      // What nothing has priced is not offered either (roadmap item 97, step
      // 14): with no mode of this encoder qualified at startup, only a height
      // that needs no encoder — the copied source — or one an encoder is
      // already seen holding stays.
      return heights.filter((height) => {
        const measured = measuredHeights?.get(height) ?? null;
        if (measured !== null) {
          return measured >= 1;
        }
        return !nothingQualified || (!transcodeVideo && (height === sourceHeight || height === ownHeight));
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
        concurrentCostSec: concurrentBesideThis,
        frame: { width, height }
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

  /**
   * Take one reading off an encoder that is running, and file it as the price of
   * whatever that encoder is doing.
   *
   * Separate from the realtime budget, which asks a different question — should
   * the quality step down — and answers it only where it CAN step down. Most of
   * what is worth measuring is excluded by that: a rung at the foot of its
   * ladder, a step whose ladder is one rung long, a picture that is copied.
   * Measuring has no such preconditions.
   *
   * What it does refuse: a suspended encoder (ffmpeg reports a CUMULATIVE
   * speed, so a look-ahead pause is divided into it and the figure decays while
   * nothing is being encoded), a reading that has not moved since the last one,
   * and a run short of input, where what is short is the swarm rather than the
   * machine.
   *
   * @param {HlsSession} session
   * @returns {Promise<void>}
   */
  async learnFrom(session) {
    if (!session) {
      return;
    }
    if (
      this.#stateFor(session) === ENCODE_RUN_STATE.ENDED_FAILED ||
      liveRunsOf(this.#runsFor(session)).length === 0 ||
      this.#stateFor(session) === ENCODE_RUN_STATE.SUSPENDED
    ) {
      qualityStateOf(session).learnSample = null;
      return;
    }
    // Measured as a DELTA between two readings of a run that was going for the
    // whole interval, not from ffmpeg's cumulative `speed=`. The cumulative
    // figure counts every second the encoder spent SIGSTOPped by the look-ahead
    // cap in its denominator, and a copy spends most of its life there — it
    // reaches the cap in about fifteen seconds and then waits a minute. Read
    // that way a copy running at 8x reports 1.6x and falling, which would be
    // filed as the price of copying and refuse rungs on arithmetic that
    // measured a pause.
    const run = liveRunsOf(this.#runsFor(session))[0] ?? null;
    // The position is THAT run's own, read from the same process the sample is
    // stamped with. It used to be the output's progress, which is whichever
    // live run covers the viewer and updated last — so with two encoders on
    // one output a pair of readings could be two processes' positions filed
    // under one run, and the difference between them read as a speed.
    const processedSeconds = Number(this.#progressFor(session, run)?.processedSeconds);
    const takenAt = Date.now();
    const state = qualityStateOf(session);
    const previous = state.learnSample ?? null;
    // Stamped with the run it was taken from. A restart clears this sample, but
    // it then spends up to a second and a half making its directory and burying
    // its predecessor, and through that window the session still carries the
    // OLD process and the OLD position — so a sample taken there, paired with
    // the new run's first position, reads a twenty-minute seek as twenty
    // minutes of video produced in five seconds. Filed as this file's price it
    // admits every quality step there is. Comparing the serials is what the
    // twenty-second wait used to stand in for, and unlike the wait it costs no
    // readings on a short run.
    state.learnSample = { takenAt, processedSeconds, run };
    if (previous === null || !Number.isFinite(processedSeconds) || !Number.isFinite(previous.processedSeconds)) {
      return;
    }
    if (previous.run !== run) {
      return; // the pair straddles a restart and measures the seek, not the host
    }
    const speed = speedFromReadings(previous, { takenAt, processedSeconds }, LEARN_WINDOW_MIN_SEC);
    if (speed === null) {
      return;
    }
    // Recorded HERE, before any of the conditions below can discard the
    // reading, because the budget and the learning ask different questions of
    // it. Learning refuses a reading taken beside another encoder, since it
    // would file that encoder's work as this file's price; the budget wants
    // exactly what this run is doing right now, whatever else the machine is
    // doing beside it. Sharing the figure and not the conditions is what lets
    // the budget stop reading ffmpeg's cumulative average.
    state.recentSpeed = { speed, at: takenAt, run };
    const kind = costKindForSession(session);
    // A reading taken beside another encoder contains that other encoder's
    // work, and the budget ADDS the same work again when it predicts — so filed
    // as it stands the price is counted twice and grows with every reading.
    // Measured 2026-08-15 in the field: copying, whose truth is 7.9x, was
    // learned as 2.03x, and decoding, whose clips say 2.6x, as 0.87x. Every
    // step was then refused, the offer collapsed to the one copied height, and
    // the viewer lost the quality menu altogether.
    //
    // For a picture the answer is to wait for a moment alone, which comes often
    // enough. For a SOUNDTRACK it never comes: a rendition runs for exactly as
    // long as the picture it accompanies, so "alone" is a state it is never in,
    // and the price stayed unmeasured for ever — the hole this was meant to
    // close. Its share is instead recovered by subtracting what the machine is
    // already known to be spending, which is the same arithmetic that recovers
    // this source's decoding from a running encoder, and it is only done when
    // every other running encode HAS a price. Otherwise the unpriced work would
    // land in the soundtrack's account and refuse steps on it.
    let othersCostSec = 0;
    if (this.#runningEncoders() > 1) {
      if (kind !== "audio") {
        return;
      }
      const others = this.pricedConcurrentCost(session);
      if (others === null) {
        return; // something running has no price; nothing can be attributed
      }
      othersCostSec = others;
    }
    if (speed < 1 && await this.#boundBy(session) === "download") {
      return; // the torrent is what is short; this says nothing about the host
    }
    // What this encode did with the machine to itself — the one figure a live
    // reading is authority on, and what withdraws a quality step that has been
    // seen failing without letting it speak for steps nobody has run.
    //
    // Recorded only AFTER the download-bound check, and that order is the whole
    // point: a run starved of torrent data reports a speed that measures the
    // swarm. Stored first, as it was, that figure became this encode's price —
    // 0.3x reads as 3.33 s of work per second of video, more than the machine
    // has — and every other quality step was refused on the download's account.
    state.lastAloneSpeed = speed;
    // What the offer predicted for this very step, against what it then did
    // with the machine to itself. The prediction is corrected for the share of
    // the machine that was free at the time, so this ratio is the error that
    // remains AFTER that correction — which is the only way to tell whether a
    // stage of roadmap item 3 moved anything. Written when it changes by more
    // than a tenth, so a steady step says it once rather than every five
    // seconds.
    if (Number.isFinite(state.predictedSpeedWhenOffered) && state.predictedSpeedWhenOffered > 0) {
      const ratio = speed / state.predictedSpeedWhenOffered;
      const lastSaid = state.lastPredictionRatio;
      if (!Number.isFinite(lastSaid) || Math.abs(ratio - lastSaid) > 0.1) {
        state.lastPredictionRatio = ratio;
        logger.info(
          `prediction ${session.id.slice(0, 8)} ${session.output.encodeHeight || "source"}p: ` +
          `predicted ${state.predictedSpeedWhenOffered.toFixed(2)}x, measured ${speed.toFixed(2)}x ` +
          `(ratio ${ratio.toFixed(2)}; 1.00 would mean the arithmetic describes this machine)`
        );
      }
    }
    if (kind === "audio") {
      // What is left after the work that was already accounted for. `null` when
      // the subtraction leaves nothing positive, which means the reading says
      // less than the noise in it.
      const ownCostSec = 1 / speed - othersCostSec;
      if (!(ownCostSec > 0) || !Number.isFinite(ownCostSec)) {
        return;
      }
      await this.#learnAudioCost(session, 1 / ownCostSec);
      return;
    }
    if (kind === "decode") {
      this.#learnDecodeCost(session, speed);
      return;
    }
    await this.#learnCopyCost(session, speed);
  }

  async #learnCopyCost(session, speed) {
    if (this.#stateFor(session) === ENCODE_RUN_STATE.SUSPENDED) {
      return; // a suspended run reports a cumulative figure that is decaying
    }
    // Always asked, not only below realtime. A re-encode near 1x may be the
    // host; a COPY near 1x is a copy waiting for the torrent, because copying
    // is what a machine does at eight times realtime — and a starved reading
    // filed as the price of copying would refuse rungs on the download's
    // account.
    if (await this.#boundBy(session) === "download") {
      return;
    }
    const costSec = 1 / speed;
    if (!(costSec > 0) || !Number.isFinite(costSec)) {
      return;
    }
    const key = session.file.key;
    const known = this.#copyCost.get(key);
    const readings = [...(known?.readings ?? []), costSec].slice(-READINGS_KEPT);
    const median = medianOf(readings);
    if (!movedBeyondScatter(known?.costSec ?? null, median, readings)) {
      this.#copyCost.set(key, { ...known, readings });
      return;
    }
    this.#copyCost.set(key, { costSec: median, readings, version: (known?.version ?? 0) + 1 });
    logger.info(
      `transcode: ${session.file.name} copies at ${(1 / median).toFixed(2)}x on this host ` +
        `(median of ${readings.length}, latest ${speed.toFixed(2)}x)`
    );
  }

  async #learnAudioCost(session, speed) {
    if (this.#stateFor(session) === ENCODE_RUN_STATE.SUSPENDED) {
      return;
    }
    if (await this.#boundBy(session) === "download") {
      return;
    }
    const costSec = 1 / speed;
    if (!(costSec > 0) || !Number.isFinite(costSec)) {
      return;
    }
    const key = EncodeCost.audioKeyOf(session);
    const known = this.#audioCost.get(key);
    const readings = [...(known?.readings ?? []), costSec].slice(-READINGS_KEPT);
    const median = medianOf(readings);
    if (!movedBeyondScatter(known?.costSec ?? null, median, readings)) {
      this.#audioCost.set(key, { ...known, readings });
      return;
    }
    this.#audioCost.set(key, { costSec: median, readings, version: (known?.version ?? 0) + 1 });
    logger.info(
      `transcode: ${session.file.name} encodes audio track ${session.spec.audioSourceTrackIndex} at ` +
        `${(1 / median).toFixed(2)}x on this host (median of ${readings.length}, latest ${speed.toFixed(2)}x)`
    );
  }

  #learnDecodeCost(session, speed) {
    if (!(speed > 0)) {
      return;
    }
    if (!session.spec.transcodesVideo) {
      // Nothing to learn about decoding here, and nothing else either: the
      // caller routes a copy to #learnCopyCost and a rendition to
      // #learnAudioCost before this is ever reached. Routing them from here as
      // well put both calls behind a guard the caller had already made
      // (`transcodeVideo === true`), so neither could run.
      return;
    }
    if (this.#host().encoderKind !== "software") {
      return; // the benchmark that prices the encode half is libx264 only
    }
    const benchmark = this.#host().benchmark;
    if (!Array.isArray(benchmark) || benchmark.length === 0) {
      return;
    }
    const entry = benchmark.find((item) => item.preset === session.output.softwarePreset);
    const height = Number(session.output.encodeHeight) || 0;
    const width = Number(session.output.encodeWidth) || 0;
    const fps = Number(session.output.outputFps) || TRANSCODE_FPS;
    if (!entry || height <= 0 || width <= 0) {
      return;
    }
    // The preset's throughput AT THIS SIZE, as the startup calibration read it.
    const pixelsPerSec = throughputAt(entry, { width, height });
    if (!(pixelsPerSec > 0)) {
      return;
    }
    const encodeCostSec = (width * height * fps) / pixelsPerSec;
    const decodeCostSec = 1 / speed - encodeCostSec;
    if (!(decodeCostSec > 0)) {
      // The encode half already accounts for everything measured. Nothing is
      // left to attribute to decoding, and a zero or negative cost would say
      // decoding is free, which is a claim this reading cannot support.
      return;
    }
    const key = session.file.key;
    const known = this.#decodeCost.get(key);
    const readings = [...(known?.readings ?? []), decodeCostSec].slice(-READINGS_KEPT);
    const costSec = medianOf(readings);
    if (!movedBeyondScatter(known?.costSec ?? null, costSec, readings)) {
      // The same answer as before, by the readings' own scatter. Storing it
      // would bump the version and make every session recompute its offer,
      // which is asked for on the path that serves every playlist, init and
      // segment.
      this.#decodeCost.set(key, { ...known, readings });
      return;
    }
    this.#decodeCost.set(key, { costSec, readings, version: (known?.version ?? 0) + 1 });
    logger.info(
      `transcode: ${session.file.name} decodes at ${(1 / costSec).toFixed(2)}x on this host ` +
        `(median of ${readings.length}, latest ${(1 / decodeCostSec).toFixed(2)}x from ${height}p ` +
        `at ${speed.toFixed(2)}x, preset ${session.output.softwarePreset})`
    );
  }

  /**
   * The speed this run is making RIGHT NOW, or null when nothing recent enough
   * says.
   *
   * Read as the slope between two progress reports, never as ffmpeg's own
   * `speed=`. That figure is cumulative — output time over wall time since the
   * run began — so a run starved of torrent data early carries the average of
   * that starvation for the rest of its life. Measured 2026-08-21: a run whose
   * progress lines showed 1.30x at that moment (13 s of video in 10.02 s of
   * clock) still reported a cumulative 0.39x from four minutes on a ~100 KB/s
   * swarm, and the budget stepped the picture down on it. The same mistake was
   * found and solved once already — the startup decode benchmark reads the
   * slope between two progress reports for exactly this reason.
   *
   * @param {HlsSession} session
   * @param {number} now
   * @returns {number | null}
   */
  recentSpeedOf(session, now, withinMs) {
    return this.recentSpeedReadingOf(session, now, withinMs)?.speed ?? null;
  }

  /**
   * The newest measured speed from the output's current or most recent run.
   * Its measurement time lets the playback model project the observed trend
   * without imposing a separate freshness window.
   *
   * @param {HlsSession} session
   * @returns {{ speed: number, at: number } | null}
   */
  latestSpeedReadingOf(session) {
    const reading = qualityStateOf(session).recentSpeed;
    if (!reading || !this.#runsFor(session).includes(reading.run)) {
      return null;
    }
    return { speed: reading.speed, at: reading.at };
  }

  /**
   * The current output's measured production speed, with the time it was
   * measured. The caller can use the same observation in a trend without
   * treating repeated progress polls as new samples.
   *
   * @param {HlsSession} session
   * @param {number} now
   * @param {number} withinMs
   * @returns {{ speed: number, at: number } | null}
   */
  recentSpeedReadingOf(session, now, withinMs) {
    const reading = this.latestSpeedReadingOf(session);
    // Stale by whatever the asker calls stale — two of its own ticks, for the
    // budget loop, which takes a fresh reading every pass anyway. A reading
    // older than that is not about the machine as it stands.
    if (!reading || now - reading.at > withinMs) {
      return null;
    }
    return reading;
  }

  /**
   * Realtime budget (software encoder only): choose the output resolution AND
   * libx264 preset this host can encode faster than realtime, from the startup
   * benchmark. The ceiling is the client-requested box capped to the source
   * (never upscaled); the budget picks the highest resolution rung at or below
   * that ceiling that clears realtime × margin, then the best preset at that
   * resolution. On a weak host this downscales below the client target instead
   * of dropping into sub-realtime playback. Returns null when not applicable
   * (no video transcode, hardware encoder, or missing benchmark/source size) —
   * the encode then keeps the ceiling resolution and the default preset.
   *
   * @param {{ transcodeVideo: boolean, targetWidth: number, targetHeight: number, sourceWidth: number | null, sourceHeight: number | null, outputFps: number, source?: { megapixelsPerSecond: number, megabitsPerSecond: number } | null }} params
   * @returns {{ width: number, height: number, preset: string } | null}
   */
  chooseEncodeBudget({
    transcodeVideo,
    targetWidth,
    targetHeight,
    sourceWidth,
    sourceHeight,
    outputFps,
    source = null,
    requiredSpeed = null
  }) {
    if (!transcodeVideo || this.#host().encoderKind !== "software" || !this.#host().benchmark) {
      return null;
    }
    const ceiling = computeOutputDimensions(targetWidth, targetHeight, sourceWidth, sourceHeight);
    if (!ceiling) {
      return null;
    }
    return chooseSoftwareEncodeSettings(
      this.#host().benchmark,
      { width: ceiling.w, height: ceiling.h },
      outputFps,
      { decodeModel: this.#host().decodeModel, source, requiredSpeed }
    );
  }
}
