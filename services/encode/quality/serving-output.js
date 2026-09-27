/**
 * @file Which output already on this proxy serves a viewer, instead of a new
 * encode of the format they would otherwise be given.
 *
 * Decided with the user 2026-09-16, and made one rule for every path on
 * 2026-09-23 (roadmap item 97, step 11). Quality is compared by the number of
 * points in the picture. An output qualifies only if the piece at the viewer's
 * position is already made — material somewhere else in the film spares them
 * nothing — AND the viewer's own link admits its load (`link-budget.js`), in
 * every mode and on every branch. A load whose figure is a bound (`known`) is
 * taken before one whose figure is an average (`estimated`), whatever their
 * sizes; an `unknown` load is admitted only while nothing has measured the
 * link.
 *
 * AUTOMATIC:
 * 1. at least the quality wanted — the nearest to it;
 * 2. below the quality wanted but above the next rung down of this viewer's
 *    own ladder — the largest of those;
 * 3. lower still only when producing the wanted format here risks the viewer
 *    waiting: this machine does not hold it at the speed the file needs — the
 *    largest of those.
 *
 * CHOSEN BY HAND: exactly the size chosen — of those, the one with the highest
 * bitrate the link admits. Which encoder made it and at which speed setting do
 * not matter to the viewer.
 *
 * No reading of disk or machine here: every figure arrives as a plain value.
 */

import { OutputSpec } from "../output/OutputSpec.js";
import { admissionRank } from "./link-budget.js";

/**
 * @typedef {object} Candidate
 * @property {string} key - The output's key.
 * @property {OutputSpec} spec
 * @property {number} width
 * @property {number} height
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
 * @param {(candidate: Candidate) => { admitted: boolean, load: object }} params.judge -
 *   What this viewer's link does with the candidate's whole load.
 * @param {Candidate[]} params.candidates
 * @returns {{ key: string, answer: object } | null} The output to serve, or
 *   null to produce `wanted`.
 */
export function chooseServingOutput({ mode, wanted, nextLowerArea, atRisk, judge, candidates }) {
  const admitted = (candidates ?? [])
    .filter((candidate) => candidate.readyHere === true)
    .map((candidate) => ({ candidate, answer: judge(candidate) }))
    .filter((one) => one.answer.admitted);
  const areaOf = (one) => one.candidate.width * one.candidate.height;
  const rateOf = (one) => one.answer.load.totalMbps ?? 0;
  const byRank = (left, right) => admissionRank(right.answer) - admissionRank(left.answer);
  const pick = (list) => (list.length > 0 ? { key: list[0].candidate.key, answer: list[0].answer } : null);
  if (mode === "manual") {
    return pick(
      admitted
        .filter((one) => one.candidate.width === wanted.width && one.candidate.height === wanted.height)
        .sort((left, right) => byRank(left, right) || rateOf(right) - rateOf(left))
    );
  }
  const wantedArea = wanted.width * wanted.height;
  const atLeast = admitted
    .filter((one) => areaOf(one) >= wantedArea)
    .sort((left, right) => byRank(left, right) || areaOf(left) - areaOf(right) || rateOf(right) - rateOf(left));
  if (atLeast.length > 0) {
    return pick(atLeast);
  }
  const below = admitted
    .filter((one) => areaOf(one) < wantedArea)
    .sort((left, right) => byRank(left, right) || areaOf(right) - areaOf(left) || rateOf(right) - rateOf(left));
  const close = below.filter((one) => areaOf(one) > nextLowerArea);
  if (close.length > 0) {
    return pick(close);
  }
  return atRisk ? pick(below) : null;
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
/**
 * Whether two outputs are of the same MATERIAL — the same film, the same
 * container, the same cuts, the same tracks — and therefore interchangeable as
 * far as anything but picture size is concerned.
 *
 * Stated once and exported, because two places ask it: choosing an output by
 * quality, and answering which output serves a height. A step of a picture is
 * only a step of THAT picture if this holds; a 720p step in fMP4 handed to a
 * picture cut for MPEG-TS is a segment name its player cannot even ask for.
 *
 * Picture SIZE is deliberately not in it: differing in size is what a step is.
 *
 * @param {OutputSpec} spec
 * @param {OutputSpec} wanted
 * @returns {boolean}
 */
export function isSameMaterial(spec, wanted) {
  if (!spec || !wanted || !spec.video || !wanted.video) {
    return false;
  }
  return (
    spec.sourceKey === wanted.sourceKey &&
    spec.segmentFormatId === wanted.segmentFormatId &&
    spec.grid.toKey() === wanted.grid.toKey() &&
    spec.carries === wanted.carries &&
    spec.video.fileIndex === wanted.video.fileIndex &&
    (spec.audio?.toKey() ?? "") === (wanted.audio?.toKey() ?? "")
  );
}

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
    if (!isSameMaterial(spec, wanted)) {
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
      spec,
      width,
      height,
      readyHere: readyAt(key)
    });
  }
  return [...found.values()];
}

/**
 * Whether ONE output may serve this viewer: the same material as the picture
 * it would stand in for, the size their mode requires, and a load their own
 * link admits.
 *
 * THE ONE RULE EVERY PATH ASKS (roadmap item 97, step 11). The picture
 * answering for its own height, an output found already producing a height,
 * and the choice among outputs already here used to decide each for itself,
 * and only the last asked about the viewer at all.
 *
 * @param {object} params
 * @param {OutputSpec} params.spec - The output that would serve.
 * @param {OutputSpec} params.pictureSpec - The picture it would stand in for.
 * @param {"auto" | "manual"} params.mode
 * @param {{ width: number, height: number } | null} params.size - The size the
 *   output produces; for a copy, the source's.
 * @param {{ width: number, height: number } | null} params.wanted - The size a
 *   viewer who picked by hand must get exactly; ignored in AUTO.
 * @param {(spec: OutputSpec) => { admitted: boolean }} params.judge
 * @returns {{ suits: boolean, answer: object | null, reason: string }}
 */
export function outputSuits({ spec, pictureSpec, mode, size, wanted, judge }) {
  if (!isSameMaterial(spec, pictureSpec)) {
    return { suits: false, answer: null, reason: "another material" };
  }
  if (mode === "manual" && wanted && size && (size.width !== wanted.width || size.height !== wanted.height)) {
    return { suits: false, answer: null, reason: "not the size picked" };
  }
  const answer = judge(spec);
  return answer.admitted
    ? { suits: true, answer, reason: answer.verdict }
    : { suits: false, answer, reason: answer.verdict };
}
