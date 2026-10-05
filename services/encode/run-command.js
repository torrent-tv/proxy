/**
 * @file Shared published-timeline calculations for an admitted encoder run.
 *
 * What a run is given is a fact about WHAT is being produced and WHERE it
 * begins, and about nothing else — not the session it belongs to, not who is
 * watching, not how many viewers there are. It was a 377-line method of the
 * session manager reading fifteen of its fields, which is why a run could only
 * ever be built by that class, for the one session it holds.
 *
 * Stated here, over the material and the stretch alone, a run can be built by
 * whoever needs one. That is what lets an output have more than a single
 * encoder.
 *
 * **Nothing in this file runs anything.** It returns an argument list; spawning,
 * killing and resuming belong to whoever owns the process.
 */


/**
 * A number of seconds as ffmpeg will accept it.
 *
 * `String(n)` switches to exponential notation below 1e-6, and ffmpeg's
 * duration parser rejects that outright: a field session died on
 * `Invalid duration for option ss: 3.3333333249174757e-7`, after which the
 * transcode was in state `failed` and every segment request answered 500 for
 * as long as the viewer kept trying. Anything under a millisecond is also not a
 * real offset — it is the residue of subtracting two nearly equal floats — so
 * it is dropped rather than passed on.
 *
 * @param {number} value
 * @returns {string}
 */
export function ffmpegSeconds(value) {
  if (!Number.isFinite(value) || Math.abs(value) < 0.001) {
    return "0";
  }
  // Microsecond resolution, fixed notation, no trailing zero noise.
  return value.toFixed(6).replace(/\.?0+$/, "");
}

/**
 * Which timeline an output's own ffmpeg works on.
 *
 * True — the COPY branch: the source's timestamps are kept (`-copyts`) and the
 * output is re-labelled 0-based. Everything handed to the muxer is therefore
 * stated in the source's terms, and everything read back out of a produced
 * piece is 0-based.
 *
 * False — the re-encode branch: the output is labelled from the run's start on
 * the 0-based timeline, and the muxer is addressed in those same terms.
 *
 * One predicate for both callers, because the two used to answer it separately
 * and a disagreement between them is exactly what desynced picture from sound.
 *
 * @param {{ audioOnly?: boolean, timeline?: { cutGrid?: string }, transcodeVideo?: boolean }} material
 * @returns {boolean}
 */
export function onKeyframeGridFor(material) {
  return material?.audioOnly === true
    ? material?.timeline?.cutGrid === "keyframe"
    : material?.transcodeVideo !== true;
}

/**
 * The boundary table the player is working from: the one its playlist was
 * written from, falling back to the live table when no playlist was built from
 * a table at all (no duration, so no synthetic playlist — and then nothing the
 * player holds contradicts it).
 *
 * @param {{ published?: number[], boundaries?: number[] }} timeline
 * @returns {number[]}
 */
export function publishedGridFor(timeline) {
  return Array.isArray(timeline?.published) && timeline.published.length > 0
    ? timeline.published
    : (timeline?.boundaries ?? []);
}

/**
 * Where a run beginning at `index` must be positioned: the time the PLAYER was
 * told that segment starts at.
 *
 * Two tables, deliberately: the live one is corrected as produced segments
 * reveal where the file's cuts truly are, and those corrections are what let a
 * re-encoded rung be forced onto a copied stream's real grid. But the playlist
 * a player is holding was written once and never changes, so a position taken
 * from the corrected table describes a timeline nobody sent the player. That is
 * not a subtlety: it cost ten minutes of a dead film on 2026-08-17, the browser
 * asking for two segments 1908 times each.
 *
 * @param {{ published?: number[], boundaries?: number[] }} timeline
 * @param {number} index
 * @param {number} segmentDurationSec - Used only when the file has no table at
 *   all, where a segment is a plain multiple of the nominal length.
 * @returns {number}
 */
export function publishedStartTime(timeline, index, segmentDurationSec) {
  const published = Array.isArray(timeline?.published) && timeline.published.length > 0 ? timeline.published : null;
  const table = published ?? (Array.isArray(timeline?.boundaries) ? timeline.boundaries : []);
  if (table.length === 0) {
    return index * segmentDurationSec;
  }
  const clamped = Math.max(0, Math.min(index, table.length - 1));
  return table[clamped];
}

/**
 * Where a segment REALLY begins, when a produced piece has said so.
 *
 * The live table is corrected as produced pieces reveal where a file's cuts
 * truly are; the published one is what the player was told and may never move.
 * Where the two disagree, the live table is a measurement and the published one
 * a prediction — and this answers with the measurement, or with nothing when
 * they agree or nothing has been measured.
 *
 * @param {object} timeline
 * @param {number} index
 * @returns {number | undefined}
 */
export function trueStartOf(timeline, index) {
  const live = Array.isArray(timeline?.boundaries) ? timeline.boundaries : null;
  const published = Array.isArray(timeline?.published) ? timeline.published : null;
  if (!live || !published || index < 0 || index >= live.length || index >= published.length) {
    return undefined;
  }
  return live[index] === published[index] ? undefined : live[index];
}

/**
 * The cut times to hand ffmpeg for a run that starts at `startIndex`.
 *
 * Two adjustments, both of which cost a broken session to learn:
 *
 *  - **Rebased.** `-segment_times` is measured from the start of the run, not
 *    of the file. Measured: starting at 12 s and asking for a cut at 18 s put
 *    it at 29.4 s — 12 + 18. So every boundary has the run's own start
 *    subtracted.
 *  - **Interior only.** The first boundary is where the run begins and the last
 *    is where the file ends; neither is a cut. Sending them would produce an
 *    empty leading segment and a spurious trailing one.
 *
 * @param {number[]} boundaries
 * @param {number} startIndex
 * @returns {number[] | null}
 */
export function segmentCutTimesFrom(boundaries, startIndex) {
  if (!Array.isArray(boundaries) || boundaries.length < 2) {
    return null;
  }
  const index = Number.isInteger(startIndex) && startIndex > 0 ? startIndex : 0;
  if (index >= boundaries.length - 1) {
    return null;
  }
  const base = boundaries[index];
  const times = [];
  for (let at = index + 1; at < boundaries.length - 1; at += 1) {
    times.push(Number((boundaries[at] - base).toFixed(6)));
  }
  return times;
}

/**
 * The largest keyframe time that does not exceed `target`, from a SORTED
 * (ascending) array of keyframe times. Null when `target` is before the first
 * keyframe or the array is empty — the caller then falls back to its unsnapped
 * target.
 *
 * @param {number[]} keyframeTimes - Sorted ascending.
 * @param {number} target
 * @returns {number | null}
 */
export function nearestKeyframeAtOrBefore(keyframeTimes, target) {
  let result = null;
  for (const time of keyframeTimes) {
    if (time > target) {
      break;
    }
    result = time;
  }
  return result;
}
