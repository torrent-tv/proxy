/**
 * @file The quality budget of the outputs that exist: when a picture is asked to
 * move to another height, when its bitrate is capped by a viewer's measured link,
 * and what the player is told to follow.
 *
 * Moved out of the session manager whole (plan step 3). What it needs of the
 * rest of the proxy is the host object it is built with, and nothing else.
 */

import { stat } from "node:fs/promises";
import { logger } from "../../../utils/logger.js";
import { ENCODE_RUN_STATE } from "../encode-run-state.js";
import { maxrateKbpsFor, nominalKbpsForHeight, nominalKbpsForMaxrate } from "../hwaccel.js";
import { linkCouldCarry, LINK_SAFETY } from "./link-budget.js";

// Realtime budget — runtime downswitch (software encoder only). Periodically
// check each active software-transcode session's ffmpeg `speed`; when it stays
// below realtime for a sustained window AND the input is not download-starved
// (so the limit is the encoder, not the torrent), step down one resolution rung
// and restart at the current segment. Conservative so it never thrashes: a long
// sustained window, a post-action cooldown, a step cap, and no upswitch (v1).
export const BUDGET_CHECK_INTERVAL_MS = 5_000;
// Speed below this (cumulative ffmpeg average) counts as "slow"; recovery to
// realtime resets the slow window (hysteresis).
const BUDGET_SPEED_SLOW = 0.95;
const BUDGET_SPEED_OK = 1.0;
// Slow must persist this long before a downshift (absorbs warm-up + brief
// complex scenes; the cumulative average won't dip this long unless the host
// genuinely can't keep up).
const BUDGET_SUSTAINED_MS = 15_000;
// After a step, wait this long before another (lets the new picture settle and
// a fresh slope build).
const BUDGET_ACTION_COOLDOWN_MS = 30_000;
// The step BACK UP has to be slower to fire than the step down, or the two
// take turns: a rung that has just been left is by definition one the arithmetic
// still thinks this machine can hold, so it would be asked for again as soon as
// the cooldown expired. Four times the down window is a statement about how long
// a machine has to look able before it is believed, not a measured quantity, and
// it is written here rather than dressed up as one.
const BUDGET_UP_SUSTAINED_MS = 60_000;
// How long a request to the player to change variant stands before it is
// treated as unanswered. A progress report is polled about every 1.5 s and the
// switch itself needs the rung warmed, which is the cold start this host
// measures; this is long enough for both and short enough that a browser which
// cannot honour the request (no master playlist, a viewer on a manual pick) is
// not chased for the rest of the film.
const QUALITY_ASK_TTL_MS = 45_000;
// The input counts as "keeping up" when the torrent downloads at least this
// multiple of the source's average byte rate. Below it (and not yet fully
// downloaded), a low speed is download-bound, not CPU-bound → do NOT downscale.
const BUDGET_DOWNLOAD_OK_FACTOR = 1.0;
// Viewer-link adaptation (adaptive bitrate, part b). The browser reports its
// measured data-channel throughput + buffered seconds every ~10 s; when a
// FRESH report shows the usable link (reported × safety margin) sustainedly
// below the observed produced bitrate AND the viewer's buffer is low, the
// budget loop bounds the encode's bitrate by that measured link — same
// machinery and cooldown as the CPU trigger. On a COPIED picture there is no
// encoder to bound, so the same finding asks the player for a re-encoded rung
// instead. Which of the two, and whether a viewer's own pick may be moved at
// all, is decided where the viewer's choice lives: in the browser, which
// honours the request only in automatic mode.
// Deficit must persist this long before acting (absorbs one slow segment).
const LINK_SLOW_WINDOW_MS = 15_000;
// Only act while the viewer is actually running dry; a comfortable buffer
// (e.g. paused playback filling ahead) suppresses the trigger.
const LINK_LOW_BUFFER_SEC = 10;
// Observed produced bitrate: average over this many recently completed
// segments (the newest file on disk may still be written and is excluded).
const LINK_OBSERVED_SEGMENTS = 5;

