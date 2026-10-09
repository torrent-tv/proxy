/**
 * @file Exact media time, and the rule by which a viewer's browser joins
 * buffered media.
 *
 * A time is `{ ticks, timescale }`: `ticks / timescale` seconds, both `BigInt`.
 * A file states its timestamps this way, and comparing two of them is integer
 * arithmetic. Converting them to seconds first replaces an exact comparison
 * with a rounded one — measured 2026-10-02 on a served film, seven joins whose
 * ticks were equal read as `88.67299999999999` against `88.673` and were taken
 * for holes.
 *
 * A value that arrives as a JavaScript number — a position or a buffered range
 * from the page, a cut time from the playlist — is a binary fraction, and it is
 * converted to the exact time it denotes ({@link fromSeconds}). No unit is
 * chosen and nothing is rounded. Seconds are produced again only for a
 * forecast, a page or a log ({@link toSeconds}).
 *
 * A range is `{ start, end, frame }`: the presentation interval `[start, end)`
 * and `frame`, the coded-frame duration a browser is known to allow this range
 * when it decides whether a neighbour joins it ({@link joins}). `frame` is zero
 * for a range whose frames are not known, such as one the page reports holding.
 */

/** @typedef {{ ticks: bigint, timescale: bigint }} MediaTime */
/** @typedef {{ start: MediaTime, end: MediaTime, frame: MediaTime }} MediaRange */

/**
 * The gap WebKit closes between buffered ranges: `PlatformTimeRanges::
 * timeFudgeFactor()`, applied by `PlatformTimeRanges::add` with
 * `EliminateSmallGaps` to every sample a `TrackBuffer` adds.
 * https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/graphics/PlatformTimeRanges.cpp
 *
 * @type {MediaTime}
 */
const WEBKIT_TIME_FUDGE_FACTOR = Object.freeze({ ticks: 2002n, timescale: 24000n });

/** @type {MediaTime} */
export const ZERO = Object.freeze({ ticks: 0n, timescale: 1n });

/**
 * How far a buffered range a page reports can lie from the exact time of the
 * frames behind it. Chromium converts three values to whole microseconds before
 * a buffered range exists — a sample's presentation time and its duration in
 * `TimeDeltaFromRational` (media/formats/mp4/track_run_iterator.cc, rounding
 * toward zero), and the page's `timestampOffset` — so each edge is off by less
 * than one microsecond per conversion. Gecko and WebKit keep exact rationals
 * until the value becomes a JavaScript number, which is far finer.
 *
 * @type {MediaTime}
 */
export const REPORTED_TIME_ERROR = Object.freeze({ ticks: 3n, timescale: 1_000_000n });

/**
 * @param {bigint} ticks
 * @param {bigint} timescale
 * @returns {MediaTime}
 */
export function mediaTime(ticks, timescale) {
  if (!(timescale > 0n)) {
    throw new Error(`A timescale must be positive, not ${timescale}.`);
  }
  return { ticks, timescale };
}

/**
 * The exact time a finite number of seconds denotes. An IEEE 754 double is
 * `mantissa * 2^exponent`, so it is a fraction whose denominator is a power of
 * two; this returns that fraction.
 *
 * @param {number} seconds
 * @returns {MediaTime}
 */
export function fromSeconds(seconds) {
  if (!Number.isFinite(seconds)) {
    throw new Error(`Seconds must be finite, not ${seconds}.`);
  }
  if (seconds === 0) {
    return ZERO;
  }
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, seconds);
  const bits = view.getBigUint64(0);
  const sign = bits >> 63n === 1n ? -1n : 1n;
  const biasedExponent = (bits >> 52n) & 0x7ffn;
  let mantissa = bits & 0xfffffffffffffn;
  let exponent;
  if (biasedExponent === 0n) {
    exponent = -1074n;
  } else {
    mantissa |= 0x10000000000000n;
    exponent = biasedExponent - 1075n;
  }
  while (exponent < 0n && mantissa % 2n === 0n) {
    mantissa /= 2n;
    exponent += 1n;
  }
  return exponent >= 0n
    ? { ticks: sign * mantissa * (1n << exponent), timescale: 1n }
    : { ticks: sign * mantissa, timescale: 1n << -exponent };
}

