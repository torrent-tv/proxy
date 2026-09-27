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
import { LINK_SAFETY, linkCouldCarry, loadOf } from "./link-budget.js";
import { qualityStateOf } from "./OutputQualityState.js";
import { drainThreat } from "./drain-threat.js";
import { visibleHeightCap } from "./visible-rung.js";

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
// Viewer-link adaptation. Judged on each report a viewer makes, for that
// viewer alone (roadmap item 98): when their link does not carry the stream
// they are given AND their buffer, on its present trend, would run dry before
// another output could have the piece they need (`drain-threat.js`), a smaller
// output is prepared for them. A chosen window of slowness and a chosen buffer
// threshold stood here, and a chosen wait after every action; all three are
// gone. A manual viewer is never sent an automatic quality request.
// Observed produced bitrate: average over this many recently completed
// segments (the newest file on disk may still be written and is excluded).
const LINK_OBSERVED_SEGMENTS = 5;

export class QualityController {
  /** What this reads and asks of the rest of the proxy, and nothing else. @type {object} */
  #host;

  /** A budget pass is under way; a timer tick that lands meanwhile is skipped. */
  #tickRunning = false;

  /** Viewers whose report is being judged now (`noteViewerReported`). @type {Set<string>} */
  #judging = new Set();

  /**
   * @param {object} host - `isLive`, `liveConsumers`, `liveRunsOf`, `producedNumbers`, `reportHostLoad`, `runStateOf`, `sampleDownloadRates`, `encodeCost`, `getSourceStats`, `outputs`, `qualityOffer`, `segmentDurationSec`, `segmentStore`, `videoEncoder`, `prepareSameHeightSwitch`, `sameHeightSwitchPending`, `sameHeightSwitchDirection`, `cancelSameHeightSwitch`, `heightReadyFor`, `bufferOf`, `visiblePictureOf`, `expectedFirstSegmentMs`
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
      // A viewer's link is judged on each of their reports
      // (`noteViewerReported`), not here: nothing about it changes between two
      // reports, so a timer would only read the same statement again.
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
      qualityStateOf(session).budgetSlowSince = 0; // recovered — reset the slow window
      return false;
    }
    if (speed >= BUDGET_SPEED_SLOW) {
      return false; // in the hysteresis band; neither slow nor ok
    }
    if (qualityStateOf(session).budgetSlowSince === 0) {
      qualityStateOf(session).budgetSlowSince = now;
      return false;
    }
    if (now - qualityStateOf(session).budgetSlowSince < BUDGET_SUSTAINED_MS) {
      return false; // not sustained yet
    }
    const bound = await this.classifyTranscodeBound(session);
    if (bound === "download") {
      logger.info(
        `[budget] transcode ${session.id} speed=${speed.toFixed(2)}x but download-limited ` +
          `"${session.file.name}"; not stepping down (torrent is the bottleneck)`
      );
      qualityStateOf(session).budgetSlowSince = 0; // re-evaluate fresh; don't thrash on this
      return false;
    }
    qualityStateOf(session).budgetSlowSince = 0;
    qualityStateOf(session).budgetUpSince = 0;
    const boundLabel = bound === "unknown" ? "assuming CPU-bound" : "CPU-bound";
    // The machine is the output's reason, so every viewer with it on screen is
    // asked — each to the rung their own picture bounds a re-encode by, where
    // that is lower than the next rung down (roadmap item 98).
    const reasonText = `${boundLabel} speed=${speed.toFixed(2)}x`;
    const base = this.#host.outputs.pictureOf(session);
    const watching = this.#host.presentOn(session).filter((consumerId) => this.#onScreenHere(session, consumerId));
    if (watching.length === 0) {
      return this.#askLowerHeight(session, reasonText);
    }
    let asked = false;
    for (const consumerId of watching) {
      if (this.#askLowerHeight(session, reasonText, [consumerId], { cap: this.#visibleCapOf(base, consumerId) })) {
        asked = true;
      }
    }
    return asked;
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
   * @param {string[] | null} [onlyFor]
   * @param {{ urgent?: boolean, cap?: number | null }} [options] - `urgent`
   *   when the viewer's buffer would run dry first; `cap` the height the
   *   picture they see bounds a re-encode by, preferred where it is lower than
   *   the next rung down.
   * @returns {boolean} True when an ask was recorded.
   */
  #askLowerHeight(session, reasonText, onlyFor = null, { urgent = false, cap = null } = {}) {
    const base = this.#host.outputs.pictureOf(session);
    const current = this.#host.outputs.variantHeightOf(session);
    const offered = this.#host.qualityOffer.offeredHeights(base);
    // The highest rung strictly below the one on screen that this host is still
    // willing to serve. `offeredHeights` has already refused everything the
    // machine cannot hold, so a rung that survives it is one worth moving to.
    // Where the picture the viewer sees bounds a re-encode lower still, the
    // highest rung within that bound is taken instead: they are shown nothing
    // the rung between would have added (roadmap item 98).
    const lower = this.#host.outputs.splicableHeights(base)
      .filter((height) => height < current && offered.includes(height));
    const next = (Number.isInteger(cap) && cap > 0 ? lower.find((height) => height <= cap) : undefined) ?? lower[0];
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
        return this.#askQualityHeight(base, copied, reasonText, onlyFor, urgent);
      }
      logger.info(
        `[budget] transcode ${session.id} ${reasonText} at ${current}p, but nothing lower is on offer ` +
          `for "${session.file.name}"; leaving the picture alone`
      );
      return false;
    }
    return this.#askQualityHeight(base, next, reasonText, onlyFor, urgent);
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
   * @param {string[] | null} [onlyFor] - The viewers this ask is FOR. A reason
   *   that belongs to one person's link is theirs alone: a thin link asks only
   *   the viewer on it, never everybody watching the picture. Null for a reason
   *   that belongs to the output — the machine cannot keep up with it — which
   *   is every AUTO viewer's.
   * @param {boolean} [urgent] - Their buffer would run dry before anything else
   *   could arrive, so their page switches without waiting for a cushion.
   * @returns {boolean}
   */
  #askQualityHeight(base, height, reasonText, onlyFor = null, urgent = false) {
    if (!this.#host.outputs.publishesVariants(base)) {
      // Said once for the session. Repeating it is not information: the answer
      // is a property of the stream and cannot change while it plays.
      if (qualityStateOf(base).saidNoVariants !== true) {
        qualityStateOf(base).saidNoVariants = true;
        logger.info(
          `[budget] transcode ${base.id} would ask for ${height}p, but this stream publishes no ` +
            `variants to move between; leaving the picture alone for the rest of the session`
        );
      }
      return false;
    }
    const now = Date.now();
    const asked = [];
    const playing = [];
    for (const consumerId of this.#host.consumersOn(base)) {
      if (this.#host.qualityModeOf(base, consumerId) !== "auto") {
        continue;
      }
      if (onlyFor && !onlyFor.includes(consumerId)) {
        continue;
      }
      const onScreen = this.#host.stepOnScreenOf(base, consumerId);
      const current = onScreen ? this.#host.outputs.get(onScreen) : base;
      const currentHeight = this.#host.outputs.variantHeightOf(current ?? base);
      playing.push(currentHeight);
      if (currentHeight === height) {
        this.#host.dropAskOf(base, consumerId);
        continue;
      }
      const standing = this.#host.standingAskOf(base, consumerId);
      if (standing && standing.height === height && now - standing.at < QUALITY_ASK_TTL_MS) {
        continue;
      }
      if (this.#host.askQualityOf(base, consumerId, height, reasonText, now, urgent)) {
        asked.push(consumerId);
      }
    }
    if (asked.length === 0) {
      return false;
    }
    logger.info(
      `[budget] transcode ${base.id} asks the player to move ${playing.join("p/")}p → ${height}p${urgent ? " (urgent)" : ""}: ${reasonText} ` +
        `"${base.file.name}" for ${asked.length} AUTO viewer(s) ` +
        `(a change of size is a change of variant — its own init describes it)`
    );
    return true;
  }

  /**
   * The step BACK UP, in two stages and one rung at a time.
   *
   * 1. ANOTHER LIMIT OF THE SAME HEIGHT: a viewer moved down to a lower limit
   *    goes back up the limits of their height first, without their player
   *    being told (roadmap item 97, step 12). A limit is part of an output, so
   *    this is a move between outputs, prepared for one viewer.
   * 2. ANOTHER HEIGHT, asked of the player in AUTO — only for a viewer with no
   *    higher limit to go to on the height they watch, and only if their own
   *    link admits the next height's whole load.
   *
   * Both follow one window: the machine and the viewer's link have held the
   * output on screen, with room to spare, for four times as long as a step
   * DOWN needs.
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
    const spare = this.#roomToSpare(session, now);
    // A step up being prepared for a viewer who no longer has room is let go:
    // the conditions it was asked under have gone back (roadmap item 98).
    for (const consumerId of this.#host.presentOn(session)) {
      if (!spare.includes(consumerId)) {
        this.#dropUpAsk(session, consumerId, "the room it was asked for has gone");
      }
    }
    if (spare.length === 0) {
      qualityStateOf(session).budgetUpSince = 0;
      return;
    }
    if (qualityStateOf(session).budgetUpSince === 0) {
      qualityStateOf(session).budgetUpSince = now;
      return;
    }
    if (now - qualityStateOf(session).budgetUpSince < BUDGET_UP_SUSTAINED_MS) {
      return;
    }
    qualityStateOf(session).budgetUpSince = 0;
    const reasonText =
      `the machine and the link have carried ${current}p for ` +
      `${Math.round(BUDGET_UP_SUSTAINED_MS / 1000)}s with room to spare`;
    const atTheirHighestLimit = [];
    for (const consumerId of spare) {
      const move = await this.#host.prepareSameHeightSwitch(session, consumerId, "up", reasonText);
      if (move.started) {
        continue;
      }
      // Refused because the MACHINE holds no more encoders: a higher height
      // costs more than the limit that was just refused, so it is not asked for.
      if (move.noPlace) {
        logger.info(`[budget] transcode ${session.id} no step up for ${consumerId}: ${move.reason}`);
        continue;
      }
      atTheirHighestLimit.push(consumerId);
    }
    // One rung at a time: the lowest height above the one on screen, never
    // above the source (upscaling invents detail and costs more than the
    // source itself). A second step follows a second unbroken window.
    const higher = this.#host.qualityOffer.nextHeightUp(base, current);
    if (higher === undefined) {
      return;
    }
    // Only the viewers whose OWN link admits the next rung, and whose picture on
    // screen is not already served by the rung they are on: a re-encode is
    // never made taller than the picture they see (roadmap item 98). The copy
    // of the source is not a re-encode, and going back to it is not bounded.
    // Another viewer's fast link or large screen says nothing about theirs.
    const copied = this.#host.qualityOffer.copiedHeightOf(base);
    const carriers = atTheirHighestLimit.filter((consumerId) =>
      this.#linkAdmitsHeight(base, session, consumerId, higher) &&
      (higher === copied || this.#visibleCapOf(base, consumerId) === null || higher <= this.#visibleCapOf(base, consumerId))
    );
    if (carriers.length > 0) {
      this.#askQualityHeight(base, higher, reasonText, carriers);
    }
  }

  /**
   * The viewers who have this session on screen with room to spare: the
   * encoder ahead of realtime and the torrent not the limit — which are the
   * OUTPUT's and hold for all of them or none — and, for each viewer on their
   * own, a buffer that is not draining and no move of theirs already being
   * prepared.
   *
   * @param {HlsSession} session
   * @param {number} now
   * @returns {string[]} Empty when nobody has room.
   */
  #roomToSpare(session, now) {
    if (session.spec.transcodesVideo) {
      const speed = this.#host.encodeCost.recentSpeedOf(session, now, BUDGET_CHECK_INTERVAL_MS * 2);
      if (speed === null || speed < BUDGET_SPEED_OK) {
        return [];
      }
    }
    if (qualityStateOf(session).budgetSlowSince !== 0) {
      return [];
    }
    // A buffer that drains over a whole segment's period is being spent faster
    // than it is filled: there is no room for more.
    return this.#host.presentOn(session).filter((consumerId) =>
      !((this.#host.bufferOf(session, consumerId, this.#host.segmentDurationSec)?.slope ?? 0) < 0) &&
      this.#onScreenHere(session, consumerId) &&
      !this.#host.sameHeightSwitchPending(consumerId)
    );
  }

  /**
   * Whether this viewer's own link admits the whole load of a height nothing
   * may have produced yet.
   *
   * Nothing measured their link: no ground to refuse, the same silence that
   * stops `#checkViewerLink` from acting on them.
   *
   * @param {HlsSession} base
   * @param {HlsSession} session
   * @param {string} consumerId
   * @param {number} height
   * @returns {boolean}
   */
  #linkAdmitsHeight(base, session, consumerId, height) {
    const report = this.#host.linkReportOf(session, consumerId);
    const load = loadOf(
      this.#host.qualityOffer.videoLoadFor(base, height, this.#host.videoEncoder?.kind ?? ""),
      this.#host.viewerAudioLoadOf(base, consumerId)
    );
    return linkCouldCarry(report?.linkMbps ?? null, load).admitted;
  }

  /**
   * A viewer reported on themselves: judge their link and the picture they
   * see, for them alone, now (roadmap item 98).
   *
   * The report is the event that carries a change of either, so it is where
   * they are judged — not a timer, which between two reports would only read
   * the same statement again.
   *
   * @param {string} sessionId - The output the page addressed.
   * @param {string} consumerId
   * @returns {Promise<void>}
   */
  async noteViewerReported(sessionId, consumerId) {
    const named = sessionId ? this.#host.outputs.get(sessionId) : null;
    if (!named || !consumerId) {
      return;
    }
    const base = this.#host.outputs.pictureOf(named);
    const onScreen = this.#host.stepOnScreenOf(base, consumerId);
    const session = (onScreen ? this.#host.outputs.get(onScreen) : null) ?? base;
    if (!this.#host.isLive(session) || session.spec.carries === "audio-only") {
      return;
    }
    // One judgement of a viewer at a time: reports can arrive while the last
    // one is still reading its files.
    if (this.#judging.has(consumerId)) {
      return;
    }
    this.#judging.add(consumerId);
    try {
      const now = Date.now();
      if (this.#host.videoEncoder?.kind === "software" &&
        (await this.#checkViewerLink(session, consumerId, now))) {
        return;
      }
      this.#checkVisiblePicture(session, consumerId, now);
    } finally {
      this.#judging.delete(consumerId);
    }
  }

  /**
   * This viewer's link against the stream they are given.
   *
   * THE CONDITION, both halves measured: their link does not carry the stream
   * (the reading times the safety margin is below the observed bitrate), and
   * their buffer, on its present trend, would run dry before another output
   * could close the piece they need (`drain-threat.js`). A buffer that falls
   * without that threat moves nothing.
   *
   * THE LEVERS, in order: another limit of the height on their screen (roadmap
   * item 97, step 12), then a lower height, asked of their player as URGENT —
   * their page switches as soon as the rung is ready, without waiting for a
   * cushion that is shrinking. Where neither can be prepared they stay where
   * they are, with no message: what is on screen goes on being delivered, and
   * a buffer that runs dry is filled again before the picture moves.
   *
   * @param {HlsSession} session - The output on their screen.
   * @param {string} consumerId
   * @param {number} now
   * @returns {Promise<boolean>} True when a move was started or asked for.
   */
  async #checkViewerLink(session, consumerId, now) {
    if (!this.#onScreenHere(session, consumerId)) {
      return false;
    }
    const report = this.#host.linkReportOf(session, consumerId);
    if (!report) {
      return false; // their link has not been measured: no ground to move them
    }
    const observed = await this.observedStreamMbps(session);
    if (observed === null) {
      return false; // not enough produced material to compare against
    }
    const buffer = this.#host.bufferOf(session, consumerId, this.#host.segmentDurationSec);
    // How long another output of the mode on their screen has been seen taking
    // to be ready here (roadmap item 97, step 14), and otherwise this host's
    // time to a first segment. The observation refines WHEN a move is started;
    // what the move may be — admission, the link, the viewer's mode — is
    // decided below exactly as without it.
    const observedMs = this.#host.observedPreparationMs?.(session) ?? null;
    const expectedMs = Number.isFinite(observedMs) ? observedMs : (this.#host.expectedFirstSegmentMs?.() ?? null);
    const { threat, secondsToEmpty } = drainThreat({
      bufferedSec: buffer?.bufferedSec ?? 0,
      slope: buffer?.slope ?? null,
      reportGapSec: buffer?.reportGapSec ?? 0,
      secondsToReady: Number.isFinite(expectedMs) && expectedMs >= 0 ? expectedMs / 1000 : null
    });
    const carries = report.linkMbps * LINK_SAFETY >= observed;
    if (carries && !threat) {
      return false;
    }
    // Whatever else happens, a step UP prepared for them is not what they need.
    this.#dropUpAsk(session, consumerId, "their buffer is draining or their link does not carry the stream");
    if (this.#host.sameHeightSwitchDirection(consumerId) === "up") {
      this.#host.cancelSameHeightSwitch(consumerId, "their buffer is draining or their link does not carry the stream");
    }
    if (carries || !threat) {
      return false;
    }
    if (this.#host.sameHeightSwitchPending(consumerId)) {
      return false; // a move down is already being prepared for them
    }
    const reasonText =
      `link=${report.linkMbps.toFixed(2)}Mbps stream=${observed.toFixed(2)}Mbps ` +
      `buffer=${(buffer?.bufferedSec ?? 0).toFixed(1)}s empty in ${secondsToEmpty === null ? "?" : secondsToEmpty.toFixed(1)}s ` +
      `for ${consumerId}`;
    const move = await this.#host.prepareSameHeightSwitch(session, consumerId, "down", `viewer-link-bound ${reasonText}`);
    if (move.started) {
      return true;
    }
    logger.info(`[budget] transcode ${session.id} ${reasonText}: no lower limit to move to (${move.reason})`);
    const base = this.#host.outputs.pictureOf(session);
    if (this.#askLowerHeight(session, `viewer-link-bound ${reasonText}`, [consumerId], {
      urgent: true,
      cap: this.#visibleCapOf(base, consumerId)
    })) {
      return true;
    }
    logger.info(
      `[budget] transcode ${session.id} ${reasonText}: nothing smaller can be prepared; ` +
        `the viewer stays on what they are given`
    );
    return false;
  }

  /**
   * The picture this viewer sees against the height they are given (roadmap
   * item 98).
   *
   * A re-encode taller than the picture they see is moved down to a rung of
   * the right height — but only onto one that is READY, the piece they will
   * ask for next closed on it; their page then switches once they hold the
   * cushion this file needs. With no such rung ready, nothing is started: the
   * next judgement of their link or of the machine takes the bound into
   * account (`#askLowerHeight`).
   *
   * A picture shorter than the one they see is moved up one rung, in the
   * background, when the machine and their link have room; the request is
   * dropped if that room goes.
   *
   * A copy of the source is left alone whatever its height: it is never
   * re-encoded for being taller than the picture on screen.
   *
   * @param {HlsSession} session - The output on their screen.
   * @param {string} consumerId
   * @param {number} now
   * @returns {void}
   */
  #checkVisiblePicture(session, consumerId, now) {
    if (!session.spec.transcodesVideo || !this.#onScreenHere(session, consumerId)) {
      return;
    }
    const base = this.#host.outputs.pictureOf(session);
    const cap = this.#visibleCapOf(base, consumerId);
    if (cap === null || !this.#host.outputs.publishesVariants(base)) {
      return;
    }
    const current = this.#host.outputs.variantHeightOf(session);
    const offered = this.#host.qualityOffer.offeredHeights(base);
    if (current > cap) {
      const target = this.#host.outputs.splicableHeights(base)
        .find((height) => height <= cap && offered.includes(height));
      if (target === undefined || !this.#host.heightReadyFor(base, consumerId, target)) {
        return;
      }
      this.#askQualityHeight(base, target, `the picture they see (${cap}p) is smaller than ${current}p`, [consumerId]);
      return;
    }
    if (current < cap) {
      const higher = this.#host.qualityOffer.nextHeightUp(base, current);
      const room = this.#roomToSpare(session, now).includes(consumerId);
      if (higher === undefined || higher > cap || !room || !this.#linkAdmitsHeight(base, session, consumerId, higher)) {
        return;
      }
      this.#askQualityHeight(base, higher, `the picture they see (${cap}p) is larger than ${current}p`, [consumerId]);
    }
  }

  /**
   * The height a re-encode is bounded by for this viewer, from the picture
   * they see, or null when their page has not said.
   *
   * @param {HlsSession} base
   * @param {string} consumerId
   * @returns {number | null}
   */
  #visibleCapOf(base, consumerId) {
    return visibleHeightCap(base.file.width, base.file.height, this.#host.visiblePictureOf(base, consumerId));
  }

  /**
   * Let go of a request to move this viewer UP, if one stands.
   *
   * @param {HlsSession} session
   * @param {string} consumerId
   * @param {string} because
   * @returns {void}
   */
  #dropUpAsk(session, consumerId, because) {
    const base = this.#host.outputs.pictureOf(session);
    const ask = this.#host.standingAskOf(base, consumerId);
    const onScreen = this.#host.stepOnScreenOf(base, consumerId);
    const current = this.#host.outputs.variantHeightOf((onScreen ? this.#host.outputs.get(onScreen) : null) ?? base);
    if (ask && ask.height > current) {
      this.#host.dropAskOf(base, consumerId);
      logger.info(`[budget] transcode ${base.id} no longer asks ${consumerId} for ${ask.height}p: ${because}`);
    }
  }

  /**
   * Whether this output is the one on this viewer's screen.
   *
   * A viewer is registered on the picture for as long as they watch any step
   * of it, so being present on an output does not mean watching it. What an
   * output measures — its stream, its speed — is about the people who have it
   * on screen, and a decision about a viewer's link is taken against the
   * output they actually receive.
   *
   * @param {HlsSession} session
   * @param {string} consumerId
   * @returns {boolean}
   */
  #onScreenHere(session, consumerId) {
    const base = this.#host.outputs.pictureOf(session);
    const onScreen = this.#host.stepOnScreenOf(base, consumerId);
    return (onScreen ?? base.id) === session.id;
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
   * An encoder is about to start on this output.
   *
   * Any start resets the cumulative `speed` ffmpeg reports, so both of this
   * budget's windows over it start again: the pair of readings speed is learned
   * from, and the slow window — otherwise warm-up right after a seek reads as
   * sustained sub-realtime and triggers a premature step down.
   *
   * @param {object} output
   * @returns {void}
   */
  noteRunStarting(output) {
    const state = qualityStateOf(output);
    state.learnSample = null;
    state.budgetSlowSince = 0;
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
  standingAskFor(named, consumerId = "") {
    const base = this.#host.outputs.pictureOf(named);
    if (this.#host.qualityModeOf(base, consumerId) !== "auto") {
      this.#host.dropAskOf(base, consumerId);
      return 0;
    }
    const ask = this.#host.standingAskOf(base, consumerId);
    if (!ask) {
      return 0;
    }
    const onScreen = this.#host.stepOnScreenOf(base, consumerId);
    const current = onScreen ? this.#host.outputs.get(onScreen) : base;
    if (this.#host.outputs.variantHeightOf(current ?? base) === ask.height) {
      this.#host.dropAskOf(base, consumerId); // this viewer is there; nothing left to ask for
      return 0;
    }
    if (Date.now() - ask.at > QUALITY_ASK_TTL_MS) {
      this.#host.dropAskOf(base, consumerId);
      logger.info(
        `[budget] transcode ${base.id} asked viewer ${consumerId || "unnamed"} for ${ask.height}p and the player stayed where it was ` +
          `(${ask.reason}); letting the request go`
      );
      return 0;
    }
    return ask.height;
  }

  /**
   * Whether the request standing for this viewer is urgent — their buffer
   * would run dry before anything else could arrive.
   *
   * @param {HlsSession} named
   * @param {string} [consumerId]
   * @returns {boolean}
   */
  standingAskIsUrgent(named, consumerId = "") {
    if (this.standingAskFor(named, consumerId) === 0) {
      return false;
    }
    return this.#host.standingAskOf(this.#host.outputs.pictureOf(named), consumerId)?.urgent === true;
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
    for (const consumerId of this.#host.consumersOn(base)) {
      if (consumerId && live.size > 0 && !live.has(consumerId)) {
        continue;
      }
      // No step chosen is the picture itself, which is on screen too.
      onScreen.add(this.#host.stepOnScreenOf(base, consumerId) ?? base.id);
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
