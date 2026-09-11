/**
 * @file Where a file is cut, and which keyframe each cut is.
 *
 * Two answers, not one, and that is the whole point of this file existing.
 *
 * A cut has a time on the PLAYER's clock — 0-based, because a playlist is —
 * and it has a time on the FILE's clock, which is the keyframe the muxer will
 * actually seek to. The two differ by the container's own start time, and a
 * copied picture cannot be cut anywhere but at a real keyframe, so both are
 * needed and neither can be derived from the other after the fact.
 *
 * **Deriving one from the other after the fact is what broke a viewing on
 * 2026-09-05.** The 0-based time was stored, rounded to six places, and the
 * seek then added the start time back and looked the result up in the file's
 * keyframe list by value. That round trip is lossy: a keyframe at 26.234 s in a
 * container starting at 0.083 s comes back as 26.233999999999998, the lookup
 * takes "the keyframe at or before" that, and answers the PREVIOUS one — 8.717 s
 * earlier. Two parts in a quadrillion became one keyframe interval, that
 * interval became a trim, the trim moved every cut of the run backwards by
 * another interval, and the run's files were numbered from #36 while carrying
 * film 17.4 s before what the playlist says #36 holds. The player's video buffer
 * covered the playhead, its audio buffer had a 17.4 s hole across it, the
 * intersection was empty, and the viewer waited two minutes and was told the
 * proxy had sent no video.
 *
 * So the keyframe is carried, by index, from the one place that knows it.
 */

/**
 * @typedef {object} CutGrid
 * @property {number[]} boundaries - Cut times on the player's clock, 0-based,
 *   ascending, one more than there are segments.
 * @property {number[]} sourceTimes - The same cuts on the FILE's clock: for a
 *   keyframe grid, the keyframe itself, exactly as the container stated it.
 *   Same length as `boundaries`, so an index names both.
 */

/**
 * Cut a file into segments.
 *
 * On a keyframe grid the cuts are the container's own keyframes, thinned so
 * that no segment is much shorter than asked for; the first cut is the start of
 * the file and the last is its end, neither of which need be a keyframe.
 *
 * On a uniform grid the cuts are multiples of the segment length, and the two
 * clocks are the same clock: a re-encode places its own keyframes and owes the
 * container's start time nothing.
 *
 * @param {object} params
 * @param {boolean} params.useKeyframeGrid
 * @param {number} params.durationSeconds
 * @param {number} params.segDur - The segment length asked for.
 * @param {number[]} [params.keyframeTimes] - On the file's own clock.
 * @param {number} [params.startTime] - The container's start time.
 * @returns {CutGrid}
 */
export function computeCutGrid({ useKeyframeGrid, durationSeconds, segDur, keyframeTimes, startTime }) {
  const total = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0;
  const step = Number.isFinite(segDur) && segDur > 0 ? segDur : 4;
  const base = Number.isFinite(startTime) ? startTime : 0;
  const uniform = () => {
    const boundaries = [];
    for (let t = 0; t < total - 0.001; t += step) {
      boundaries.push(Number(t.toFixed(6)));
    }
    boundaries.push(total);
    // One clock: nothing here is a keyframe of the source, so nothing is owed
    // the container's start time either.
    return { boundaries, sourceTimes: [...boundaries] };
  };
  if (!useKeyframeGrid || !Array.isArray(keyframeTimes) || keyframeTimes.length === 0 || total <= 0) {
    return uniform();
  }
  const kept = keyframeTimes
    .filter((time) => Number.isFinite(time))
    .map((time) => ({ source: time, published: time - base }))
    // THE END IS MEASURED THE SAME WAY AS EVERY OTHER CUT. A keyframe nearer to
    // the end than one segment leaves a tail too short to be a segment, and the
    // rule below — no cut closer than a step to the one before it — never looks
    // at the end at all. It used to be guarded by fifty milliseconds, a number
    // from nowhere: field 2026-09-11, a keyframe 160 ms before the end of a
    // 54-minute film passed it and left segment #541 lasting 0.16 s. The sound
    // has no data in such a tail, so its run made 541 segments where the picture
    // made 542, was marked short, and the repair that followed was handed a
    // start later than its own end — 190 bytes that are not a fragment, and a
    // viewer held 23 s at the last minute of the film for a 404.
    .filter((cut) => cut.published >= -0.001 && cut.published < total - step)
    .sort((left, right) => left.published - right.published);
  // The first cut is the start of the file, whatever the container's own clock
  // says that is; the last is its end. Neither is a keyframe, and a run never
  // seeks to either — index 0 is served without a seek at all.
  const boundaries = [0];
  const sourceTimes = [base];
  for (const cut of kept) {
    if (cut.published >= boundaries[boundaries.length - 1] + step - 0.05) {
      boundaries.push(Number(cut.published.toFixed(6)));
      // NOT the rounded value with the base added back. This is the number the
      // container stated, and it is what the seek must ask for.
      sourceTimes.push(cut.source);
    }
  }
  boundaries.push(total);
  sourceTimes.push(total + base);
  // A degenerate index — one keyframe, or none inside the film — is no grid at
  // all, and an even one serves better than a table with a single entry.
  return boundaries.length >= 2 ? { boundaries, sourceTimes } : uniform();
}
