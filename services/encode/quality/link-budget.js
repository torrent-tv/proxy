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
 * 1. `known` — a bound the stream is held to: a re-encode's `maxrate`, or the
 *    most a copied soundtrack's codec allows it to carry;
 * 2. `estimated` — an average: a copied picture's or soundtrack's rate as the
 *    FILE states it, or the target a re-encoded soundtrack is asked for. An
 *    average is not a bound, so a load built on it is admitted only by
 *    estimate and is never confirmed;
 * 3. `unknown` — no figure at all: a hardware encoder given no limit, a copied
 *    soundtrack whose rate nothing states.
 *
 * A load is as trustworthy as its least trustworthy part.
 *
 * AND WHAT THE CONNECTION CARRIES BESIDES THE FILM (torrent-tv/meta#169). The
 * same connection carries message framing, playlists, poll answers, probes and
 * pushed cues. Their share is measured by the transport over everything this
 * proxy has delivered (`transport/delivery-shares.js`) and added on top of the
 * picture and the sound. It is an average proportion and not a bound, so it
 * moves the figure without deciding the load's class; unmeasured, nothing is
 * added and the figures say so (`serviceShare: null`).
 */

import { AUDIO_TRANSCODE_KBPS, maxrateKbpsFor, nominalKbpsFor } from "../args.js";

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
 * @typedef {{ video: LoadPart | null, audio: LoadPart | null, serviceMbps: number | null, serviceShare: number | null, totalMbps: number | null, peakClass: string }} Load
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
 * The nominal limit scales this file's measured picture rate by the output
 * frame's area, matching the rate control used when the output is opened.
 *
 * @param {{ sourceWidth: number, sourceHeight: number, sourceMbps: number | null, sourcePictureKbps: number | null, copiesAtSource: boolean, encoderKind: string }} picture
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
  const nominal = nominalKbpsFor(frame, {
    width: picture.sourceWidth,
    height: picture.sourceHeight,
    pictureKbps: picture.sourcePictureKbps
  });
  return part(nominal === null ? null : maxrateKbpsFor(nominal) / 1000, PEAK_CLASS.KNOWN);
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
 * The soundtrack part of a load: the track THIS viewer receives, in the mode
 * it is actually produced in.
 *
 * Copied, the track weighs what its codec allows it to — the bound its
 * configuration is held to, `known` — and where no such bound is confirmed, the
 * average the file states for it, `estimated`. Re-encoded, it weighs the rate
 * the encoder is asked for, and that is `estimated` too: ffmpeg's AAC encoder
 * treats `-b:a` as a target its rate control drifts towards, not a limit
 * (`libavcodec/aacenc.c`, 8.1.2), and the 6144-bit frame limit it does hold
 * cannot be turned into a rate without the output's sampling frequency, which
 * the command does not fix. `research/soundtrack-rate-bound-2026-10-01.md`.
 *
 * @param {import("../../media/audio-inventory.js").AudioInventoryEntry | null | undefined} entry -
 *   The inventory entry of the track; null when nothing describes it.
 * @param {boolean | null} transcode - How it reaches the viewer; null when the
 *   viewer receives no sound from this output or beside it.
 * @returns {LoadPart | null}
 */
export function soundtrackLoadOf(entry, transcode) {
  if (transcode === null || transcode === undefined) {
    return null;
  }
  if (transcode === true) {
    return part(AUDIO_TRANSCODE_KBPS / 1000, PEAK_CLASS.ESTIMATED);
  }
  const peakKbps = Number(entry?.peakKbps);
  if (Number.isFinite(peakKbps) && peakKbps > 0) {
    return part(peakKbps / 1000, PEAK_CLASS.KNOWN);
  }
  return part((Number(entry?.bitrateKbps) || 0) / 1000, PEAK_CLASS.ESTIMATED);
}

/**
 * Whether a copied track has a figure for the link to be asked about: a
 * confirmed bound, or a rate the file states.
 *
 * @param {import("../../media/audio-inventory.js").AudioInventoryEntry | null | undefined} entry
 * @returns {boolean}
 */
function soundtrackHasFigure(entry) {
  const peakKbps = Number(entry?.peakKbps);
  const bitrateKbps = Number(entry?.bitrateKbps);
  return (Number.isFinite(peakKbps) && peakKbps > 0) || (Number.isFinite(bitrateKbps) && bitrateKbps > 0);
}

/**
 * How a soundtrack is produced for a viewer, decided once, when they choose it.
 *
 * 1. the browser plays the track as it is and the track has a figure — copied;
 * 2. the browser cannot play it, or it has no figure at all — re-encoded to AAC,
 *    where re-encoding is allowed. Without a figure the link cannot be asked
 *    whether a copy fits it, and the re-encode is the soundtrack that does have
 *    one;
 * 3. re-encoding not allowed: a track the browser plays is copied, figure or
 *    not, and the link's own answer about it stands; a track it cannot play
 *    cannot be served at all.
 *
 * @param {object} params
 * @param {import("../../media/audio-inventory.js").AudioInventoryEntry | null | undefined} params.entry
 * @param {boolean} params.browserPlays - Whether the viewer's browser can play
 *   this track's codec as it stands.
 * @param {boolean} params.transcodeAllowed
 * @returns {{ transcode: boolean | null, cause: string }} `transcode: null`
 *   when the track cannot be served. `cause` is one of {@link SOUNDTRACK_MODE_CAUSE}.
 */
export function chooseSoundtrackMode({ entry, browserPlays, transcodeAllowed }) {
  const hasFigure = soundtrackHasFigure(entry);
  if (browserPlays && hasFigure) {
    return { transcode: false, cause: SOUNDTRACK_MODE_CAUSE.COPY };
  }
  if (transcodeAllowed) {
    return { transcode: true, cause: browserPlays ? SOUNDTRACK_MODE_CAUSE.NO_FIGURE : SOUNDTRACK_MODE_CAUSE.UNPLAYABLE };
  }
  return browserPlays
    ? { transcode: false, cause: SOUNDTRACK_MODE_CAUSE.COPY_WITHOUT_FIGURE }
    : { transcode: null, cause: SOUNDTRACK_MODE_CAUSE.CANNOT_SERVE };
}

/** Why a soundtrack is produced the way {@link chooseSoundtrackMode} decided. */
export const SOUNDTRACK_MODE_CAUSE = Object.freeze({
  COPY: "copied: the browser plays it and its rate is stated",
  NO_FIGURE: "re-encoded: nothing states how much a copy of it would carry",
  UNPLAYABLE: "re-encoded: the browser cannot play it as it is",
  COPY_WITHOUT_FIGURE: "copied without a stated rate: re-encoding is not allowed here",
  CANNOT_SERVE: "the browser cannot play it and re-encoding is not allowed here"
});

/**
 * The whole load: the parts added, what the connection carries besides them,
 * and the class of the least trustworthy part.
 *
 * @param {LoadPart | null} video
 * @param {LoadPart | null} audio
 * @param {number | null} [serviceShare] - What the connection carries beyond
 *   the film, per byte of film, as the transport measured it; null while
 *   nothing has been measured.
 * @returns {Load}
 */
export function loadOf(video, audio, serviceShare = null) {
  const parts = [video, audio].filter(Boolean);
  const peakClass = parts.reduce(
    (worst, one) => (CLASS_ORDER.indexOf(one.peakClass) > CLASS_ORDER.indexOf(worst) ? one.peakClass : worst),
    PEAK_CLASS.KNOWN
  );
  const share = Number.isFinite(serviceShare) && serviceShare >= 0 ? serviceShare : null;
  const filmMbps = peakClass === PEAK_CLASS.UNKNOWN
    ? null
    : parts.reduce((sum, one) => sum + one.mbps, 0);
  const serviceMbps = filmMbps === null || share === null ? null : filmMbps * share;
  const totalMbps = filmMbps === null ? null : filmMbps + (serviceMbps ?? 0);
  return { video, audio, serviceMbps, serviceShare: share, totalMbps, peakClass };
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
  // The measured link against the whole load, with no share held back. The
  // reading is what the link carried while it carried a piece, and the stream
  // needs that on average; what a link does when it is not perfect — a pause,
  // another tab — is what the viewer's buffer and `drain-threat.js` measure.
  if (linkMbps < load.totalMbps) {
    return answer(LINK_VERDICT.DOES_NOT_FIT, false, false);
  }
  return load.peakClass === PEAK_CLASS.KNOWN
    ? answer(LINK_VERDICT.FITS, true, true)
    : answer(LINK_VERDICT.ESTIMATED_TO_FIT, true, false);
}

/**
 * Why a link refused a load, in words naming what was missing or too much.
 *
 * `no safe bound` names every part that has no figure — the picture, the
 * soundtrack or both — because that, and not the link, is what the refusal is
 * about. Any other refusal is about the size of the load and is described by
 * the caller, who knows which outputs were weighed.
 *
 * @param {{ verdict: string, load: Load }} answer
 * @param {string} otherwise - The words for a load that is too large.
 * @returns {string}
 */
export function linkRefusalReason(answer, otherwise) {
  if (answer?.verdict !== LINK_VERDICT.NO_SAFE_BOUND) {
    return otherwise;
  }
  const missing = [
    answer.load?.video?.peakClass === PEAK_CLASS.UNKNOWN ? "the picture" : "",
    answer.load?.audio?.peakClass === PEAK_CLASS.UNKNOWN ? "the soundtrack" : ""
  ].filter(Boolean);
  return `nothing states how much ${missing.length > 0 ? missing.join(" or ") : "this output"} would send, ` +
    "so this viewer's link cannot be asked whether it fits";
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
    videoMbps: answer.load.video?.mbps ?? null,
    videoClass: answer.load.video?.peakClass ?? null,
    audioMbps: answer.load.audio?.mbps ?? null,
    audioClass: answer.load.audio?.peakClass ?? null,
    serviceMbps: answer.load.serviceMbps ?? null,
    serviceShare: answer.load.serviceShare ?? null,
    totalMbps: answer.load.totalMbps,
    peakClass: answer.load.peakClass
  };
}
