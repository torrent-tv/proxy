/**
 * @file Where a file is cut, and what the player was told about it.
 *
 * This belongs to the FILE and its grid, not to a session and not to a viewer.
 * Every quality step of one film has to be cut at exactly the same times — that
 * is what lets a segment made by one encoder be appended where another's would
 * have gone — and every session serving that film has to publish the same
 * playlist, or two of them stamp the same moment differently and the picture
 * and the sound drift apart.
 *
 * Until now each session computed and kept its own copy, and agreement between
 * them was achieved by COPYING: a variant was handed `inheritedGrid` at
 * creation, and a soundtrack the same. That works while somebody remembers to
 * pass it, and it failed when the two tables drifted — measured 2026-08-17,
 * corrections of 0.6-2.9 s between two sessions of one file, and again
 * 2026-08-20, segments arriving a uniform 2.002 s before the times the playlist
 * named for them, four times what a player will bridge. One table, held once,
 * cannot drift from itself.
 *
 * **Two tables, and they are not the same thing.** `boundaries` is where the
 * file is cut NOW, corrections included, and it is what a run is told to cut
 * at. `published` is what the player was given, written once and never changed,
 * and it is what a segment must be stamped to. A player places a fragment by
 * the playlist it holds; the live table keeps moving as produced segments
 * reveal where the file's cuts really are.
 */

/**
 * A fresh tally of how well a container's keyframe index matches its file.
 *
 * @returns {{ checked: number, disagreed: number, maxDeviationSec: number, firstDisagreementIndex: number, deviations: number[], landedOnAnotherKeyframe: number, seen: Set<number> }}
 */
export function newIndexCheck() {
  return {
    checked: 0,
    disagreed: 0,
    maxDeviationSec: 0,
    firstDisagreementIndex: -1,
    // Every deviation, so the summary can report a distribution instead of one
    // extreme. Bounded by the number of distinct boundaries a file produces.
    deviations: [],
    // Of the segments that started away from the playlist, how many began at
    // ANOTHER time in the very list the grid was built from. This is the
    // measurement that separates the two explanations: a table that describes
    // times the file does not have, against a table that lists only SOME
    // keyframes and a grid built over its gaps. Asked 2026-08-17 by the user,
    // who was right that the second is far more likely — every deviation
    // measured that day was positive, 0.58-2.96 s, which is what a cut pushed
    // forward to the next real keyframe looks like.
    landedOnAnotherKeyframe: 0,
    // Which boundaries have been counted. A segment can be requested again, and
    // a repeat is the same boundary, not new evidence.
    seen: new Set()
  };
}

export class Timeline {
  /**
   * @param {object} params
   * @param {number[]} params.boundaries - Cut times in seconds, ascending, one
   *   more than there are segments.
   * @param {number[] | null} [params.published] - What the player was told, when
   *   that differs from the boundaries because corrections have been made since.
   * @param {"keyframe" | "uniform"} params.cutGrid - Whether those times are
   *   the source's own keyframes, which a copied picture has no choice about,
   *   or an even grid the encoder is told to place keyframes on.
   * @param {number} params.totalDurationSeconds
   * @param {number[] | null} [params.keyframeTimes] - The container's own
   *   table, where it has one.
   * @param {number} [params.keyframeTolerance] - How far a time in that table
   *   may sit from the instant it names. Only AVI declares anything here.
   * @param {string} [params.containerFormat] - Which container answered, so a
   *   summary of how often an index disagrees with its own file can say what it
   *   is a summary OF.
   */
  constructor({
    boundaries,
    published = null,
    cutGrid,
    totalDurationSeconds,
    keyframeTimes = null,
    keyframeTolerance = 0,
    containerFormat = ""
  }) {
    this.boundaries = Array.isArray(boundaries) ? boundaries : [];
    // What the player holds. Taken from the boundaries as they stood when the
    // playlist was written, and never touched again. Given outright only when a
    // table is being restored with corrections already in it — a live one is
    // always published from its own boundaries.
    this.published = Array.isArray(published) ? published : [...this.boundaries];
    this.cutGrid = cutGrid === "keyframe" ? "keyframe" : "uniform";
    this.totalDurationSeconds = Number.isFinite(totalDurationSeconds) ? totalDurationSeconds : 0;
    this.keyframeTimes = Array.isArray(keyframeTimes) ? keyframeTimes : null;
    this.keyframeTolerance = Number.isFinite(keyframeTolerance) ? keyframeTolerance : 0;
    this.containerFormat = String(containerFormat ?? "");
    // How well this container's keyframe index matches its own file. A fact
    // about the FILE and its index: asked per session it would be answered a
    // different number of times for one film depending on how many people
    // happened to watch it.
    this.indexCheck = newIndexCheck();
  }

