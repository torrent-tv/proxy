/**
 * @file One person watching, and everything that is true of them alone.
 *
 * A viewer is not a property of the material. What they are listening to, which
 * quality step they have on screen, what is being prepared for them, where they
 * are and what their link can carry — none of it changes a byte of what any
 * encoder produces, and none of it belongs to a session, which is a description
 * of an OUTPUT.
 *
 * It was six parallel maps hung on the session, each keyed by consumer id:
 * `audioChoiceByConsumer`, `activeVariantByConsumer`,
 * `warmingVariantByConsumer`, `warmingAudioByConsumer`, `consumerHeads`,
 * `netReports`. Six places to remember to update and six to remember to forget,
 * and the forgetting was already wrong — releasing a consumer emptied none of
 * them, so a viewer who had left went on counting as wanting their soundtrack
 * until their head expired, and their entries stayed for the life of the
 * session.
 *
 * One object, one map, one thing to remove.
 *
 * **TWO INDEPENDENT FACTS, NOT ONE.** A viewer is somewhere, and a viewer is
 * either still here or gone. Until 2026-09-05 both were answered by one field —
 * the position, which is written only when a segment is requested — so a viewer
 * who had just arrived counted as absent, and an output all of whose viewers
 * count as absent has every encoder on it stopped. That is exactly what
 * happened on 2026-09-05: a soundtrack's encoder was stopped 1.25 s after it
 * started, having produced nothing, its `init.mp4` was therefore never made,
 * and the picture could not be played without it. The browser could not rescue
 * itself either, because the only thing that would have marked the viewer
 * present was a request for a segment — which needs the `init.mp4` that the
 * stopped encoder was going to make.
 *
 * So: **position is known from the moment a viewer arrives** — it is in the
 * request that created the output, as a time on the source, and it is either
 * zero or what the address bar carried. And **presence is a fact of the
 * connection**, not of the last file asked for.
 *
 * **Nothing here knows about ffmpeg, the disk or the torrent.** A viewer states
 * what they want and where they are; what to make of that is the orchestrator's
 * question, and it reads a union of viewers rather than any one of them.
 */

import { Assignments } from "./Assignments.js";
import { bufferTrend, trendRunStart } from "./buffer-trend.js";

/**
 * How long a generation this viewer has left behind goes on accepting NEW
 * requests.
 *
 * A CHOSEN NUMBER, and it is named here rather than buried so that it reads as
 * one. It cannot be derived today: it should come from the player's own retry
 * policy, and this product overrides that policy on its own page while the
 * native path in Safari has none at all that can be read. Until the retries a
 * real player actually makes are measured, the value is given and the checks
 * are written against what is given.
 *
 * What it protects: a request made just before a seek, still in flight when the
 * seek lands, is answered by the output it was made against instead of being
 * decided again against a position the viewer has already left.
 */
export const ACCEPT_WINDOW_MS = 30_000;

