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
    /** A soundtrack being prepared for the same reason. @type {string | null} */
    this.warmingAudioId = null;
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
     * Every output this viewer is watching, by session id: the picture, the
     * quality step on their screen, the soundtrack they chose.
     *
     * WHY THERE ARE TWO SETS AND NOT ONE. There is one relation — this person
     * watches this output — and it is asked from both ends. An output asks "has
     * anybody left?", to decide whether to go on producing. A viewer who leaves
     * asks "what was I watching?", so that each of those outputs can be told.
     * Neither question can be answered from the other side without walking every
     * session in the process, so the relation is indexed both ways. It is
     * written in exactly one place — `Viewers.of` and `Viewers.leaves` write
     * both directions together — which is what keeps two indexes of one relation
     * from becoming two different answers.
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
    // Whether the picture is moving. A viewer who has stopped it consumes
    // nothing, so nothing in front of them ever becomes due — they have no
    // deadline at all, and the work goes to whoever is watching. The page knows
    // this exactly and says it outright; inferring it from a position that has
    // not moved takes two reports and lies whenever a browser holding a full
    // cushion goes quiet between segments, which it does.
    this.playing = true;
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
    // Seconds of film held ahead of the picture, as the page last said.
    this.bufferedSeconds = null;
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
    this.position = { seconds, at: now };
    this.lastSeenAt = now;
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
   * @param {number} report.linkMbps
   * @param {number} report.bufferedAheadSec
   * @param {number | null} [report.positionSeconds] - Null from a page that
   *   does not say; then the position stands as it was.
   * @param {boolean} [report.playing] - Absent from a page that does not say;
   *   then the viewer counts as playing, which is what every page meant before
   *   it could say otherwise.
   * @param {boolean} [report.onScreen] - Whether the page is visible, or the
   *   picture is in picture-in-picture. Absent means on screen.
   * @param {boolean} [report.inPictureInPicture] - Whether the picture has been
   *   pulled out of the page, which is watching it with the tab hidden.
   * @param {number} [now]
   */
  report(
    {
      linkMbps,
      bufferedAheadSec,
      positionSeconds = null,
      playing,
      onScreen,
      inPictureInPicture
    },
    now = Date.now()
  ) {
    this.netReport = {
      linkMbps,
      bufferedAheadSec,
      positionSeconds:
        Number.isFinite(positionSeconds) && positionSeconds >= 0 ? positionSeconds : null,
      at: now
    };
    this.bufferedSeconds = bufferedAheadSec;
    this.playing = playing === undefined ? true : Boolean(playing);
    this.inPictureInPicture = inPictureInPicture === undefined ? false : Boolean(inPictureInPicture);
    this.onScreen = onScreen === undefined ? true : Boolean(onScreen);
    if (Number.isFinite(positionSeconds) && positionSeconds >= 0) {
      this.moveTo(/** @type {number} */ (positionSeconds), now);
    }
    this.seen(now);
  }

  /**
   * When this viewer runs out of what they hold, in milliseconds.
   *
   * Film is consumed at one second per second while the picture moves, so the
   * moment they run dry is now plus what they hold. Stopped, they consume
   * nothing and there is no such moment — which is why a pause needs no rule of
   * its own anywhere: it falls out of this as an absent deadline.
   *
   * @param {number} [now]
   * @returns {number | null}
   */
  deadlineAt(now = Date.now()) {
    if (!this.playing) {
      return null;
    }
    const held = Number.isFinite(this.bufferedSeconds) ? Math.max(0, this.bufferedSeconds) : 0;
    return now + held * 1000;
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
   * Whether this viewer is CONSUMING film.
   *
   * Two ways of not consuming, and neither is absence: the picture is stopped,
   * or the page is not on screen. Both mean nothing in front of them ever falls
   * due, so the work goes to whoever is watching — and both leave them a place
   * in the priority map, because they are still there and will want it again.
   *
   * Picture-in-picture is watching with the tab hidden, and the page folds that
   * into `onScreen` before it says it, so it needs no case of its own here.
   *
   * @returns {boolean}
   */
  consumesFilm() {
    return this.playing !== false && this.onScreen !== false;
  }

  isPresent() {
    return this.gone !== true;
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
   *   position(now) = stated + rate * (now - statedAt),   rate = playing ? 1 : 0
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
    const rate = this.playing ? 1 : 0;
    const elapsedSec = Math.max(0, (now - this.position.at) / 1000);
    return this.position.seconds + rate * elapsedSec;
  }
}

/**
 * The viewers of one session, made on first use.
 *
 * @param {object} session
 * @returns {Map<string, Viewer>}
 */
export function viewersOf(session) {
  if (!(session.viewers instanceof Map)) {
    session.viewers = new Map();
  }
  return session.viewers;
}

/**
 * The viewer with this id, made if this session has not met them before.
 *
 * Use `Viewers.of` instead wherever a registry is at hand: this makes ONE
 * viewer per session, so the same person watching a picture, a quality step and
 * a soundtrack is three objects, and `outputs` — a fact about the person — is
 * then three sets that nothing keeps in step. It is kept for a session assembled
 * by hand in a test that has no registry.
 *
 * @param {object} session
 * @param {string} consumerId
 * @returns {Viewer}
 */
export function viewerOf(session, consumerId) {
  const viewers = viewersOf(session);
  let viewer = viewers.get(consumerId);
  if (!viewer) {
    viewer = new Viewer(consumerId);
    viewers.set(consumerId, viewer);
  }
  viewer.outputs.add(session.id);
  return viewer;
}
