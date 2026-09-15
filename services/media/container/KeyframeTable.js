/**
 * @file Where one file's keyframes are.
 *
 * A property of immutable bytes, like the duration and the track list: the same
 * for the picture and for every quality step of it, the same for one viewer and
 * for five, and unchanged while anybody is watching. So there is ONE of these
 * per file and everyone who reads that file is handed the same one — not a copy
 * of its contents. That is what lets a table that arrives late reach sessions
 * created before it: the object they hold is the object that was filled in.
 * `Timeline` is held the same way and for the same reason.
 *
 * **Why an object and not three fields.** The three travel together and are
 * meaningless apart. The times alone cannot be used to seek: AVI stores frame
 * NUMBERS and states the time as that number times the frame duration, which
 * lands 10-44 ms from the presentation time the demuxer computes (measured
 * 2026-08-21), so a seek made at such a name can fall just below the real
 * keyframe and land on the one before it. And a refusal that does not name the
 * container it is refusing says nothing about the file it is refusing — "no
 * keyframe index in the ⟨format⟩ container" is the line, and `format` is the
 * only thing in it that identifies what was read.
 *
 * **`answered` and `readable` are two different questions, and conflating them
 * costs a picture.** `answered` says a reader has come back; `readable` says it
 * came back with times. A file that has answered with nothing must be
 * re-encoded for ever — MPEG-TS is the case, measured 2026-08-21, 669 real
 * keyframes and no index of any kind to read them from. A file that has not
 * answered is a shortage of bytes off the swarm, and asking again in a moment
 * is the right thing to do. Held as three loose fields in a bag of probe
 * results, nothing distinguished them, and a passing shortage was written onto
 * the file as a property of the bytes.
 *
 * **What this is NOT.** It is not the reading of the table — who reads, over
 * what transport, how long anybody waits — which is
 * `orchestrators/KeyframeTables.js`, the only thing that may call `learn`.
 */

export class KeyframeTable {
  /** @type {number[] | null} */
  #times = null;

  /** @type {number} */
  #tolerance = 0;

  /** @type {string} */
  #format = "";

  /** @type {boolean} */
  #answered = false;

  /**
   * Keyframe times in seconds on the FILE's own clock, ascending. Null until
   * something has answered, and null forever after an answer of none.
   *
   * @returns {number[] | null}
   */
  get times() {
    return this.#times;
  }

  /**
   * How far a time in this table may sit from the instant it names.
   *
   * Zero for a container that states times directly; only AVI, which states
   * frame numbers, has anything to declare here.
   *
   * @returns {number}
   */
  get tolerance() {
    return this.#tolerance;
  }

  /**
   * Which container stated it, whether or not it produced a table.
   *
   * @returns {string}
   */
  get format() {
    return this.#format || "not yet read";
  }

  /**
   * How many keyframes this table names.
   *
   * @returns {number}
   */
  get count() {
    return this.#times?.length ?? 0;
  }

  /**
   * Whether anything has answered about this file yet.
   *
   * @returns {boolean}
   */
  get answered() {
    return this.#answered;
  }

  /**
   * Whether a picture of this file can be COPIED.
   *
   * A copy can only be cut where a keyframe already is, so without a table
   * there is no honest grid: declaring an even one instead is a falsehood the
   * player punishes — it walks the whole file to rebuild the timeline, or shows
   * audio with no picture because a segment begins with nothing decodable (both
   * field-observed 2026-08-02).
   *
   * @returns {boolean}
   */
  get readable() {
    return this.#times !== null;
  }

  /**
   * Take in what a reader found. Called only by `KeyframeTables`.
   *
   * **A table already here is never displaced by an emptier one.** Two readers
   * answer about one file and they are not equals: a container's own index is
   * two point reads of 16 KB and names every keyframe, while the packet probe
   * decodes the media and on a torrent-backed file often finds only some of
   * them — measured 2026-08-02, 77 keyframes in 45 s without finishing, against
   * all 570 in 0.8 s from the index. Whichever of them answers second, the
   * fuller answer is the one that stands.
   *
   * @param {{ times?: number[] | null, tolerance?: number, format?: string } | null} reading
   * @returns {this}
   */
  learn(reading) {
    const wasAnswered = this.#answered;
    this.#answered = true;
    const times = Array.isArray(reading?.times) && reading.times.length > 0 ? reading.times : null;
    const format = typeof reading?.format === "string" && reading.format.length > 0 ? reading.format : "";
    const fuller = times !== null && (this.#times === null || times.length > this.#times.length);
    // THE FORMAT NAMES WHOEVER SUPPLIED THE TIMES IN USE, so it moves with them
    // — except before any times exist, where the first answer's name is what a
    // refusal has to print ("no keyframe index in the ⟨format⟩ container").
    if (format && (fuller || !wasAnswered)) {
      this.#format = format;
    }
    if (!fuller) {
      return this;
    }
    this.#times = times;
    const declared = Number(reading?.tolerance);
    this.#tolerance = Number.isFinite(declared) && declared > 0 ? declared : 0;
    return this;
  }
}