/**
 * Seconds, for a forecast, a page or a log.
 *
 * @param {MediaTime} time
 * @returns {number}
 */
export function toSeconds(time) {
  return Number(time.ticks) / Number(time.timescale);
}

function gcd(left, right) {
  let a = left < 0n ? -left : left;
  let b = right;
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}

/**
 * @param {MediaTime} left
 * @param {MediaTime} right
 * @returns {-1 | 0 | 1}
 */
export function compare(left, right) {
  if (left.timescale === right.timescale) {
    return left.ticks < right.ticks ? -1 : left.ticks > right.ticks ? 1 : 0;
  }
  const a = left.ticks * right.timescale;
  const b = right.ticks * left.timescale;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * @param {MediaTime} left
 * @param {MediaTime} right
 * @returns {MediaTime}
 */
export function add(left, right) {
  if (left.timescale === right.timescale) {
    return { ticks: left.ticks + right.ticks, timescale: left.timescale };
  }
  const common = left.timescale / gcd(left.timescale, right.timescale) * right.timescale;
  return {
    ticks: left.ticks * (common / left.timescale) + right.ticks * (common / right.timescale),
    timescale: common
  };
}

/**
 * @param {MediaTime} left
 * @param {MediaTime} right
 * @returns {MediaTime}
 */
export function subtract(left, right) {
  return add(left, { ticks: -right.ticks, timescale: right.timescale });
}

/**
 * @param {MediaTime} time
 * @param {bigint} factor
 * @returns {MediaTime}
 */
function multiply(time, factor) {
  return { ticks: time.ticks * factor, timescale: time.timescale };
}

/**
 * `time * numerator / denominator`, exactly.
 *
 * @param {MediaTime} time
 * @param {MediaTime} numerator
 * @param {MediaTime} denominator - Not zero.
 * @returns {MediaTime}
 */
export function scale(time, numerator, denominator) {
  const ticks = time.ticks * numerator.ticks * denominator.timescale;
  const timescale = time.timescale * numerator.timescale * denominator.ticks;
  return timescale < 0n ? { ticks: -ticks, timescale: -timescale } : { ticks, timescale };
}

/**
 * The least timescale in which every one of `times` is a whole number of ticks.
 * Times expressed in it add and compare without a common denominator being
 * sought each time.
 *
 * @param {Iterable<MediaTime>} times
 * @returns {bigint}
 */
export function commonTimescale(times) {
  const distinct = new Set();
  for (const time of times) {
    distinct.add(time.timescale);
  }
  let common = 1n;
  for (const timescale of distinct) {
    common = common / gcd(common, timescale) * timescale;
  }
  return common;
}

/**
 * The same time in `timescale`, which must hold it as a whole number of ticks
 * ({@link commonTimescale}).
 *
 * @param {MediaTime} time
 * @param {bigint} timescale
 * @returns {MediaTime}
 */
export function rescale(time, timescale) {
  if (time.timescale === timescale) {
    return time;
  }
  if (timescale % time.timescale !== 0n) {
    throw new Error(`${timescale} ticks a second cannot hold a time counted in ${time.timescale}.`);
  }
  return { ticks: time.ticks * (timescale / time.timescale), timescale };
}

/**
 * The tick of `timescale` nearest to `time`, halves rounded up. For a forecast
 * only: a measured time is never rounded.
 *
 * @param {MediaTime} time
 * @param {bigint} timescale
 * @returns {MediaTime}
 */
export function nearest(time, timescale) {
  const numerator = time.ticks * timescale;
  const quotient = numerator / time.timescale;
  const remainder = numerator - quotient * time.timescale;
  const floor = remainder < 0n ? quotient - 1n : quotient;
  const rest = numerator - floor * time.timescale;
  return { ticks: 2n * rest >= time.timescale ? floor + 1n : floor, timescale };
}

/** @param {...MediaTime} times */
export function earliest(...times) {
  return times.reduce((low, time) => (compare(time, low) < 0 ? time : low));
}

/** @param {...MediaTime} times */
export function latest(...times) {
  return times.reduce((high, time) => (compare(time, high) > 0 ? time : high));
}

/**
 * Whether a gap between two buffered presentation ranges is closed by EVERY
 * Media Source Extensions implementation this player runs on.
 *
 * The specification leaves it open: "The threshold for determining
 * disjointness of track buffer ranges is implementation-specific"
 * (https://w3c.github.io/media-source/#track-buffer-ranges). So the condition
 * is the conjunction of what the three engines do, each read from its source:
 *
 * 1. Gecko — `TrackBuffersManager::InsertFrames` gives each inserted interval a
 *    fuzz of half `mLongestFrameDuration`, the longest frame since the last
 *    keyframe, and `IntervalSet::Add` joins intervals whose distance is at most
 *    the sum of their fuzzes (`Interval::Touches`); a merged interval keeps the
 *    larger fuzz (`Interval::Span`). Hence `2 * gap <= leftFrame + rightFrame`.
 * 2. WebKit — a fixed {@link WEBKIT_TIME_FUDGE_FACTOR}.
 * 3. Chromium — `SourceBufferRange::IsNextInPresentationSequence` accepts a
 *    frame starting within twice `max_interbuffer_distance_` of the highest
 *    frame start; that distance is the largest frame duration or decode
 *    distance appended so far, updated before ranges merge
 *    (`SourceBufferStream::Append`). The frame whose end is the left range's
 *    end starts no earlier than the highest start, so the distance to check is
 *    at most the gap plus that frame's duration. Condition 1 bounds the gap by
 *    the larger of the two frames, so both terms are within that distance and
 *    nothing further is required.
 *
 * Old iOS without Media Source plays HLS in its own closed player. Nothing can
 * be derived for it, and this rule is not a statement about it.
 *
 * @param {MediaTime} gap - Right start minus left end.
 * @param {MediaTime} leftFrame
 * @param {MediaTime} rightFrame
 * @returns {boolean}
 */
export function joins(gap, leftFrame, rightFrame) {
  if (gap.ticks <= 0n) {
    return true;
  }
  return compare(multiply(gap, 2n), add(leftFrame, rightFrame)) <= 0 &&
    compare(gap, WEBKIT_TIME_FUDGE_FACTOR) <= 0;
}

/**
 * Insert a range into a sorted list of disjoint ranges, joining every
 * neighbour {@link joins} admits. Mutates `ranges`.
 *
 * @param {MediaRange[]} ranges
 * @param {{ start: MediaTime, end: MediaTime, frame?: MediaTime }} range
 * @returns {void}
 */
export function addRange(ranges, range) {
  let next = { start: range.start, end: range.end, frame: range.frame ?? ZERO };
  if (compare(next.end, next.start) <= 0) {
    return;
  }
  const merged = [];
  let inserted = false;
  for (const held of ranges) {
    if (inserted) {
      merged.push(held);
    } else if (compare(held.end, next.start) < 0 && !joins(subtract(next.start, held.end), held.frame, next.frame)) {
      merged.push(held);
    } else if (compare(next.end, held.start) < 0 && !joins(subtract(held.start, next.end), next.frame, held.frame)) {
      merged.push(next, held);
      inserted = true;
    } else {
      next = {
        start: earliest(held.start, next.start),
        end: latest(held.end, next.end),
        frame: latest(held.frame, next.frame)
      };
    }
  }
  if (!inserted) {
    merged.push(next);
  }
  ranges.splice(0, ranges.length, ...merged);
}

/**
 * The end of the range that holds `time`, or `time` itself when none does.
 *
 * @param {MediaRange[]} ranges - Sorted and disjoint.
 * @param {MediaTime} time
 * @returns {MediaTime}
 */
export function contiguousEnd(ranges, time) {
  for (const range of ranges) {
    if (compare(range.start, time) <= 0 && compare(time, range.end) <= 0) {
      return range.end;
    }
    if (compare(range.start, time) > 0) {
      break;
    }
  }
  return time;
}

/**
 * Whether `[start, end)` lies inside one range.
 *
 * @param {MediaRange[]} ranges
 * @param {MediaTime} start
 * @param {MediaTime} end
 * @returns {boolean}
 */
export function contains(ranges, start, end) {
  return ranges.some((range) => compare(range.start, start) <= 0 && compare(end, range.end) <= 0);
}
