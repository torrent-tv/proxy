/**
 * @file What a viewer's link does with an output's whole load — roadmap item
 * 97, step 11.
 *
 * Pure functions over plain numbers: no session, no viewer, no clock.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  admissionRank,
  LINK_VERDICT,
  linkCouldCarry,
  loadOf,
  PEAK_CLASS,
  soundtrackLoadOf,
  videoLoadForFrame,
  videoLoadOfSpec
} from "../services/encode/quality/link-budget.js";
import { AUDIO_TRANSCODE_KBPS, maxrateKbpsFor, nominalKbpsFor, softwareRateControlFor } from "../services/encode/args.js";
import { outputSpec } from "./helpers/output-spec.js";

const known = (mbps) => ({ mbps, peakClass: PEAK_CLASS.KNOWN });
const estimated = (mbps) => ({ mbps, peakClass: PEAK_CLASS.ESTIMATED });
const unknown = () => ({ mbps: null, peakClass: PEAK_CLASS.UNKNOWN });

test("a copied source at its own height is its stated average — an estimate, not a bound", () => {
  const part = videoLoadForFrame({ sourceHeight: 1080, copiesAtSource: true, sourceMbps: 3.73, encoderKind: "software" }, { width: 1920, height: 1080 });
  assert.deepEqual(part, estimated(3.73));
});

test("a height the software encoder makes is bounded by the nominal limit of that height", () => {
  const part = videoLoadForFrame({ sourceHeight: 1080, copiesAtSource: true, sourceMbps: 3.73, encoderKind: "software" }, { width: 1280, height: 720 });
  assert.deepEqual(part, known(maxrateKbpsFor(nominalKbpsFor({ width: 1280, height: 720 })) / 1000));
});

test("a height a hardware encoder makes has no bound at all", () => {
  // It is given a quality figure and no -maxrate, so there is nothing to
  // compare a link against.
  const part = videoLoadForFrame({ sourceHeight: 1080, copiesAtSource: false, sourceMbps: 3.73, encoderKind: "nvenc" }, { width: 1280, height: 720 });
  assert.deepEqual(part, unknown());
});

test("an output's picture is read off its own rate control", () => {
  const rateControl = softwareRateControlFor({ width: 1280, height: 720, fps: 24, capKbps: 1400 });
  const limited = outputSpec({ transcodeVideo: true, width: 1280, height: 720, rateControl });
  const unlimited = outputSpec({ transcodeVideo: true, width: 1280, height: 720 });
  assert.deepEqual(videoLoadOfSpec(limited, 3.73), known(rateControl.maxrateKbps / 1000));
  assert.deepEqual(videoLoadOfSpec(unlimited, 3.73), unknown(), "no limit, no bound");
  assert.deepEqual(videoLoadOfSpec(outputSpec(), 3.73), estimated(3.73), "a copy is its source's average");
});

test("a soundtrack is estimated when re-encoded or copied at a stated rate, known at its codec's bound, unknown when nothing states one", () => {
  assert.deepEqual(soundtrackLoadOf({ bitrateKbps: null }, true), estimated(AUDIO_TRANSCODE_KBPS / 1000));
  assert.deepEqual(soundtrackLoadOf({ bitrateKbps: 640 }, false), estimated(0.64));
  assert.deepEqual(soundtrackLoadOf({ bitrateKbps: 640, peakKbps: 640 }, false), known(0.64));
  assert.deepEqual(soundtrackLoadOf({ bitrateKbps: null }, false), unknown());
  assert.equal(soundtrackLoadOf(null, null), null, "no sound, no part");
});

test("a load is as trustworthy as its least trustworthy part", () => {
  assert.equal(loadOf(known(3), known(0.128)).peakClass, PEAK_CLASS.KNOWN);
  assert.equal(loadOf(known(3), estimated(0.64)).peakClass, PEAK_CLASS.ESTIMATED);
  assert.equal(loadOf(known(3), unknown()).peakClass, PEAK_CLASS.UNKNOWN);
  assert.equal(loadOf(known(3), unknown()).totalMbps, null, "an unknown part leaves no total");
  assert.ok(Math.abs(loadOf(known(3), known(0.128)).totalMbps - 3.128) < 1e-9, "the sound is added to the picture");
});

test("the sound is counted with the picture against the whole measured link", () => {
  // The picture alone fits the link exactly; with the soundtrack the viewer
  // hears, it does not. No share of the link is held back.
  const link = 10;
  const picture = known(link);
  assert.equal(linkCouldCarry(link, loadOf(picture, null)).verdict, LINK_VERDICT.FITS, "without sound it would pass");
  assert.equal(
    linkCouldCarry(link, loadOf(picture, known(AUDIO_TRANSCODE_KBPS / 1000))).verdict,
    LINK_VERDICT.DOES_NOT_FIT,
    "with the 128 kbit/s soundtrack it does not"
  );
});

test("a known load that passes fits and is confirmed; an estimated one is admitted and not confirmed", () => {
  const fits = linkCouldCarry(10, loadOf(known(5), null));
  assert.equal(fits.verdict, LINK_VERDICT.FITS);
  assert.equal(fits.confirmed, true);
  const byEstimate = linkCouldCarry(10, loadOf(estimated(5), null));
  assert.equal(byEstimate.verdict, LINK_VERDICT.ESTIMATED_TO_FIT);
  assert.equal(byEstimate.admitted, true);
  assert.equal(byEstimate.confirmed, false, "an average is not a bound");
});

test("an unknown load is refused against a measured link, and admitted while nothing measured it", () => {
  const measured = linkCouldCarry(50, loadOf(unknown(), null));
  assert.equal(measured.verdict, LINK_VERDICT.NO_SAFE_BOUND);
  assert.equal(measured.admitted, false, "there is no number to compare, however fast the link");
  for (const unmeasured of [null, 0, Number.NaN]) {
    const answer = linkCouldCarry(unmeasured, loadOf(unknown(), null));
    assert.equal(answer.verdict, LINK_VERDICT.NO_MEASUREMENT);
    assert.equal(answer.admitted, true, "the link gave no ground to refuse");
    assert.equal(answer.confirmed, false);
  }
});

test("a bound ranks before an average, and a refusal ranks nowhere", () => {
  const knownAnswer = linkCouldCarry(null, loadOf(known(5), null));
  const estimatedAnswer = linkCouldCarry(null, loadOf(estimated(5), null));
  const unknownAnswer = linkCouldCarry(null, loadOf(unknown(), null));
  assert.ok(admissionRank(knownAnswer) > admissionRank(estimatedAnswer));
  assert.ok(admissionRank(estimatedAnswer) > admissionRank(unknownAnswer));
  assert.equal(admissionRank(linkCouldCarry(1, loadOf(known(5), null))), 0);
});
