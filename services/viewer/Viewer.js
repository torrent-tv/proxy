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
 * **Nothing here knows about ffmpeg, the disk or the torrent.** A viewer states
 * what they want and where they are; what to make of that is the orchestrator's
 * question, and it reads a union of viewers rather than any one of them.
 */

export class Viewer {
  /**
   * @param {string} id - The consumer id the browser sends with every request
   *   that means "this viewer".
   */
  constructor(id) {
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
     * Where they are: the segment they last asked for, or the position they
     * stated by seeking. `seeked` holds the stated position for as long as they
     * stay there, which is the distinction a cold open's soundtrack placement
     * turns on.
     * @type {{ segment: number, seconds: number, at: number, seeked?: number } | null}
     */
    this.head = null;
    /** What their link was last measured to carry. @type {object | null} */
    this.netReport = null;
    /**
     * Every output this viewer is watching, by session id: the picture, the
     * quality step on their screen, the soundtrack they chose.
     *
     * This is one of the two sets that replaced a film object. There is no
     * "film" anywhere in this proxy — its parts are born at different times, die
     * at different times and are addressed separately — and the link fields that
     * stood in for one could not say how many people were listening to a
     * soundtrack. A viewer holds its outputs, an output holds its viewers, and
     * every question about who needs what is answered from those two.
     *
     * @type {Set<string>}
     */
    this.outputs = new Set();
  }

  /**
   * Whether this viewer has been heard from recently enough to still be
   * watching.
   *
   * Nothing releases a session when a channel closes, so without this a viewer
   * whose tab is gone would hold a soundtrack or a quality step for the whole
   * life of the session.
   *
   * @param {number} now
   * @param {number} staleAfterMs
   * @returns {boolean}
   */
  isLive(now, staleAfterMs) {
    return this.head !== null && now - this.head.at <= staleAfterMs;
  }

  /**
   * Where this viewer is, in seconds, or null when they have never said.
   *
   * @returns {number | null}
   */
  positionSeconds() {
    if (this.head === null) {
      return null;
    }
    return Number.isFinite(this.head.seeked) ? this.head.seeked : this.head.seconds;
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
  return viewer;
}