export class Viewer {
  /**
   * @param {string} id - The consumer id the browser sends with every request
   *   that means "this viewer".
   * @param {number} [now] - When they arrived. Presence starts here, so a
   *   viewer counts as watching from the instant they are known.
   */
  constructor(id, now = Date.now()) {
    this.id = String(id ?? "");
    /**
     * Which soundtrack this viewer is listening to and whether their browser
     * needs it re-encoded. Theirs alone: two viewers of one picture may have
     * chosen different languages, and one browser may decode a track another
     * cannot.
     * @type {{ trackIndex: number, transcode: boolean }}
     */
    this.audio = { trackIndex: 0, transcode: false };
    /** The quality step on their screen. Null means the base session. @type {string | null} */
    this.activeVariantId = null;
    /** A step being prepared for a switch they have not made yet. @type {string | null} */
    this.warmingVariantId = null;
    /**
     * When the warming of that step began, so the time a move takes to be
     * ready can be kept (roadmap item 97, step 14). @type {number | null}
     */
    this.warmingSince = null;
    /** A soundtrack being prepared for the same reason. @type {string | null} */
    this.warmingAudioId = null;
    /**
     * An output of the height on their screen, at another bitrate limit, being
     * prepared so that their NEXT segments come from it (roadmap item 97, step
     * 12). Not `warmingVariantId`: that is a step their player will switch to,
     * and the page says when it has. Here the address does not change, the
     * player is never told, and the switch is made on this side once the
     * segment they will ask for next is closed on the new output.
     *
     * `askedHeights` are the heights their player asks for under which the
     * output on screen is chosen — a step is chosen under the height asked and
     * named after the height produced, so there can be more than one — and the
     * move replaces the choice under each; `direction` is why it was started.
     *
     * @type {{ askedHeights: number[], outputId: string, outputKey: string, direction: "down" | "up", reason: string, since: number } | null}
     */
    this.sameHeightSwitch = null;
    /**
     * Where their picture stood when they last said so, and when they said it.
     *
     * ONE FACT WITH ONE WRITER: the viewer. It is set when they arrive — from
     * the position their own create request named — and moved only by what they
     * state afterwards, a seek or a report carrying their playhead. Never null
     * for a viewer this process has met, because a viewer arrives by asking for
     * a position.
     *
     * A REQUEST FOR A SEGMENT IS NOT A POSITION and never writes here. It says
     * how far their buffer has reached, which is a different quantity and one
     * nothing in the plan needs: a segment either exists and is served, or does
     * not and is waited for.
     *
     * Two writers is what this replaced, and the cost is measured. Until
     * 2026-09-13 a seek wrote `seeked` while a request wrote `seconds`, and
     * `positionSeconds` preferred whichever was set — so the two took turns and
     * the priority map jumped back and forth by one or two segments several
     * times a second. Field that day, one output over one second:
     * `p100:#9..#10`, `p100:#18..#20`, `p100:#16..#18`, `p100:#18..#20`, with
     * the second viewer stopped dead at 1673.6 s throughout. The encoder
     * placement followed the map, as it must, and the machine spent six minutes
     * on 77 starts and 141 stops against one normal end.
     *
     * @type {{ seconds: number, at: number } | null}
     */
    this.position = null;
    /**
     * When this viewer was last known to be there.
     *
     * Every piece of evidence refreshes it: a request of any kind, a link
     * report, an echo of a delivery probe. It is NOT the position's timestamp —
     * a viewer with a full buffer legitimately asks for nothing for a minute
     * and is no less present for it.
     *
     * @type {number}
     */
    this.lastSeenAt = now;
    /**
     * Set when something has SAID this viewer is gone — the browser released
     * the session, or their connection closed. Silence never sets it: a
     * paused viewer, a viewer whose tab is hidden and whose timers the browser
     * has throttled, and a viewer holding two minutes of buffer are all silent
     * and all still watching.
     *
     * @type {boolean}
     */
    this.gone = false;
    /** What their link was last measured to carry. @type {object | null} */
    this.netReport = null;
    /**
     * "manual" while the size on their screen was picked by hand, "auto" while
     * it is the automatic choice, null until their page has said.
     *
     * @type {"auto" | "manual" | null}
     */
    this.qualityMode = null;
    /**
     * The height the quality budget last asked THIS viewer's player to move
     * to, while the request stands. Created only in AUTO (`askQuality`), read
     * back only by this viewer's own progress poll, and let go once they are
     * there, once it has run out, or once they are no longer in AUTO.
     *
     * `urgent` when their buffer would run dry before anything else could
     * arrive: their page then switches without waiting for a cushion.
     *
     * @type {{ height: number, at: number, reason: string, urgent: boolean } | null}
     */
    this.qualityAsk = null;
    /**
     * Every output this viewer is watching, by session id: the picture, the
     * quality step on their screen, the soundtrack they chose.
     *
     * THE ONLY STORED FORM of the relation "this person watches this output".
     * The question from the other end — who watches this output — is answered
     * by `Viewers.forOutput`, which derives it from these sets. It used to be a
     * second index kept beside this one, and two stored copies of one relation
     * are two answers that can disagree. The registry is small, so deriving is
     * cheaper than keeping the copies in step.
     *
     * This is what replaced a film object. There is no "film" anywhere in this
     * proxy — its parts are born at different times, die at different times and
     * are addressed separately — and the three link fields that stood in for one
     * could not say how many people were listening to a soundtrack.
     *
     * @type {Set<string>}
     */
    this.outputs = new Set();
    /**
     * Which output answers THIS viewer, and for how long that stands.
     *
     * Their own, which is the whole of roadmap item 97: the record it replaces
     * — one entry per file and height, read by everybody — meant a viewer on a
     * thin link decided for a viewer on a thick one. What it holds and why each
     * fact is there is in `Assignments.js`.
     *
     * @type {Assignments}
     */
    this.assignments = new Assignments({ acceptWindowMs: ACCEPT_WINDOW_MS });
    /**
     * On what the output this viewer was last given was judged: the verdict of
     * their own link against its whole load, and the figures. `estimated to
     * fit` is admitted and NOT confirmed — the figure is an average, not a
     * bound — and the page is told so rather than left to assume it.
     * @type {object | null}
     */
    this.servingVerdict = null;
    /**
     * The files this viewer has subtitles switched on for, as
     * `sourceKey:fileIndex`.
     *
     * A subscription is a fact about a PERSON, not about a channel. Held on the
     * channel — as it was until now — it dies with the channel, so a seamless
     * reconnect silently lost subtitles for the rest of the session, and a
     * transport that rotates its association on purpose would lose them every
     * time it rotated. Held here it survives both by construction: whatever
     * channel this viewer is reachable on next, they are still subscribed.
     *
     * @type {Set<string>}
     */
    this.wantsCuesFor = new Set();
    // WHETHER THE PICTURE IS MOVING, and separately WHETHER THIS VIEWER IS
    // BLOCKED ON US. Two booleans, because there are three states and one
    // boolean cannot hold them:
    //
    //   playing        the picture advances, a second of film per second;
    //   waiting        it does not advance because we have not delivered;
    //   neither        the viewer stopped it themselves.
    //
    // Collapsed into one, the middle state read as the third: a viewer frozen
    // for want of a segment counted as somebody who had chosen to stop, so
    // nothing in front of them fell due and the work went to whoever was
    // playing. That is backwards — a viewer waiting on us is the most urgent
    // there is. The page tells the two apart exactly (its element says whether
    // the picture advances, and the component owns the viewer's own pause) and
    // states both.
    //
    // `playing` STARTS FALSE, and that is the whole of the fault of
    // 2026-09-14. It used to start true, and the position is carried forward by
    // the clock at that rate, so a viewer who had never said anything walked
    // 146 seconds into a film they had not begun: the tab was hidden, the page
    // deliberately held start-up until it was shown, and this end assumed the
    // film was running the entire time. A statement about somebody else's
    // machine is theirs to make. Until they make it the rate is zero.
    //
    // `waiting` STARTS TRUE, which is what a viewer arriving is: they have
    // asked for a film and hold none of it. So their work is made first from
    // the instant they arrive, without the position ever being invented.
    this.playing = false;
    this.waiting = true;
    // Whether the page carrying this viewer is ON SCREEN, and whether the
    // picture has been pulled out of it.
    //
    // Two facts, not one, and the second is why the first is not enough: a
    // hidden tab has its timers throttled by the browser — 800 ms of event-loop
    // lag measured in the field — so it asks for nothing and looks exactly like
    // a viewer holding a full cushion. Delivery stood still for the last six
    // minutes of the session of 2026-09-08 and nothing anywhere said the tab had
    // gone away. But a picture in picture-in-picture is watched WHILE the tab is
    // hidden, so hiding alone cannot mean "not watching".
    //
    // A page that says nothing is on screen, which is what every page meant
    // before it could say otherwise.
    this.onScreen = true;
    this.inPictureInPicture = false;
    // Seconds of film held ahead of the picture, as the page last said. It is
    // measured at the moment the position beside it was, which is what makes it
    // the bound on carrying that position forward — see `positionSeconds`.
    this.bufferedSeconds = null;
    /**
     * What the page said it held, and when, since this viewer last moved to
     * another place in the film — what the buffer's trend is read from
     * (`buffer-trend.js`). A seek empties the buffer, so what came before it
     * says nothing about what comes after.
     *
     * @type {Array<{ at: number, seconds: number }>}
     */
    this.bufferReadings = [];
    /** The span the trend was last asked over; readings older than its run are let go. @type {number} */
    this.trendSpanSec = 0;
    /**
     * The picture as this viewer sees it, in physical pixels: the frame that
     * would be shown without being enlarged, as their page measured it. The
     * upper bound of the height of a re-encoded output made for them (roadmap
     * item 98). Null until their page has said.
     *
     * @type {{ width: number, height: number } | null}
     */
    this.visiblePicture = null;
  }