  /** @returns {number} How many segments this file is cut into. */
  get segmentCount() {
    return Math.max(0, this.boundaries.length - 1);
  }

  /**
   * Where segment `index` begins, on the timeline the player was given.
   *
   * @param {number} index
   * @returns {number}
   */
  publishedStartOf(index) {
    if (!Number.isInteger(index) || index <= 0) {
      return this.published[0] ?? 0;
    }
    const at = Math.min(index, this.published.length - 1);
    return this.published[at] ?? 0;
  }

  /**
   * Where segment `index` begins on the live table — where a run cutting now
   * will really put it.
   *
   * @param {number} index
   * @returns {number}
   */
  liveStartOf(index) {
    if (!Number.isInteger(index) || index <= 0) {
      return this.boundaries[0] ?? 0;
    }
    const at = Math.min(index, this.boundaries.length - 1);
    return this.boundaries[at] ?? 0;
  }

  /**
   * Which segment holds this moment.
   *
   * @param {number} seconds
   * @returns {number}
   */
  indexForTime(seconds) {
    const wanted = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    for (let index = 0; index < this.segmentCount; index += 1) {
      if (wanted < this.boundaries[index + 1]) {
        return index;
      }
    }
    return Math.max(0, this.segmentCount - 1);
  }

}

/**
 * The timelines this proxy holds, one per file and grid.
 *
 * Keyed by the two things that decide where the cuts are: which file, and
 * whether the cuts are its own keyframes or an even grid. A quality step of the
 * same film is a different OUTPUT and the same timeline, which is exactly the
 * agreement `inheritedGrid` used to arrange by copying.
 */
export class Timelines {
  /** @type {Map<string, Timeline>} */
  #byKey = new Map();

  /**
   * @param {string} sourceKey
   * @param {number} fileIndex
   * @param {"keyframe" | "uniform"} cutGrid
   * @returns {string}
   */
  static keyFor(sourceKey, fileIndex, cutGrid) {
    return `${sourceKey}:${fileIndex}:${cutGrid === "keyframe" ? "kf" : "even"}`;
  }

  /**
   * The one for this file and grid, made by `build` if it is not there yet.
   *
   * @param {string} key
   * @param {() => Timeline} build
   * @returns {Timeline}
   */
  get(key, build) {
    let timeline = this.#byKey.get(key);
    if (!timeline) {
      timeline = build();
      this.#byKey.set(key, timeline);
    }
    return timeline;
  }

  /**
   * @param {string} key
   * @returns {Timeline | null}
   */
  peek(key) {
    return this.#byKey.get(key) ?? null;
  }

  /** @param {string} key */
  forget(key) {
    this.#byKey.delete(key);
  }

  /**
   * Drop every timeline nobody is holding.
   *
   * A timeline is small — two arrays of a few thousand numbers — and it is kept
   * for as long as somebody is reading the file it describes. Nothing else
   * removes one, and a map that only ever grows is the shape of half the memory
   * faults recorded in this project.
   *
   * @param {Set<Timeline>} inUse
   * @returns {number} How many were dropped.
   */
  forgetUnused(inUse) {
    let dropped = 0;
    for (const [key, timeline] of [...this.#byKey]) {
      if (!inUse.has(timeline)) {
        this.#byKey.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  /** @returns {number} */
  get size() {
    return this.#byKey.size;
  }
}
