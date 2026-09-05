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
     * Where they are.
     *
     * Set when they arrive, from the position their own request named, and
     * moved by the segments they ask for and by the seeks they report. Never
     * null for a viewer this process has met: "we do not know where they are"
     * is not a state a viewer can be in, because a viewer arrives by asking for
     * a position.
     *
     * `seeked` holds a position they STATED, for as long as they stay there,
     * which is the distinction a cold open's soundtrack placement turns on: a
     * request is evidence about where their player is reading, a seek is the
     * viewer saying where they are.
     *
     * @type {{ segment: number, seconds: number, at: number, seeked?: number | null } | null}
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
  }

  /**
   * Whether this viewer is still watching.
   *
   * Two ways to stop being present, and neither of them is "asked for nothing
   * recently". Something must have SAID they are gone, or nothing at all must
   * have been heard from them for longer than any silence a watching viewer can
   * produce.
   *
   * The second half exists only because the connection cannot always say: an
   * `onClosed` on a data channel does not always come, and a transport that is
   * not a data channel at all may have nothing to say. It is a backstop for a
   * missing statement, not the ordinary way a viewer leaves.
   *
   * @param {number} now
   * @param {number} staleAfterMs - Longer than any silence a watching viewer
   *   can produce. Derived from the cushion, never chosen here.
   * @returns {boolean}
   */
  isPresent(now, staleAfterMs) {
    if (this.gone) {
      return false;
    }
    return now - this.lastSeenAt <= staleAfterMs;
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
   * Where this viewer is, in seconds, or null when they have somehow never been
   * placed — which for a viewer created through `Viewers.of` cannot happen.
   *
   * @returns {number | null}
   */
  positionSeconds() {
    if (this.position === null) {
      return null;
    }
    return Number.isFinite(this.position.seeked) ? this.position.seeked : this.position.seconds;
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