  /**
   * Where they are, in SECONDS of film, and nothing else.
   *
   * A segment number cannot live here: the picture and the soundtrack of one
   * film are cut independently and into different numbers of pieces — 454
   * against 401 on the field file of 2026-09-05 — so piece 48 of one is not the
   * same moment as piece 48 of the other. Whoever holds a cut grid turns these
   * seconds into their own numbers.
   *
   * @param {number} seconds
   * @param {number} [now]
   */
  moveTo(seconds, now = Date.now()) {
    if (!Number.isFinite(seconds) || seconds < 0) {
      return;
    }
    this.#place(seconds, now);
    // The buffer's history belongs to the place they left.
    this.bufferReadings = [];
    // WHAT THEY HELD AT THE PLACE THEY LEFT SAYS NOTHING ABOUT THE PLACE THEY
    // ARRIVED AT. A seek empties the buffer by construction — the player
    // discards what it holds and fetches from the new position — so carrying
    // the old cushion over would license the position to run forward again from
    // material that no longer exists. Zero is the truthful floor until they say
    // otherwise, and a viewer who has just seeked says so within a tick.
    this.bufferedSeconds = 0;
  }

  /**
   * Where they are, stated — without anything a move to another place means.
   *
   * @param {number} seconds
   * @param {number} now
   * @returns {void}
   */
  #place(seconds, now) {
    this.position = { seconds, at: now };
    this.lastSeenAt = now;
  }

  /**
   * Which way their buffer is going, over the shortest run of their reports
   * that spans `spanSec`, and the interval between their last two reports.
   * Readings older than that run are let go: the run only ever moves forward.
   *
   * @param {number} spanSec - The segment duration of the output they watch.
   * @returns {{ slope: number, reportGapSec: number } | null}
   */
  bufferTrend(spanSec) {
    this.trendSpanSec = spanSec;
    const start = trendRunStart(this.bufferReadings, spanSec);
    if (start > 0) {
      this.bufferReadings = this.bufferReadings.slice(start);
    }
    return bufferTrend(this.bufferReadings, spanSec);
  }

  /**
   * Everything a viewer says about itself, in one statement.
   *
   * The page sends four things together — how fast its link measured, how much
   * film it holds, where the picture is, and whether the picture is moving —
   * and all four are facts about this viewer. Taking them apart and assigning
   * them one by one somewhere else is how they came to be spread over five
   * places, two of them on a session shared with other people.
   *
   * @param {object} report
   * @param {number} [report.linkMbps] - What their link last measured. Absent
   *   until something measurable has crossed it, and then the rest of the
   *   report still stands: this is a statement about a viewer, not about a link.
   * @param {number} report.bufferedAheadSec
   * @param {number} [report.bufferLimitSeconds] - The largest forward buffer
   *   this browser accepted for the current player.
   * @param {number | null} [report.positionSeconds] - Null from a page that
   *   does not say; then the position stands as it was.
   * @param {boolean} [report.playing] - Whether the picture is advancing.
   *   Absent means it was not stated, and nothing may be assumed about somebody
   *   else's machine: the rate is then zero.
   * @param {boolean} [report.waiting] - Whether this viewer is blocked on
   *   material we owe them. Absent from a page one release behind; then it is
   *   derived from the two facts that page does state.
   * @param {boolean} [report.onScreen] - Whether the page is visible, or the
   *   picture is in picture-in-picture. Absent means on screen.
   * @param {boolean} [report.inPictureInPicture] - Whether the picture has been
   *   pulled out of the page, which is watching it with the tab hidden.
   * @param {number} [now]
   */
  report(
    {
      linkMbps,
      linkSampleMbps = null,
      linkSampleAt = null,
      bufferedAheadSec,
      bufferLimitSeconds,
      positionSeconds = null,
      playing,
      waiting,
      onScreen,
      inPictureInPicture,
      qualityMode,
      visiblePicture
    },
    now = Date.now()
  ) {
    this.noteVisiblePicture(visiblePicture);
    // Whether the size on their screen was picked by hand or is the automatic
    // choice. Kept only when stated: a page one release behind says nothing,
    // and is taken as picking, which is what every page was before.
    if (qualityMode === "auto" || qualityMode === "manual") {
      this.qualityMode = qualityMode;
    }
    const held = Number.isFinite(bufferedAheadSec) && bufferedAheadSec > 0 ? bufferedAheadSec : 0;
    // A LINK FIGURE IS ONE FIELD OF THIS REPORT AND NOT ITS TICKET. A page that
    // has transferred nothing measurable has nothing to say about its link and
    // everything to say about its viewer, and that is the cold open exactly —
    // the moment the position matters most. Held as a precondition, in three
    // places at once, it silenced every statement of the session of 2026-09-14.
    const hasLinkMeasurement = Number.isFinite(linkMbps) && linkMbps > 0;
    const lastLinkMbps = hasLinkMeasurement ? linkMbps : this.netReport?.linkMbps ?? null;
    const linkMeasuredAt = hasLinkMeasurement ? now : this.netReport?.linkMeasuredAt ?? null;
    const sampleMbps = Number(linkSampleMbps);
    const sampleAt = Number(linkSampleAt);
    const hasPlaybackSample = Number.isFinite(sampleMbps) && sampleMbps > 0 &&
      Number.isFinite(sampleAt) && sampleAt > 0;
    const newerPlaybackSample = hasPlaybackSample && sampleAt > (this.netReport?.linkSampleAt ?? 0);
    this.netReport = {
      linkMbps: lastLinkMbps,
      linkMeasuredAt,
      linkSampleAt: newerPlaybackSample ? sampleAt : this.netReport?.linkSampleAt ?? null,
      linkSampleMbps: newerPlaybackSample ? sampleMbps : this.netReport?.linkSampleMbps ?? null,
      linkSampleMeasuredAt: newerPlaybackSample ? now : this.netReport?.linkSampleMeasuredAt ?? null,
      bufferedAheadSec: held,
      bufferLimitSeconds: Number.isFinite(bufferLimitSeconds) && bufferLimitSeconds > 0
        ? bufferLimitSeconds
        : this.netReport?.bufferLimitSeconds ?? null,
      positionSeconds:
        Number.isFinite(positionSeconds) && positionSeconds >= 0 ? positionSeconds : null,
      at: now
    };
    // Where the picture is now. A report states a place the viewer has played
    // to, not a place they moved to: their buffer's history stands.
    if (Number.isFinite(positionSeconds) && positionSeconds >= 0) {
      this.#place(/** @type {number} */ (positionSeconds), now);
    }
    this.bufferedSeconds = held;
    this.bufferReadings.push({ at: now, seconds: held });
    // Kept only as far back as the last trend asked needs: its run only moves
    // forward. Before a trend has been asked for, nothing is let go.
    if (this.trendSpanSec > 0) {
      const start = trendRunStart(this.bufferReadings, this.trendSpanSec);
      if (start > 0) {
        this.bufferReadings = this.bufferReadings.slice(start);
      }
    }
    this.playing = playing === true;
    // A page that states `playing` and not `waiting` is one release behind this
    // proxy, which is the ordinary state of a rolling pool — the proxy ships
    // first by rule. It says `false` for both a viewer who stopped the picture
    // and a viewer starved of material, so the two are told apart by the one
    // quantity it does state: a stopped viewer holding film chose to stop, a
    // stopped viewer holding nothing is waiting on us. It errs toward making
    // material, which is the direction that costs an encoder rather than a
    // viewer.
    this.waiting = waiting === undefined ? this.playing === false && held === 0 : waiting === true;
    this.inPictureInPicture = inPictureInPicture === undefined ? false : Boolean(inPictureInPicture);
    this.onScreen = onScreen === undefined ? true : Boolean(onScreen);
    this.seen(now);
  }

  /**
   * Whether this viewer is here.
   *
   * PRESENCE IS THE CONNECTION, AND ONLY THE CONNECTION. They are here from the
   * moment they are known until something SAYS they are gone: the browser
   * releasing the session, or their connection closing. Nothing else, and in
   * particular not silence.
   *
   * Silence used to end it, after an interval longer than "any silence a
   * watching viewer can produce" — and there is no such interval. A viewer who
   * has paused, whose tab is hidden and whose timers the browser has throttled,
   * or who holds two minutes of cushion, all say nothing for as long as they
   * like and are all still watching. Deciding presence from that made it a
   * guess with a threshold; deciding it from the connection makes it a fact
   * with an owner.
   *
   * @returns {boolean}
   */
  /**
   * What this viewer's link was last measured to carry, or null when it has
   * never been measured.
   *
   * IT DOES NOT EXPIRE, and the reasoning is the correction of 2026-09-14. A
   * reading older than a chosen thirty seconds used to be discarded here, which
   * put two facts under one number: how fast the link is, and whether we are
   * still hearing from this page.
   *
   * The speed persists. A link does not stop being what it was measured to be
   * because nobody measured it for a minute, and the page says as much by
   * keeping its own last figure for ever rather than reporting nothing. It is
   * measured once when the connection comes up and corrected by every transfer
   * afterwards — one estimate, continuously refined, never a fact with a
   * deadline.
   *
   * Whether the reading is still somebody's is PRESENCE, which has its own
   * owner: a viewer who has gone is removed from the output, and the readings
   * walked for a decision are only those of people still there. Answering both
   * questions in one place is what stopped a soundtrack's encoder on
   * 2026-09-05.
   *
   * @returns {{ linkMbps: number | null, bufferedAheadSec: number, bufferLimitSeconds: number | null, positionSeconds: number | null, at: number } | null}
   */
  linkReading() {
    return this.netReport;
  }

  /**
   * Whether this viewer wants film NOW — either watching it or waiting for it.
   *
   * The one predicate every reading about urgency asks, and it is a union of
   * two states rather than the negation of a pause:
   *
   *   playing        consuming, and will run dry when their cushion does;
   *   waiting        consuming nothing only because we have delivered nothing;
   *   neither        they stopped the picture themselves.
   *
   * A viewer who has stopped it keeps their place in the priority map — they
   * are still there and will want the film in front of them again — but nothing
   * of theirs falls due, so the work goes to whoever is watching or waiting.
   *
   * A page that is not on screen is not consuming: its timers are throttled and
   * it asks for nothing, which is indistinguishable from a full cushion.
   * Picture-in-picture is watching with the tab hidden, and the page folds that
   * into `onScreen` before saying it, so it needs no case of its own here.
   *
   * @returns {boolean}
   */
  wantsFilmNow() {
    return (this.playing === true || this.waiting === true) && this.onScreen !== false;
  }

  isPresent() {
    return this.gone !== true;
  }

  /**
   * This viewer has gone, and everything that means.
   *
   * ONE STATEMENT rather than a field three callers set, because it is no
   * longer only a field: the outputs their assignments were holding must stop
   * being held, and a caller that set `gone` alone would leave an output alive
   * with nobody left to serve. A response still in flight goes with them —
   * the connection it was being sent over is what went.
   *
   * @returns {void}
   */
  markGone() {
    this.gone = true;
    this.assignments.clear();
  }

  /**
   * Ask this viewer's player to move to another height.
   *
   * Refused outside AUTO, and that refusal is the rule itself rather than a
   * check at each caller: a height picked by hand is never moved by the budget,
   * and a page that has not said its mode is treated as a manual one.
   *
   * @param {number} height
   * @param {string} reason
   * @param {number} now
   * @param {boolean} [urgent] - Their buffer would run dry before anything else
   *   could arrive.
   * @returns {boolean} Whether a request now stands.
   */
  askQuality(height, reason, now, urgent = false) {
    if (this.qualityMode !== "auto") {
      this.qualityAsk = null;
      return false;
    }
    this.qualityAsk = { height, at: now, reason, urgent: urgent === true };
    return true;
  }

  /**
   * Take the picture as their page measured it. A size that is not a positive
   * width and height leaves the one they had.
   *
   * @param {unknown} value
   * @returns {boolean} Whether it changed.
   */
  noteVisiblePicture(value) {
    const width = Math.round(Number(/** @type {{ width?: unknown }} */ (value)?.width));
    const height = Math.round(Number(/** @type {{ height?: unknown }} */ (value)?.height));
    if (!(width > 0 && height > 0)) {
      return false;
    }
    if (this.visiblePicture && this.visiblePicture.width === width && this.visiblePicture.height === height) {
      return false;
    }
    this.visiblePicture = { width, height };
    return true;
  }

  /**
   * Let the standing request go.
   *
   * @returns {void}
   */
  dropQualityAsk() {
    this.qualityAsk = null;
  }

  /**
   * Note that this viewer has been heard from.
   *
   * @param {number} [now]
   * @returns {void}
   */
  seen(now = Date.now()) {
    this.lastSeenAt = now;
  }

  /**
   * Where this viewer is NOW, in seconds of film.
   *
   * A FUNCTION OF TIME, not a stored number. A viewer whose picture is moving
   * covers a second of film every second, so between the moments they speak
   * their position is known exactly — it is where they last were plus the time
   * since. A viewer whose picture is stopped covers nothing and stays where
   * they are, which is the same formula with the rate at zero.
   *
   *   position(now) = stated + rate * min(now - statedAt, held),
   *                                              rate = playing ? 1 : 0
   *
   * **THE SECOND TERM IS BOUNDED BY WHAT THEY HELD**, and the bound is stated
   * by the viewer rather than chosen here: nobody can play past the end of what
   * they have. A viewer who said "I hold thirty seconds" and has said nothing
   * for two minutes has played at most thirty of those seconds; the rest of the
   * silence is a viewer who ran dry, or one we are no longer hearing from, and
   * in both cases they are not where the clock alone would put them.
   *
   * Unbounded, it walks a viewer off the end of a film they never started. On
   * 2026-09-14 the tab was hidden for 145 seconds while the page deliberately
   * held start-up until it was shown, the rate was assumed to be one, and this
   * end placed the viewer at 145.979 s — the exact `-ss` the soundtrack's
   * encoder was given, while the browser was asking for segment #0 and getting
   * 503 for sixty seconds. Their cushion was 0.0 s throughout, so this bound
   * alone would have held them at zero whatever the rate said.
   *
   * The bound binds only where the clock has outrun the cushion — a report lost,
   * or a viewer starving — and there it under-states the position. That is the
   * safe direction and deliberately so: under-stating makes material a viewer
   * has already passed, which costs an encoder; over-stating skips material
   * they are about to need, which costs the viewer the picture.
   *
   * Held as a stored number instead, it was a staircase: flat for the ten
   * seconds between reports and then a jump, so everything derived from it —
   * the priority map, and through the map every encoder — changed in steps for
   * a viewer who was moving smoothly. And because two writers were filling that
   * number in turn, the steps went backwards as often as forwards.
   *
   * There is nothing to tune here and no state to keep: one reading, one clock,
   * one rate the page itself states.
   *
   * @param {number} [now]
   * @returns {number | null} Null only for a viewer never placed, which for one
   *   created through `Viewers.of` cannot happen.
   */
  positionSeconds(now = Date.now()) {
    if (this.position === null) {
      return null;
    }
    const rate = this.playing === true ? 1 : 0;
    const elapsedSec = Math.max(0, (now - this.position.at) / 1000);
    const held = Number.isFinite(this.bufferedSeconds) ? Math.max(0, this.bufferedSeconds) : 0;
    return this.position.seconds + rate * Math.min(elapsedSec, held);
  }
}