export class QualityController {
  /** What this reads and asks of the rest of the proxy, and nothing else. @type {object} */
  #host;

  /** A budget pass is under way; a timer tick that lands meanwhile is skipped. */
  #tickRunning = false;

  /**
   * @param {object} host - `isLive`, `liveConsumers`, `liveRunsOf`, `producedNumbers`, `reportHostLoad`, `runStateOf`, `sampleDownloadRates`, `stopEncodeRun`, `planEncodersSoon`, `encodeCost`, `getSourceStats`, `outputs`, `qualityOffer`, `segmentDurationSec`, `segmentStore`, `videoEncoder`
   */
  constructor(host) {
    this.#host = host;
  }

  /**
   * One pass of the quality budget: learn what this host is doing with each
   * running encode, and act on it.
   *
   * Public because it is an operation with a name, not an implementation
   * detail of a timer — and because a loop that decides what the viewer sees
   * and can only be reached through `setInterval` is a loop nothing can check.
   * The timer calls exactly this.
   *
   * @returns {Promise<void>}
   */
  async runQualityBudgetOnce() {
    void this.#host.reportHostLoad();
    // One tick at a time. Both halves await torrent statistics per source, so a
    // slow or stuck answer would otherwise let the next tick in behind it — two
    // passes over the same sessions, taking the same reading twice and acting
    // on the same speed twice, and an earlier tick's rates landing on top of a
    // later tick's.
    if (this.#tickRunning === true) {
      return;
    }
    this.#tickRunning = true;
    try {
      // Taken whatever the encoder is: the torrent's price is charged against
      // this rate on every host, not only on the ones that re-encode.
      await this.#host.sampleDownloadRates();
      if (this.#host.videoEncoder?.kind !== "software") {
        return;
      }
      await this.#realtimeBudgetPass();
    } finally {
      this.#tickRunning = false;
    }
  }

