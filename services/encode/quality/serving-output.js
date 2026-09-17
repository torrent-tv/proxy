/**
 * @file Which output already on this proxy serves a viewer, instead of a new
 * encode of the format they would otherwise be given.
 *
 * Decided with the user 2026-09-16. Quality is compared by the number of points
 * in the picture. An output qualifies only if the piece at the viewer's
 * position is already made — material somewhere else in the film spares them
 * nothing.
 *
 * AUTOMATIC:
 * 1. at least the quality wanted, if its stream fits the viewer's measured
 *    link — of those, the one nearest the quality wanted, which costs the
 *    viewer's link least;
 * 2. below the quality wanted but above the next rung down of this viewer's
 *    own ladder — the largest of those;
 * 3. lower still only when producing the wanted format here risks the viewer
 *    waiting: this machine does not hold it at the speed the file needs — the
 *    largest of those.
 *
 * CHOSEN BY HAND: exactly the size chosen. Which encoder made it, and at which
 * speed setting, does not matter to the viewer.
 *
 * No reading of disk or machine here: every figure arrives as a plain value.
 */

import { OutputSpec } from "../output/OutputSpec.js";
import { peakMbpsForHeight } from "./link-budget.js";

/**
 * @typedef {object} Candidate
 * @property {string} key - The output's key.
 * @property {number} width
 * @property {number} height
 * @property {number} peakMbps - What its stream asks of a link.
 * @property {boolean} readyHere - The piece at the viewer's position is made.
 */

/**
 * @param {object} params
 * @param {"auto" | "manual"} params.mode
 * @param {{ width: number, height: number }} params.wanted - The format this
 *   viewer would otherwise be given.
 * @param {number} params.nextLowerArea - Points in the next rung below `wanted`
 *   on this viewer's own ladder; zero when there is none.
 * @param {boolean} params.atRisk - Producing `wanted` here is measured not to
 *   keep up with what the file needs. False where nothing measured it.
 * @param {(peakMbps: number) => boolean} params.linkCarries - Whether the
 *   viewer's measured link carries a stream asking this much. Yes where
 *   nothing has been measured.
 * @param {Candidate[]} params.candidates
 * @returns {string | null} The key of the output to serve, or null to produce
 *   `wanted`.
 */
export function chooseServingOutput({ mode, wanted, nextLowerArea, atRisk, linkCarries, candidates }) {
  const ready = (candidates ?? []).filter((candidate) => candidate.readyHere === true);
  if (mode === "manual") {
    return ready.find((candidate) => candidate.width === wanted.width && candidate.height === wanted.height)?.key ?? null;
  }
  const wantedArea = wanted.width * wanted.height;
  const areaOf = (candidate) => candidate.width * candidate.height;
  const atLeast = ready
    .filter((candidate) => areaOf(candidate) >= wantedArea && linkCarries(candidate.peakMbps))
    .sort((left, right) => areaOf(left) - areaOf(right));
  if (atLeast.length > 0) {
    return atLeast[0].key;
  }
  const below = ready
    .filter((candidate) => areaOf(candidate) < wantedArea)
    .sort((left, right) => areaOf(right) - areaOf(left));
  const close = below.filter((candidate) => areaOf(candidate) > nextLowerArea);
  if (close.length > 0) {
    return close[0].key;
  }
  return atRisk && below.length > 0 ? below[0].key : null;
}

/**
 * Points in the next rung below a height on a viewer's own ladder.
 *
 * @param {{ width: number, height: number }[]} ladder - High to low.
 * @param {number} height
 * @returns {number} Zero when nothing on the ladder is lower.
 */
export function nextRungAreaBelow(ladder, height) {
  const next = (ladder ?? []).find((rung) => rung.height < height);
  return next ? next.width * next.height : 0;
}

/**
 * The outputs that could stand in for `wanted`, read from their keys.
 *
 * One qualifies when it is the same picture of the same file in every respect
 * but its quality: the same torrent, container, cut grid, soundtrack and what
 * the output carries. A re-encode qualifies only if this machine's encoder
 * made it, because serving it means going on producing it, and pieces of
 * another encoder cannot share its header. A copy is the source's own picture.
 *
 * @param {object} params
 * @param {OutputSpec} params.wanted
 * @param {Iterable<string>} params.keys - Every output this proxy holds, live
 *   or only on disk. Repeats are fine.
 * @param {{ width: number, height: number, megabitsPerSecond: number | null }} params.source
 * @param {string} params.encoderName
 * @param {(key: string) => boolean} params.readyAt - The piece at the viewer's
 *   position is made.
 * @returns {Candidate[]}
 */
export function servingCandidates({ wanted, keys, source, encoderName, readyAt }) {
  const found = new Map();
  for (const key of keys ?? []) {
    if (found.has(key)) {
      continue;
    }
    const spec = OutputSpec.fromKey(key);
    if (!spec || !spec.video || !wanted.video) {
      continue;
    }
    const sameMaterial =
      spec.sourceKey === wanted.sourceKey &&
      spec.segmentFormatId === wanted.segmentFormatId &&
      spec.grid.toKey() === wanted.grid.toKey() &&
      spec.carries === wanted.carries &&
      spec.video.fileIndex === wanted.video.fileIndex &&
      (spec.audio?.toKey() ?? "") === (wanted.audio?.toKey() ?? "");
    if (!sameMaterial) {
      continue;
    }
    const encode = spec.video.encode;
    if (encode && encode.encoder !== encoderName) {
      continue;
    }
    const width = encode ? encode.width : source.width;
    const height = encode ? encode.height : source.height;
    if (!(width > 0 && height > 0)) {
      continue;
    }
    found.set(key, {
      key,
      width,
      height,
      peakMbps: peakMbpsForHeight(
        { sourceHeight: source.height, transcodeVideo: Boolean(encode), sourceMbps: source.megabitsPerSecond },
        height
      ),
      readyHere: readyAt(key)
    });
  }
  return [...found.values()];
}
