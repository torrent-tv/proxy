/**
 * @file What a viewer's link can carry, and what an output asks of it.
 *
 * PURE FUNCTIONS: the viewer's connection enters as a NUMBER — how many megabits
 * the last report showed — and never as a reference to a viewer. Nothing here
 * holds anybody, reads anything or can be asked at the wrong moment.
 *
 * WHAT A LINK CARRIES IS A LOAD, NOT A PICTURE (roadmap item 97, step 11). The
 * viewer receives the picture AND the soundtrack they chose — inside the
 * picture's own stream, or as a separate one — so both are added before the
 * link is asked. And each part says how much its figure can be trusted:
 *
 * 1. `known` — a bound the encoder is held to: a re-encode's `maxrate`, or the
 *    constant rate a re-encoded soundtrack is produced at;
 * 2. `estimated` — a figure the FILE states: a copied picture's average rate,
 *    a copied soundtrack's stated rate. An average is not a bound, so a load
 *    built on it is admitted only by estimate and is never confirmed;
 * 3. `unknown` — no figure at all: a hardware encoder given no limit, a copied
 *    soundtrack whose rate nothing states.
 *
 * A load is as trustworthy as its least trustworthy part.
 */

import { maxrateKbpsFor, nominalKbpsFor } from "../args.js";

/**
 * How much of a measured link may be spent on the stream.
 *
 * The rest is what the link does when it is not being perfect: transport
 * framing, retransmission, the other tabs, the moment somebody else in the
 * house starts something. A load sized to the whole reading stalls on the
 * first of those.
 *
 * Chosen, not measured, and written as a constant rather than dressed up as a
 * measurement. What would replace it is a reading of the transport's own
 * overhead and of how far a link's throughput varies over a session, which
 * nothing takes.
 */
export const LINK_SAFETY = 0.8;

/** How far a figure in a load can be trusted. */
export const PEAK_CLASS = Object.freeze({
  KNOWN: "known",
  ESTIMATED: "estimated",
  UNKNOWN: "unknown"
});

/** What a link was found to do with a load. */
export const LINK_VERDICT = Object.freeze({
  FITS: "fits",
  ESTIMATED_TO_FIT: "estimated to fit",
  DOES_NOT_FIT: "does not fit",
  NO_SAFE_BOUND: "no safe bound",
  NO_MEASUREMENT: "no measurement"
});

const CLASS_ORDER = [PEAK_CLASS.KNOWN, PEAK_CLASS.ESTIMATED, PEAK_CLASS.UNKNOWN];

/**
 * @typedef {{ mbps: number | null, peakClass: string }} LoadPart
 * @typedef {{ video: LoadPart | null, audio: LoadPart | null, totalMbps: number | null, peakClass: string }} Load
 */

/**
 * @param {number | null} mbps
 * @param {string} peakClass
 * @returns {LoadPart}
 */
function part(mbps, peakClass) {
  const figure = Number.isFinite(mbps) && mbps > 0 ? mbps : null;
  // A figure that is missing is no figure, whatever the part claimed to be.
  return { mbps: figure, peakClass: figure === null ? PEAK_CLASS.UNKNOWN : peakClass };
}

/**
 * The picture part of a load, read from an output's identity.
 *
 * An encoder given no limit states no bound, and its part is `unknown` — unless
 * this host has seen outputs of exactly this mode carry a peak (roadmap item
 * 97, step 14), and then that peak is its figure, as an ESTIMATE: it is what
 * was seen, not a bound anything holds the encoder to.
 *
 * @param {import("../output/OutputSpec.js").OutputSpec} spec
 * @param {number | null} sourceMbps - The average rate the source file states.
 * @param {number | null} [observedPeakMbps] - The largest peak outputs of this
 *   mode were seen carrying on this configuration, or null.
 * @returns {LoadPart | null} Null for an output that carries no picture.
 */
export function videoLoadOfSpec(spec, sourceMbps, observedPeakMbps = null) {
  if (!spec?.video) {
    return null;
  }
  const encode = spec.video.encode;
  if (!encode) {
    return part(sourceMbps, PEAK_CLASS.ESTIMATED);
  }
  const rateControl = encode.rateControl;
  if (rateControl) {
    return part(rateControl.maxrateKbps / 1000, PEAK_CLASS.KNOWN);
  }
  return Number.isFinite(observedPeakMbps) && observedPeakMbps > 0
    ? part(observedPeakMbps, PEAK_CLASS.ESTIMATED)
    : part(null, PEAK_CLASS.UNKNOWN);
}

/**
 * The picture part of a load for a height nothing has produced yet, the way
 * it WOULD be produced here: at the nominal limit on the software encoder,
 * with no limit on a hardware one, and as the source's own stream when the
 * picture is copied at the source's height.
 *
 * The nominal limit is the one of the FRAME the height would be encoded at,
 * chosen by its area (`nominalKbpsFor`) — the same row the output is then
 * opened in, so the offer and the output cannot price one step differently.
 *
 * @param {{ sourceHeight: number, copiesAtSource: boolean, sourceMbps: number | null, encoderKind: string }} picture
 * @param {{ width: number, height: number }} frame - The frame this height is
 *   encoded at for this source.
 * @returns {LoadPart}
 */