  async #realtimeBudgetPass() {
    const now = Date.now();
    for (const session of this.#host.outputs.values()) {
      // What this file costs to decode is learned from EVERY encoding session,
      // before any of the budget's own conditions are consulted. Those exist to
      // decide whether to step the quality, and they exclude most of what is
      // worth measuring: a rung already at the foot of its ladder has nowhere
      // to step, and a 240p variant IS its whole ladder — which is exactly the
      // rung the field measured at 0.95x on 2026-08-15, learning nothing from
      // three minutes of it because the loop had already skipped the session as
      // un-actionable.
      await this.#host.encodeCost.learnFrom(session);
      if (
        !session ||
        !this.#host.isLive(session) ||
        this.#host.runStateOf(session) === ENCODE_RUN_STATE.ENDED_FAILED ||
        // Nothing is encoding, so there is no speed to judge. A variant the
        // viewer has switched away from is left in exactly this state, and its
        // last recorded speed would otherwise buy it a step — which restarts
        // the encoder it was just stopped for.
        this.#host.liveRunsOf(session).length === 0 ||
        // A soundtrack published on its own carries no picture, so no quality
        // step is its to make; its price is learned above and that is all.
        session.spec.carries === "audio-only"
      ) {
        continue;
      }
      // The cooldown belongs to the FAMILY, not to one rung of it. A step asks
      // the player to move to another session, so the rung that acted and the
      // rung that then runs are different objects, and a cooldown kept on each
      // separately would let the new one act again immediately.
      if (now - this.#host.outputs.pictureOf(session).budgetLastActionAt < BUDGET_ACTION_COOLDOWN_MS) {
        continue;
      }
      // Viewer-link deficit first (adaptive bitrate): independent of encoder
      // speed — a thin cellular link starves even a faster-than-realtime
      // encode.
      if (await this.#checkLinkBudget(session, now)) {
        continue;
      }
      if (await this.#checkEncoderBudget(session, now)) {
        continue;
      }
      await this.#checkStepUp(session, now);
    }
  }

  /**
   * The encoder-speed check for one session: sustained sub-realtime, and the
   * encoder — not a download-starved input — is the limit.
   *
   * @param {HlsSession} session
   * @param {number} now
   * @returns {Promise<boolean>} True when a step was asked for this tick.
   */
  async #checkEncoderBudget(session, now) {
    if (!session.spec.transcodesVideo) {
      // A copy has no encoder to make cheaper. Whatever the machine is short
      // of, moving this viewer to a RE-ENCODED rung costs it more, not less —
      // so the copy path's only lever is the viewer's link, above.
      return false;
    }
    const speed = this.#host.encodeCost.recentSpeedOf(session, now, BUDGET_CHECK_INTERVAL_MS * 2);
    if (speed === null) {
      return false; // no measurement yet
    }
    if (speed >= BUDGET_SPEED_OK) {
      session.budgetSlowSince = 0; // recovered — reset the slow window
      return false;
    }
    if (speed >= BUDGET_SPEED_SLOW) {
      return false; // in the hysteresis band; neither slow nor ok
    }
    if (session.budgetSlowSince === 0) {
      session.budgetSlowSince = now;
      return false;
    }
    if (now - session.budgetSlowSince < BUDGET_SUSTAINED_MS) {
      return false; // not sustained yet
    }
    const bound = await this.classifyTranscodeBound(session);
    if (bound === "download") {
      logger.info(
        `[budget] transcode ${session.id} speed=${speed.toFixed(2)}x but download-limited ` +
          `"${session.file.name}"; not stepping down (torrent is the bottleneck)`
      );
      session.budgetSlowSince = 0; // re-evaluate fresh; don't thrash on this
      return false;
    }
    session.budgetSlowSince = 0;
    session.budgetUpSince = 0;
    const boundLabel = bound === "unknown" ? "assuming CPU-bound" : "CPU-bound";
    return this.#askLowerHeight(session, `${boundLabel} speed=${speed.toFixed(2)}x`);
  }

  /**
   * Ask the player to move down one offered rung.
   *
   * THE SIZE OF THE PICTURE IS NEVER REWRITTEN UNDERNEATH A RUNNING SESSION.
   * The fMP4 init segment is fetched once — a player reads `#EXT-X-MAP` and
   * never asks again — and `avc1` keeps SPS and PPS in it rather than in the
   * fragments, so every fragment produced after a size change is decoded
   * against parameter sets describing a picture that is no longer being made.
   * Measured 2026-08-21 on two files: one browser went on reporting
   * `size=1280x720` for three and a half minutes over a band of macroblock
   * garbage after the encoder had left for 960x540; the other errored on the
   * first mismatched fragment, closed the MediaSource and sat at `size=0x0`
   * for four and a half minutes. Which of the two happens is the decoder's
   * choice, not ours, and no layer reported an error either time.
   *
   * A change of resolution is a change of VARIANT, as the standard has it.
   * Every height is already published in the master with its own init, so the
   * step is made by ASKING the browser to move — the same act the manual menu
   * performs, which has never had this fault.
   *
   * @param {HlsSession} session
   * @param {string} reasonText
   * @returns {boolean} True when an ask was recorded.
   */
  #askLowerHeight(session, reasonText) {
    const base = this.#host.outputs.pictureOf(session);
    const current = this.#host.outputs.variantHeightOf(session);
    const offered = this.#host.qualityOffer.offeredHeights(base);
    // The highest rung strictly below the one on screen that this host is still
    // willing to serve. `offeredHeights` has already refused everything the
    // machine cannot hold, so a rung that survives it is one worth moving to.
    const next = this.#host.outputs.splicableHeights(base)
      .find((height) => height < current && offered.includes(height));
    if (next === undefined) {
      // Nothing lower — but "lower" is not the same question as "cheaper", and
      // on a source that is COPIED the answer is above, not below. A copied
      // rung costs no encoder at all, whatever its size, so when a re-encode
      // cannot keep up it is both the fastest thing this host can serve AND the
      // best picture it has.
      //
      // Field 2026-08-31, and it cost the viewer the whole film: an ultrafast
      // 444x240 encode ran at 0.43-0.94x for fifty minutes while the source's
      // own 1038p sat on offer beside it, copied and free. This line printed
      // fifty times — "nothing lower is on offer; leaving the picture alone" —
      // and the picture stood still 161 times for 940 seconds. The rescue was
      // on the screen the whole time and the rule could only look down.
      const copied = this.#host.qualityOffer.copiedHeightOf(base);
      if (copied > 0 && copied !== current && offered.includes(copied)) {
        logger.info(
          `[budget] transcode ${session.id} ${reasonText} at ${current}p and nothing lower is on offer, ` +
            `but ${copied}p is COPIED on this file — no encoder at all, and a better picture. ` +
            `Asking for it instead of leaving the viewer on an encode that cannot keep up`
        );
        return this.#askQualityHeight(base, copied, reasonText);
      }
      logger.info(
        `[budget] transcode ${session.id} ${reasonText} at ${current}p, but nothing lower is on offer ` +
          `for "${session.file.name}"; leaving the picture alone`
      );
      return false;
    }
    return this.#askQualityHeight(base, next, reasonText);
  }

  /**
   * Record a request to the viewer's player to move to another variant.
   *
   * The proxy cannot move a player between variants; it can only say which one
   * it would rather serve. The request travels in every progress report, and
   * the browser honours it ONLY in automatic mode — a height the viewer picked
   * by hand is theirs, and nothing here may take it away.
   *
   * @param {HlsSession} base
   * @param {number} height
   * @param {string} reasonText
   * @returns {boolean}
   */
  #askQualityHeight(base, height, reasonText) {
    if (!this.#host.outputs.publishesVariants(base)) {
      // Said once for the session. Repeating it is not information: the answer
      // is a property of the stream and cannot change while it plays.
      if (base.saidNoVariants !== true) {
        base.saidNoVariants = true;
        logger.info(
          `[budget] transcode ${base.id} would ask for ${height}p, but this stream publishes no ` +
            `variants to move between; leaving the picture alone for the rest of the session`
        );
      }
      return false;
    }
    const playing = this.heightsOnScreen(base);
    if (playing.every((onScreen) => onScreen === height)) {
      return false;
    }
    const now = Date.now();
    const standing = base.qualityAsk;
    if (standing && standing.height === height && now - standing.at < QUALITY_ASK_TTL_MS) {
      return false; // already asked, and the request has not run out
    }
    base.qualityAsk = { height, at: now, reason: reasonText };
    base.budgetLastActionAt = now;
    logger.info(
      `[budget] transcode ${base.id} asks the player to move ${playing.join("p/")}p → ${height}p: ${reasonText} ` +
        `"${base.file.name}" (a change of size is a change of variant — its own init describes it)`
    );
    return true;
  }

  /**
   * The step BACK UP, in two stages: first give this picture its own bitrate
   * back, then give it its own size back.
   *
   * The order matters. A rate cap was imposed because the viewer's link could
   * not carry the stream; lifting it is cheaper than enlarging the picture and
   * is what the viewer notices first. Only a session under no cap is considered
   * for a higher rung.
   *
   * @param {HlsSession} session
   * @param {number} now
   * @returns {Promise<void>}
   */
  async #checkStepUp(session, now) {
    const base = this.#host.outputs.pictureOf(session);
    const current = this.#host.outputs.variantHeightOf(session);
    // What the machine and the link would have to look like for a step up, held
    // for a window four times the one a step DOWN needs. Anything that fails
    // resets it, so the window measures an unbroken stretch.
    if (!(await this.#couldCarryMore(session, now, current))) {
      session.budgetUpSince = 0;
      return;
    }
    if (session.budgetUpSince === 0) {
      session.budgetUpSince = now;
      return;
    }
    if (now - session.budgetUpSince < BUDGET_UP_SUSTAINED_MS) {
      return;
    }
    if (Number.isFinite(session.rateCapKbps) && session.rateCapKbps > 0) {
      // A different question from the one above: can the link carry THIS
      // picture with no cap on it. Asked separately because a session at the
      // top offered height has no next rung at all, and answering "nothing to
      // step to, so yes" is how a cap came off a link measured at a fifth of
      // what the picture needs.
      const wanted = this.#host.qualityOffer.peakMbpsFor(this.#host.outputs.pictureOf(session), current);
      if (!linkCouldCarry(this.#host.worstLinkReading(session)?.linkMbps ?? null, wanted)) {
        return;
      }
      session.budgetUpSince = 0;
      await this.#liftRateCap(session);
      return;
    }
    session.budgetUpSince = 0;
    // One rung at a time: the lowest height above the one on screen, never
    // above the source (upscaling invents detail and costs more than the
    // source itself). A second step follows a second unbroken window.
    const higher = this.#host.qualityOffer.nextHeightUp(base, current);
    if (higher === undefined) {
      return;
    }
    this.#askQualityHeight(
      base,
      higher,
      `the machine and the link have carried ${current}p for ` +
        `${Math.round(BUDGET_UP_SUSTAINED_MS / 1000)}s with room to spare`
    );
  }

  /**
   * Whether this session has room to spare — the encoder ahead of realtime, the
   * torrent not the limit, and the viewer's link able to carry what the next
   * rung is allowed to peak at.
   *
   * @param {HlsSession} session
   * @param {number} now
   * @param {number} current - The height on screen.
   * @returns {Promise<boolean>}
   */
  async #couldCarryMore(session, now, current) {
    if (session.spec.transcodesVideo) {
      const speed = this.#host.encodeCost.recentSpeedOf(session, now, BUDGET_CHECK_INTERVAL_MS * 2);
      if (speed === null || speed < BUDGET_SPEED_OK) {
        return false;
      }
    }
    // A run in either slow window is one the budget is already unhappy with.
    if (session.linkSlowSince !== 0 || session.budgetSlowSince !== 0) {
      return false;
    }
    const report = this.#host.worstLinkReading(session);
    if (!report) {
      // Nothing measures the link, so it has no opinion either way — the same
      // silence that stops #checkLinkBudget from acting.
      return true;
    }
    const base = this.#host.outputs.pictureOf(session);
    const next = this.#host.qualityOffer.nextHeightUp(base, current);
    if (next === undefined) {
      return true; // nothing to step to; only the cap decision is left
    }
    return linkCouldCarry(report.linkMbps, this.#host.qualityOffer.peakMbpsFor(base, next));
  }

  /**
   * Bound this encode's bitrate by the viewer's MEASURED link.
   *
   * The one lever that reduces what is sent without touching the picture's
   * size: `-maxrate`, `-bufsize` and CRF do not appear in the SPS (x264 writes
   * no HRD parameters unless asked), so the init segment already in the
   * player's hands goes on describing every fragment. The target is not chosen
   * — it is the link the browser reported, less the share protocol overhead and
   * measurement noise take out of it.
   *
   * @param {HlsSession} session
   * @param {number} linkMbps
   * @param {string} reasonText
   * @returns {Promise<boolean>}
   */
  async #applyRateCap(session, linkMbps, reasonText) {
    const usableKbps = Math.round(linkMbps * LINK_SAFETY * 1000);
    const wanted = nominalKbpsForMaxrate(usableKbps);
    if (!(wanted > 0)) {
      return false;
    }
    // The floor: what the SMALLEST picture this file is offered at is sized to
    // carry. Below that, the link is not short of bitrate at this size — it is
    // short of the size, and the answer is a smaller variant rather than a
    // number that would make this one unwatchable.
    const base = this.#host.outputs.pictureOf(session);
    const offered = this.#host.qualityOffer.offeredHeights(base);
    const smallest = offered.length > 0 ? Math.min(...offered) : this.#host.outputs.variantHeightOf(session);
    const floor = nominalKbpsForHeight(smallest);
    if (wanted < floor) {
      if (this.#askLowerHeight(session, `viewer-link-bound ${reasonText}`)) {
        return true;
      }
      logger.info(
        `[budget] transcode ${session.id} the link carries ${maxrateKbpsFor(wanted)}kbps and the ` +
          `smallest picture on offer (${smallest}p) is sized for ${maxrateKbpsFor(floor)}kbps; ` +
          `capping at the floor rather than below it "${session.file.name}"`
      );
    }
    const nominal = Math.max(wanted, floor);
    const standing = Number.isFinite(session.rateCapKbps) ? session.rateCapKbps : null;
    if (standing !== null && nominal >= standing) {
      return false; // this would loosen a cap, which is the step UP's business
    }
    session.rateCapKbps = nominal;
    session.budgetSlowSince = 0;
    session.budgetUpSince = 0;
    base.budgetLastActionAt = Date.now();
    // What this run was last seen doing described an encode at another bitrate.
    // A cheaper one encodes faster, so keeping the figure would price the new
    // picture at the old one's cost.
    session.lastAloneSpeed = null;
    session.recentSpeed = null;
    logger.info(
      `[budget] transcode ${session.id} viewer-link-bound ${reasonText} → capping the picture at ` +
        `${maxrateKbpsFor(nominal)}kbps peak, size unchanged at ${session.output.encodeWidth}x${session.output.encodeHeight} ` +
        `"${session.file.name}"`
    );
    this.#reencodeAtNewRate(session);
    return true;
  }

  /**
   * Give a capped picture its own bitrate back.
   *
   * @param {HlsSession} session
   * @returns {Promise<void>}
   */
  async #liftRateCap(session) {
    const lifted = session.rateCapKbps;
    session.rateCapKbps = null;
    session.lastAloneSpeed = null;
    session.recentSpeed = null;
    this.#host.outputs.pictureOf(session).budgetLastActionAt = Date.now();
    logger.info(
      `[budget] transcode ${session.id} the link has carried this picture with room to spare; ` +
        `lifting the ${maxrateKbpsFor(lifted)}kbps cap "${session.file.name}"`
    );
    this.#reencodeAtNewRate(session);
  }

  /**
   * The picture's bitrate has changed, so the encoder producing it at the old
   * one has to go.
   *
   * That is the whole of what is known here, and it is a fact about the OUTPUT:
   * an argument list is fixed when a process starts, so a run carrying the
   * previous cap cannot be told about the new one. Where the replacement stands
   * is a different question, and the plan answers it from where the viewers are.
   *
   * It used to answer it too, and by a rule of its own: the segment the encoder
   * had reached. That is neither where a viewer is nor a gap in the material —
   * it is where the process being replaced happened to have got to.
   *
   * Safe to do to a run that has produced material: the cap lives in rate
   * control alone, which does not appear in the SPS or the PPS, so pieces made
   * before it are still described by the header the player holds.
   *
   * @param {HlsSession} session
   * @returns {void}
   */
  #reencodeAtNewRate(session) {
    this.#host.stopEncodeRun(session, "its bitrate cap changed");
    this.#host.planEncodersSoon();
  }

  /**
   * Viewer-link deficit check for one session (adaptive bitrate, part b).
   * Mirrors the CPU slow-window pattern; shares the action cooldown and the
   * downshift machinery. Returns true when a downshift was applied this tick.
   *
   * @param {HlsSession} session
   * @param {number} now
   * @returns {Promise<boolean>}
   */
  async #checkLinkBudget(session, now) {
    const report = this.#host.worstLinkReading(session);
    if (!report) {
      session.linkSlowSince = 0; // nobody present has measured their link
      return false;
    }
    if (report.bufferedAheadSec >= LINK_LOW_BUFFER_SEC) {
      session.linkSlowSince = 0; // viewer is comfortable — nothing to fix
      return false;
    }
    const observed = await this.observedStreamMbps(session);
    if (observed === null) {
      return false; // not enough produced material to compare against
    }
    if (report.linkMbps * LINK_SAFETY >= observed) {
      session.linkSlowSince = 0; // link keeps up
      return false;
    }
    if (session.linkSlowSince === 0) {
      session.linkSlowSince = now;
      return false;
    }
    if (now - session.linkSlowSince < LINK_SLOW_WINDOW_MS) {
      return false; // not sustained yet
    }
    session.linkSlowSince = 0;
    // How many viewers the two figures were taken over, because with more than
    // one they are the worst of each and need not belong to the same person.
    const reasonText =
      `link=${report.linkMbps.toFixed(2)}Mbps stream=${observed.toFixed(2)}Mbps ` +
      `buffer=${report.bufferedAheadSec.toFixed(1)}s` +
      (report.viewers > 1 ? ` (worst of ${report.viewers} viewers)` : "");
    // Which lever this branch HAS, which is not the same on both paths.
    //
    // A re-encoded picture can simply be told to make fewer bits at the size it
    // is already making, and the target is not chosen — it is the link the
    // browser just measured. Nothing about the picture's size moves, so the one
    // init segment the player holds goes on describing every fragment.
    //
    // A COPIED picture is not being encoded at all, so it has no rate to lower:
    // its bitrate is the source's. The only way to send fewer bits is to send
    // another rendering of the film, which is a re-encoded rung — a change of
    // variant, and the player's own switch. This is the whole of what "a change
    // of resolution must exist on the copy path too" asks for.
    if (session.spec.transcodesVideo && this.#host.videoEncoder?.kind === "software") {
      return await this.#applyRateCap(session, report.linkMbps, reasonText);
    }
    return this.#askLowerHeight(session, `viewer-link-bound ${reasonText}`);
  }

  /**
   * Observed produced bitrate (Mbit/s) averaged over the last few COMPLETED
   * segment files (the newest file may still be being written and is
   * excluded). Transcode sessions only — their segment grid is uniform, so
   * bytes / (count × segDur) is exact. Returns null when there is not enough
   * material to measure.
   *
   * @param {HlsSession} session
   * @returns {Promise<number | null>}
   */
  async observedStreamMbps(session) {
    let names;
    try {
      names = this.#host.producedNumbers(session).map((index) => session.segmentFormat.segmentFileName(index));
    } catch {
      return null;
    }
    const indices = [];
    for (const name of names) {
      const index = session.segmentFormat.segmentIndexFromName(name);
      if (index >= 0) {
        indices.push(index);
      }
    }
    if (indices.length < 3) {
      return null; // need ≥2 completed segments after dropping the newest
    }
    indices.sort((a, b) => a - b);
    const completed = indices.slice(0, -1).slice(-LINK_OBSERVED_SEGMENTS);
    let bytes = 0;
    try {
      for (const index of completed) {
        const segmentPath = this.#host.segmentStore.pathOf(session.outputKey ?? "", index);
        if (!segmentPath) {
          break;
        }
        const st = await stat(segmentPath);
        bytes += st.size;
      }
    } catch {
      return null; // a segment vanished mid-measure (seek-restart cleanup)
    }
    return (bytes * 8) / (completed.length * this.#host.segmentDurationSec) / 1e6;
  }

  /**
   * Decide whether a sustained sub-realtime transcode is limited by the encoder
   * (CPU) or by a download-starved input. Compares the torrent's download rate
   * with the source's average byte rate; a fully-downloaded file can never be
   * download-bound. Returns "cpu" | "download" | "unknown" ("unknown" is treated
   * as CPU by the caller — the common case, logged as such).
   *
   * @param {HlsSession} session
   * @returns {Promise<"cpu" | "download" | "unknown">}
   */
  async classifyTranscodeBound(session) {
    if (!this.#host.getSourceStats) {
      return "unknown";
    }
    let stats;
    try {
      stats = await this.#host.getSourceStats(session.file.sourceKey, session.file.fileIndex);
    } catch {
      return "unknown";
    }
    if (!stats) {
      return "unknown";
    }
    // What this file's own interruptions demand, measured by the reader. Kept
    // on the session because the browser is told the buffer that follows from
    // it, and because the quality offer will be held to the speed it names.
    if (stats.supply) {
      session.supplyFigures = stats.supply;
    }
    // A fully (or almost fully) downloaded file cannot be download-bound.
    if (typeof stats.fileProgress === "number" && stats.fileProgress >= 0.999) {
      return "cpu";
    }
    const duration = Number.isFinite(session.file.durationSeconds) ? session.file.durationSeconds : 0;
    const length = Number.isFinite(stats.fileLength) && stats.fileLength > 0 ? stats.fileLength : 0;
    const downloadSpeed = Number.isFinite(stats.downloadSpeed) ? stats.downloadSpeed : 0;
    if (duration <= 0 || length <= 0) {
      return "unknown"; // cannot compute the source byte rate
    }
    const sourceByteRate = length / duration;
    return downloadSpeed >= sourceByteRate * BUDGET_DOWNLOAD_OK_FACTOR ? "cpu" : "download";
  }

  /**
   * The height this proxy is asking the player to move to, or 0.
   *
   * Cleared the moment the viewer is on it — the request has been answered —
   * and dropped when it runs out, which is the only sign this side ever gets
   * that a player could not or would not follow it. A browser on a manual pick
   * ignores every request by design, so an unanswered one is not an error; it
   * is said once and let go, rather than repeated for the rest of the film.
   *
   * @param {HlsSession} named - The session the browser addressed.
   * @returns {number}
   */
  standingAskFor(named) {
    const base = this.#host.outputs.pictureOf(named);
    const ask = base.qualityAsk;
    if (!ask) {
      return 0;
    }
    if (this.heightsOnScreen(base).every((height) => height === ask.height)) {
      base.qualityAsk = null; // the viewer is there; nothing left to ask for
      return 0;
    }
    if (Date.now() - ask.at > QUALITY_ASK_TTL_MS) {
      base.qualityAsk = null;
      logger.info(
        `[budget] transcode ${base.id} asked for ${ask.height}p and the player stayed where it was ` +
          `(${ask.reason}); letting the request go`
      );
      return 0;
    }
    return ask.height;
  }

  heightsOnScreen(base) {
    return [...this.variantsOnScreen(base)]
      .map((id) => this.#host.outputs.get(id))
      .filter((member) => member)
      .map((member) => this.#host.outputs.variantHeightOf(member));
  }

  /**
   * Every session of this family that a live viewer has on screen.
   *
   * The question "may this rung's encoder be stopped" has no single answer once
   * two viewers watch one picture at two qualities: the rung one of them left is
   * the rung the other is watching. Nothing may be stopped for being left unless
   * nobody is left on it.
   *
   * @param {HlsSession} base
   * @returns {Set<string>} Session ids.
   */
  variantsOnScreen(base) {
    const live = this.#host.liveConsumers(base);
    const onScreen = new Set();
    for (const [consumerId, viewer] of this.#host.viewersOf(base)) {
      if (consumerId && live.size > 0 && !live.has(consumerId)) {
        continue;
      }
      // No step chosen is the picture itself, which is on screen too.
      onScreen.add(viewer.activeVariantId ?? base.id);
    }
    if (onScreen.size === 0) {
      onScreen.add(base.id);
    }
    return onScreen;
  }

  /**
   * The heights this session's file will be served at, largest first, and the
   * two lists a file would be served at before any session exists.
   *
   * Both are the quality layer's answers and are computed there. What is left
   * here is the door: a route holds the session manager and asks it, and these
   * go the day the route can ask the layer directly.
   *
   * @param {HlsSession} session
   * @returns {number[]}
   */
  offeredHeights(session) {
    return this.#host.qualityOffer.offeredHeights(session);
  }

  /**
   * @param {object} mediaInfo
   * @returns {{ copy: number[], transcode: number[] } | null}
   */
  predictOfferedHeights(mediaInfo) {
    return this.#host.qualityOffer.predictOfferedHeights(mediaInfo);
  }
}
