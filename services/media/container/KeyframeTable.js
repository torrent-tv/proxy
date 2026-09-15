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
 *
 * **And it holds the evidence AGAINST itself**, which is the one thing that can
 * only be learned from the file being played. A copied picture can be cut
 * nowhere but a real keyframe, so where a produced piece truly began is a
 * reading about THIS table and about nothing else. Kept here, it outlives the
 * cut table of any one grid and reaches every step and every later session of
 * the file; kept on a grid, as it was until 2026-09-15, it was mixed with two
 * other facts that merely shared that grid — a step that was TOLD where to put
 * a keyframe and did not, and a soundtrack that has no keyframes at all.
 */

/**
 * How far a produced piece may sit from a time this table names and still be
 * that time. Zero would be right for a container that states presentation
 * times; AVI states frame NUMBERS and computes the time from them, landing
 * 10-44 ms out (measured 2026-08-21), and that is what `tolerance` declares.
 * The floor is half an audio frame, below which nothing is distinguishable.
 */
const NAMES_WITHIN_SEC = 0.05;

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
   * What copied pieces of this file have shown about the table above.
   *
   * @type {{ checked: number, disagreed: number, maxDeviationSec: number, firstDisagreementIndex: number, deviations: number[], landedOnAnotherKeyframe: number, seen: Set<number> }}
   */
  #evidence = {
    checked: 0,
    disagreed: 0,
    maxDeviationSec: 0,
    firstDisagreementIndex: -1,
    // Every deviation, so a summary can report a distribution instead of one
    // extreme. Bounded by the number of distinct cuts the file has.
    deviations: [],
    // Of the pieces that began away from where they were told, how many began
    // at ANOTHER time in this very table. That is the measurement separating
    // the two explanations: a table describing times the file does not have,
    // against a table naming only SOME keyframes with a grid built over its
    // gaps. Asked 2026-08-17 by the user, who was right that the second is far
    // more likely — every deviation measured that day was positive, 0.58-2.96s,
    // which is what a cut pushed forward to the next real keyframe looks like.
    landedOnAnotherKeyframe: 0,
    // Which cuts have been counted. A piece can be produced and served again,
    // and a repeat is the same cut, not new evidence.
    seen: new Set()
  };

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

  /**
   * Whether this table names that instant.
   *
   * @param {number} seconds
   * @returns {boolean} False when nothing has been read, which is not the same
   *   as "the table does not name it" — but a table with no times makes no
   *   claim to be wrong about either.
   */
  names(seconds) {
    if (this.#times === null || !Number.isFinite(seconds)) {
      return false;
    }
    const within = Math.max(NAMES_WITHIN_SEC, this.#tolerance);
    return this.#times.some((time) => Math.abs(time - seconds) <= within);
  }

  /**
   * A COPIED piece of this file states where it truly began.
   *
   * Only a copy may be witnessed here, and the caller is what knows which it
   * has: a copy is cut at a keyframe of this file and nowhere else, so its
   * landing is a reading about this table. A re-encoded step was told where to
   * put a keyframe — a disagreement there is that step failing to obey, not the
   * table being wrong — and a soundtrack is cut exactly where it is asked to
   * be, to within one audio frame, so it says nothing about any keyframe at all.
   *
   * @param {object} reading
   * @param {number} reading.index - Which cut, so a repeat is recognised.
   * @param {number} reading.trueStart - Where the piece really began, on the
   *   file's own clock.
   * @param {number} reading.deviationSec - How far that is from where the grid
   *   said it would be.
   * @param {number} reading.toleranceSec - Above which the two are held to
   *   disagree rather than to have rounded. The judgement's own figure, stated
   *   by whoever is judging, so that one number decides it everywhere.
   * @returns {void}
   */
  witness({ index, trueStart, deviationSec, toleranceSec }) {
    if (!Number.isInteger(index) || !Number.isFinite(deviationSec) || this.#evidence.seen.has(index)) {
      return;
    }
    this.#evidence.seen.add(index);
    this.#evidence.checked += 1;
    this.#evidence.deviations.push(deviationSec);
    if (this.names(trueStart)) {
      this.#evidence.landedOnAnotherKeyframe += 1;
    }
    if (deviationSec > toleranceSec) {
      this.#evidence.disagreed += 1;
      if (this.#evidence.firstDisagreementIndex < 0) {
        this.#evidence.firstDisagreementIndex = index;
      }
    }
    if (deviationSec > this.#evidence.maxDeviationSec) {
      this.#evidence.maxDeviationSec = deviationSec;
    }
  }

  /**
   * What the copied pieces produced so far say about this table.
   *
   * @returns {{ checked: number, disagreed: number, maxDeviationSec: number, medianDeviationSec: number, firstDisagreementIndex: number, landedOnAnotherKeyframe: number } | null}
   *   Null while nothing has been produced from a copy, which says neither that
   *   the table is right nor that it is wrong.
   */
  get evidence() {
    if (this.#evidence.checked === 0) {
      return null;
    }
    const sorted = [...this.#evidence.deviations].sort((left, right) => left - right);
    return {
      checked: this.#evidence.checked,
      disagreed: this.#evidence.disagreed,
      maxDeviationSec: this.#evidence.maxDeviationSec,
      medianDeviationSec: sorted[Math.floor(sorted.length / 2)],
      firstDisagreementIndex: this.#evidence.firstDisagreementIndex,
      landedOnAnotherKeyframe: this.#evidence.landedOnAnotherKeyframe
    };
  }
}