export function videoLoadForFrame(picture, frame) {
  const sourceHeight = Math.round(Number(picture?.sourceHeight) || 0);
  if (picture?.copiesAtSource === true && frame.height === sourceHeight) {
    return part(picture?.sourceMbps ?? null, PEAK_CLASS.ESTIMATED);
  }
  if (picture?.encoderKind !== "software") {
    return part(null, PEAK_CLASS.UNKNOWN);
  }
  return part(maxrateKbpsFor(nominalKbpsFor(frame)) / 1000, PEAK_CLASS.KNOWN);
}

/**
 * The picture part of a load for a software encode at a nominal limit nothing
 * has produced yet. The bound is the one `softwareRateControlFor` would give
 * it, so an output opened at that limit carries exactly this load.
 *
 * @param {number} nominalKbps
 * @returns {LoadPart}
 */
export function videoLoadOfLimit(nominalKbps) {
  return part(maxrateKbpsFor(nominalKbps) / 1000, PEAK_CLASS.KNOWN);
}

/**
 * The soundtrack part of a load: the track THIS viewer chose.
 *
 * @param {{ transcode: boolean, bitrateKbps: number | null } | null} track -
 *   Null when the viewer receives no sound from this output or beside it.
 * @param {number} transcodeKbps - What a re-encoded track is produced at.
 * @returns {LoadPart | null}
 */
export function audioLoadOf(track, transcodeKbps) {
  if (!track) {
    return null;
  }
  if (track.transcode === true) {
    return part(transcodeKbps / 1000, PEAK_CLASS.KNOWN);
  }
  return part((Number(track.bitrateKbps) || 0) / 1000, PEAK_CLASS.ESTIMATED);
}

/**
 * The whole load: the parts added, and the class of the least trustworthy.
 *
 * @param {LoadPart | null} video
 * @param {LoadPart | null} audio
 * @returns {Load}
 */
export function loadOf(video, audio) {
  const parts = [video, audio].filter(Boolean);
  const peakClass = parts.reduce(
    (worst, one) => (CLASS_ORDER.indexOf(one.peakClass) > CLASS_ORDER.indexOf(worst) ? one.peakClass : worst),
    PEAK_CLASS.KNOWN
  );
  const totalMbps = peakClass === PEAK_CLASS.UNKNOWN
    ? null
    : parts.reduce((sum, one) => sum + one.mbps, 0);
  return { video, audio, totalMbps, peakClass };
}

/**
 * What a link that measured `linkMbps` does with a load.
 *
 * 1. nothing measured the link — every class is admitted, since the link gave
 *    no ground to refuse, and nothing is confirmed;
 * 2. an `unknown` load against a measured link — `no safe bound`, refused:
 *    there is no number to compare;
 * 3. otherwise the load is compared with the usable share of the link: a
 *    `known` load that passes FITS and is confirmed, an `estimated` one that
 *    passes is admitted by estimate and is NOT confirmed.
 *
 * @param {number | null} linkMbps
 * @param {Load} load
 * @returns {{ verdict: string, admitted: boolean, confirmed: boolean, linkMbps: number | null, load: Load }}
 */
export function linkCouldCarry(linkMbps, load) {
  const measured = Number.isFinite(linkMbps) && linkMbps > 0;
  const answer = (verdict, admitted, confirmed) => ({
    verdict,
    admitted,
    confirmed,
    linkMbps: measured ? linkMbps : null,
    load
  });
  if (!measured) {
    return answer(LINK_VERDICT.NO_MEASUREMENT, true, false);
  }
  if (load.peakClass === PEAK_CLASS.UNKNOWN) {
    return answer(LINK_VERDICT.NO_SAFE_BOUND, false, false);
  }
  if (linkMbps * LINK_SAFETY < load.totalMbps) {
    return answer(LINK_VERDICT.DOES_NOT_FIT, false, false);
  }
  return load.peakClass === PEAK_CLASS.KNOWN
    ? answer(LINK_VERDICT.FITS, true, true)
    : answer(LINK_VERDICT.ESTIMATED_TO_FIT, true, false);
}

/**
 * How strongly an answer is admitted, for ordering: a load whose figure is a
 * bound before one whose figure is an average, and both before one with no
 * figure (which is only ever admitted with nothing measured). Zero for a
 * refusal.
 *
 * @param {{ admitted: boolean, load: Load }} answer
 * @returns {number}
 */
export function admissionRank(answer) {
  if (!answer.admitted) {
    return 0;
  }
  return 3 - CLASS_ORDER.indexOf(answer.load.peakClass);
}

/**
 * The figures behind an answer, as plain values a log line or a report can
 * carry.
 *
 * @param {{ verdict: string, linkMbps: number | null, load: Load }} answer
 * @returns {object}
 */
export function linkAnswerFigures(answer) {
  return {
    verdict: answer.verdict,
    linkMbps: answer.linkMbps,
    linkSafety: LINK_SAFETY,
    videoMbps: answer.load.video?.mbps ?? null,
    videoClass: answer.load.video?.peakClass ?? null,
    audioMbps: answer.load.audio?.mbps ?? null,
    audioClass: answer.load.audio?.peakClass ?? null,
    totalMbps: answer.load.totalMbps,
    peakClass: answer.load.peakClass
  };
}
