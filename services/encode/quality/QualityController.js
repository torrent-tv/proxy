/**
 * @file The quality budget of the outputs that exist: when a picture is asked to
 * move to another height, when its bitrate is capped by a viewer's measured link,
 * and what the player is told to follow.
 *
 * Moved out of the session manager whole (plan step 3). What it needs of the
 * rest of the proxy is the host object it is built with, and nothing else.
 */

import { logger } from "../../../utils/logger.js";
import { linkCouldCarry, loadOf } from "./link-budget.js";
import { qualityStateOf } from "./OutputQualityState.js";
import { drainThreat } from "./drain-threat.js";
import { visibleHeightCap } from "./visible-rung.js";

// How often the host's load and the torrents' download rates are sampled.
// A sampling period of the machine, not a quality decision: every decision
// about a viewer's quality is taken on that viewer's report.
export const BUDGET_CHECK_INTERVAL_MS = 5_000;
// Every quality step is judged on a report a viewer makes, for that viewer
// alone (roadmap item 98). DOWN: their buffer, on its present trend, would run
// dry before another output could have the piece they need (`drain-threat.js`),
// and the reason is one a smaller output removes — their link carries less
// than the stream, or this machine makes the picture slower than realtime
// over its own working time (`RunClock`). UP: their buffer is not draining,
// holds the time another output takes to be ready, the machine makes the
// picture at least at realtime, and their link carries the next height. A
// chosen threshold of slowness, a chosen window to sustain it, a window four
// times as long before stepping back up, a safety share of the link and a
// chosen test for a download-starved input stood here; all are gone. A manual
// viewer is never sent an automatic quality request.

/** @typedef {{ pathOf: (address: string, index: number) => string | null, sizesOf: (address: string) => Map<number, number> }} SegmentPathLookup */

export class QualityController {
  /** What this reads and asks of the rest of the proxy, and nothing else. @type {object} */
  #host;

  /** A sampling pass is under way; a timer tick that lands meanwhile is skipped. */
  #tickRunning = false;

  /** Viewers whose report is being judged now (`noteViewerReported`). @type {Set<string>} */
  #judging = new Set();

  /**
   * Viewers whose standing request the judgement of their current report asked
   * for again. A request stands for as long as the conditions it was asked
   * under hold, and only a judgement can say they do; one it did not repeat is
   * let go. @type {Set<string>}
   */
  #affirmed = new Set();

  /**
   * @param {object} host - `isLive`, `liveConsumers`, `liveRunsOf`, `producedNumbers`, `reportHostLoad`, `runStateOf`, `sampleDownloadRates`, `encodeCost`, `outputs`, `qualityOffer`, `segmentDurationSec`, `segmentPaths`, `videoEncoder`, `prepareSameHeightSwitch`, `sameHeightSwitchPending`, `sameHeightSwitchDirection`, `cancelSameHeightSwitch`, `heightReadyFor`, `bufferOf`, `visiblePictureOf`, `computedPreparationSec`
   * @param {SegmentPathLookup} host.segmentPaths - Lookup for completed
   *   segment paths needed by quality decisions.
   */
  constructor(host) {
    this.#host = host;
  }

  /**
   * One sampling pass: the host's load and the torrents' download rates.
   *
   * Public because it is an operation with a name, not an implementation detail
   * of a timer. It decides nothing about any viewer: an encoder's price is
   * learned when it closes a piece (`EncodeCost.learnFrom`), and a quality step
   * is judged on a viewer's report (`noteViewerReported`).
   *
   * @returns {Promise<void>}
   */
  async runQualityBudgetOnce() {
    void this.#host.reportHostLoad();
    // One tick at a time: the rates await torrent statistics per source, so a
    // slow answer would otherwise let the next tick in behind it and take the
    // same reading twice.
    if (this.#tickRunning === true) {
      return;
    }
    this.#tickRunning = true;
    try {
      // Taken whatever the encoder is: the torrent's price is charged against
      // this rate on every host, not only on the ones that re-encode.
      await this.#host.sampleDownloadRates();
    } finally {
      this.#tickRunning = false;
    }
  }

  /**
   * This output's processing speed now, over its run's own working time, or
   * null when no run has measured one. Copying and re-encoding alike; a copy
   * has no encoder a smaller picture would relieve, which is decided where
   * this is asked.
   *
   * @param {HlsSession} session
   * @returns {number | null}
   */
  #processingSpeedOf(session) {
    return this.#host.encodeCost.latestSpeedReadingOf(session)?.speed ?? null;
  }

  /**
   * How long another output of the mode on this viewer's screen takes to be
   * ready here, in seconds: as observed on this host (roadmap item 97, step
   * 14), and otherwise computed from this host's measured wait for a first
   * output and this output's own measured speed (torrent-tv/meta#3). Null
   * when neither can be said.
   *
   * @param {HlsSession} session
   * @returns {number | null}
   */
  #secondsToReady(session) {
    const observedMs = this.#host.observedPreparationMs?.(session) ?? null;
    if (Number.isFinite(observedMs) && observedMs >= 0) {
      return observedMs / 1000;
    }
    const computed = this.#host.computedPreparationSec?.(session) ?? null;
    return Number.isFinite(computed) && computed >= 0 ? computed : null;
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
    const affirmed = [];
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
      if (standing && standing.height === height) {
        this.#affirmed.add(consumerId);
        affirmed.push(consumerId);
        continue;
      }
      if (this.#host.askQualityOf(base, consumerId, height, reasonText, now, urgent)) {
        this.#affirmed.add(consumerId);
        asked.push(consumerId);
      }
    }
    if (asked.length === 0) {
      // Asked already and asked again: true, so a caller does not go on to say
      // that nothing could be prepared; nothing new is written.
      return affirmed.length > 0;
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
  async #checkStepUp(session, consumerId) {
    if (!this.#roomToSpare(session, consumerId)) {
      // A step up being prepared for a viewer who no longer has room is let go:
      // the conditions it was asked under have gone back (roadmap item 98).
      this.#dropUpAsk(session, consumerId, "the room it was asked for has gone");
      return;
    }
    const base = this.#host.outputs.pictureOf(session);
    const current = this.#host.outputs.variantHeightOf(session);
    const reasonText = `the machine and the link carry ${current}p with room to spare`;
    const move = await this.#host.prepareSameHeightSwitch(session, consumerId, "up", reasonText);
    if (move.started) {
      return;
    }
    // Refused because the MACHINE holds no more encoders: a higher height costs
    // more than the limit that was just refused, so it is not asked for.
    if (move.noPlace) {
      logger.info(`[budget] transcode ${session.id} no step up for ${consumerId}: ${move.reason}`);
      return;
    }
    // One rung at a time: the lowest height above the one on screen, never
    // above the source (upscaling invents detail and costs more than the source
    // itself). A rung this host has been measured failing at is not offered
    // (`QualityOffer`), so the step back up cannot return to it.
    const higher = this.#host.qualityOffer.nextHeightUp(base, current);
    if (higher === undefined) {
      return;
    }
    // Only where their OWN link admits the next rung, and the picture on their
    // screen is not already served by the rung they are on: a re-encode is never
    // made taller than the picture they see (roadmap item 98). The copy of the
    // source is not a re-encode, and going back to it is not bounded.
    const copied = this.#host.qualityOffer.copiedHeightOf(base);
    const cap = this.#visibleCapOf(base, consumerId);
    if (this.#linkAdmitsHeight(base, session, consumerId, higher) &&
      (higher === copied || cap === null || higher <= cap)) {
      this.#askQualityHeight(base, higher, reasonText, [consumerId]);
    }
  }

  /**
   * Whether this viewer has room for more, every term measured: the picture on
   * their screen is made at least at realtime over its run's own working time
   * (a copy is not limited by an encoder), their buffer is not draining, it
   * holds at least the time another output takes to be ready here, and no move
   * of theirs is already being prepared.
   *
   * @param {HlsSession} session
   * @param {string} consumerId
   * @returns {boolean}
   */
  #roomToSpare(session, consumerId) {
    if (!this.#onScreenHere(session, consumerId) || this.#host.sameHeightSwitchPending(consumerId)) {
      return false;
    }
    if (session.spec.transcodesVideo) {
      const speed = this.#processingSpeedOf(session);
      if (speed === null || speed < 1) {
        return false;
      }
    }
    const buffer = this.#host.bufferOf(session, consumerId, this.#host.segmentDurationSec);
    if (!buffer || !Number.isFinite(buffer.slope) || buffer.slope < 0) {
      return false;
    }
    const secondsToReady = this.#secondsToReady(session);
    return secondsToReady !== null && (buffer.bufferedSec ?? 0) >= secondsToReady;
  }

  /**
   * Whether this viewer's own link admits the whole load of a height nothing
   * may have produced yet.
   *
   * Nothing measured their link: no ground to refuse, the same silence that
   * stops `#checkSupply` from blaming their link.
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
      this.#host.viewerAudioLoadOf(base, consumerId),
      this.#host.serviceShare?.() ?? null
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
    this.#affirmed.delete(consumerId);
    const standingBefore = this.#host.standingAskOf(base, consumerId);
    try {
      await this.#judge(session, consumerId);
      // A request this judgement did not ask for again no longer has the
      // conditions it was asked under: their buffer stopped draining, the room
      // for a step up went, or the smaller picture is no longer smaller. It is
      // let go here, and their page drops the move it was preparing.
      const standing = this.#host.standingAskOf(base, consumerId);
      // The same request, not one made meanwhile: compared by what it is, since
      // it is read as a copy.
      const unchanged = standing && standingBefore &&
        standing.height === standingBefore.height && standing.at === standingBefore.at;
      if (unchanged && !this.#affirmed.has(consumerId)) {
        this.#host.dropAskOf(base, consumerId);
        logger.info(
          `[budget] transcode ${base.id} no longer asks ${consumerId} for ${standing.height}p: ` +
            `the conditions it was asked under (${standing.reason}) no longer hold`
        );
      }
    } finally {
      this.#affirmed.delete(consumerId);
      this.#judging.delete(consumerId);
    }
  }

  /**
   * One judgement of one viewer's report, in order: what they are given against
   * what keeps up, the picture they see, and the room for more.
   *
   * @param {HlsSession} session - The output on their screen.
   * @param {string} consumerId
   * @returns {Promise<void>}
   */
  async #judge(session, consumerId) {
    if (this.#host.videoEncoder?.kind === "software" &&
      (await this.#checkSupply(session, consumerId))) {
      return;
    }
    if (this.#checkVisiblePicture(session, consumerId)) {
      return;
    }
    if (this.#host.videoEncoder?.kind === "software") {
      await this.#checkStepUp(session, consumerId);
    }
  }

  /**
   * Whether this viewer's buffer can keep up with what they are given.
   *
   * THE CONDITION, every term measured: their buffer, on its present trend,
   * would run dry before another output could close the piece they need
   * (`drain-threat.js`), AND a smaller output removes the reason — their link
   * carries less than the stream they are given, or this machine makes the
   * picture slower than realtime over its run's own working time. A buffer
   * that falls without that threat moves nothing; a threat neither reason
   * explains (the swarm is short) is not answered with a smaller picture, which
   * reads the same input.
   *
   * THE LEVERS, in order: for the link, another limit of the height on their
   * screen (roadmap item 97, step 12), then a lower height; for the machine, a
   * lower height. A lower height is asked of their player as URGENT — their
   * page switches as soon as the rung is ready, without waiting for a cushion
   * that is shrinking. Where nothing can be prepared they stay where they are,
   * with no message.
   *
   * @param {HlsSession} session - The output on their screen.
   * @param {string} consumerId
   * @returns {Promise<boolean>} True when a move was started or asked for.
   */
  async #checkSupply(session, consumerId) {
    if (!this.#onScreenHere(session, consumerId)) {
      return false;
    }
    const buffer = this.#host.bufferOf(session, consumerId, this.#host.segmentDurationSec);
    const { threat, secondsToEmpty } = drainThreat({
      bufferedSec: buffer?.bufferedSec ?? 0,
      slope: buffer?.slope ?? null,
      reportGapSec: buffer?.reportGapSec ?? 0,
      secondsToReady: this.#secondsToReady(session)
    });
    if (!threat) {
      return false;
    }
    // Whatever else happens, a step UP prepared for them is not what they need.
    this.#dropUpAsk(session, consumerId, "their buffer is draining");
    if (this.#host.sameHeightSwitchDirection(consumerId) === "up") {
      this.#host.cancelSameHeightSwitch(consumerId, "their buffer is draining");
    }
    const report = this.#host.linkReportOf(session, consumerId);
    const observed = report ? await this.observedStreamMbps(session) : null;
    const linkShort = report !== null && report !== undefined && observed !== null && report.linkMbps < observed;
    const speed = session.spec.transcodesVideo ? this.#processingSpeedOf(session) : null;
    const machineShort = speed !== null && speed < 1;
    if (!linkShort && !machineShort) {
      return false;
    }
    if (this.#host.sameHeightSwitchPending(consumerId)) {
      return false; // a move down is already being prepared for them
    }
    const reasonText =
      (linkShort ? `link=${report.linkMbps.toFixed(2)}Mbps stream=${observed.toFixed(2)}Mbps ` : "") +
      (machineShort ? `CPU-bound speed=${speed.toFixed(2)}x ` : "") +
      `buffer=${(buffer?.bufferedSec ?? 0).toFixed(1)}s empty in ${secondsToEmpty === null ? "?" : secondsToEmpty.toFixed(1)}s ` +
      `for ${consumerId}`;
    if (linkShort) {
      const move = await this.#host.prepareSameHeightSwitch(session, consumerId, "down", `viewer-link-bound ${reasonText}`);
      if (move.started) {
        return true;
      }
      logger.info(`[budget] transcode ${session.id} ${reasonText}: no lower limit to move to (${move.reason})`);
    }
    const base = this.#host.outputs.pictureOf(session);
    if (this.#askLowerHeight(session, `${linkShort ? "viewer-link-bound" : "machine-bound"} ${reasonText}`, [consumerId], {
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
   * @returns {boolean} True when a move was asked for.
   */
  #checkVisiblePicture(session, consumerId) {
    if (!session.spec.transcodesVideo || !this.#onScreenHere(session, consumerId)) {
      return false;
    }
    const base = this.#host.outputs.pictureOf(session);
    const cap = this.#visibleCapOf(base, consumerId);
    if (cap === null || !this.#host.outputs.publishesVariants(base)) {
      return false;
    }
    const current = this.#host.outputs.variantHeightOf(session);
    const offered = this.#host.qualityOffer.offeredHeights(base);
    if (current > cap) {
      const target = this.#host.outputs.splicableHeights(base)
        .find((height) => height <= cap && offered.includes(height));
      if (target === undefined || !this.#host.heightReadyFor(base, consumerId, target)) {
        return false;
      }
      this.#askQualityHeight(base, target, `the picture they see (${cap}p) is smaller than ${current}p`, [consumerId]);
      return true;
    }
    return false;
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
   * Observed produced bitrate (Mbit/s): every finished piece of this output,
   * its bytes over its own length on the cut table. A published piece is
   * closed, so none is excluded, and no chosen number of recent pieces stands
   * in for the stream. Null while nothing is finished.
   *
   * @param {HlsSession} session
   * @returns {Promise<number | null>}
   */
  async observedStreamMbps(session) {
    // Every finished piece, each over its own length on the output's cut
    // table: a copy is cut at the source's keyframes, so its pieces are not
    // one length. The store knows their sizes; nothing is read from the disk.
    const sizes = this.#host.segmentPaths.sizesOf(session.outputKey ?? "");
    let bytes = 0;
    let seconds = 0;
    for (const [index, size] of sizes) {
      const length = session.timeline
        ? session.timeline.publishedStartOf(index + 1) - session.timeline.publishedStartOf(index)
        : this.#host.segmentDurationSec;
      if (size > 0 && length > 0) {
        bytes += size;
        seconds += length;
      }
    }
    return seconds > 0 ? (bytes * 8) / seconds / 1e6 : null;
  }

  /**
   * The height this proxy is asking the player to move to, or 0.
   *
   * Cleared the moment the viewer is on it — the request has been answered —
   * and let go by the judgement of their next report that does not ask for it
   * again (`noteViewerReported`): a request stands for as long as the
   * conditions it was asked under hold, not for a chosen time. A player that
   * cannot follow it reads it in every progress answer and does nothing, which
   * costs nothing; it is written to the log once, when it is made.
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
