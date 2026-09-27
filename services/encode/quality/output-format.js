/**
 * @file The format an output produces, decided before it is named — because
 * the name IS the format (decided with the user 2026-09-16).
 *
 * A copy is the source's own picture. A re-encode is which encoder, the size,
 * the frame rate, the speed setting, whether HDR is tone mapped, and the rate
 * control:
 *
 * 1. a size produced exactly — every rung of a master — is the box asked for,
 *    fitted to the source, and only its speed setting is chosen;
 * 2. a size left to the budget is the highest rung of the viewer's own ladder
 *    this machine holds, with the speed setting for that rung;
 * 3. on a hardware encoder, or with no startup measurement, there is no ladder
 *    to choose from and the box asked for is produced.
 *
 * The rate control is part of the format: a software encode is bounded at a
 * limit from `limitsFor(frame)` — the nominal one until a set of lower limits
 * is decided — or at the limit asked for (`capKbps`), and declared at the
 * level of that size's nominal output. A hardware encoder is given no bound.
 *
 * AND THE VIEWER'S LINK DECIDES WHETHER IT MAY BE GIVEN AT ALL (roadmap item
 * 97, step 11). Every format considered is judged by what this viewer's link
 * does with its whole load — the picture and the soundtrack THEY chose
 * (`link-budget.js`). In order:
 *
 * 1. an output already here that suits them (`serving-output.js`);
 * 2. the size wanted, at the highest limit their link admits;
 * 3. in AUTO only, a smaller rung of their ladder at the highest limit their
 *    link admits — a smaller size proves nothing by itself;
 * 4. otherwise NOTHING: the answer is `unavailable`, with the figures, and no
 *    output is named. A format known not to fit is never handed over.
 *
 * Nothing here reads the machine or the disk: what it needs arrives as values
 * and as functions over them.
 */

import { computeOutputDimensions, nominalKbpsFor, softwareRateControlFor } from "../args.js";
import { buildResolutionLadder, canSustainOutput, pickSoftwarePreset } from "../hwaccel.js";
import { OutputSpec } from "../output/OutputSpec.js";
import { chooseServingOutput, nextRungAreaBelow, servingCandidates } from "./serving-output.js";
import { linkAnswerFigures, linkCouldCarry, loadOf, videoLoadOfSpec } from "./link-budget.js";

/**
 * @param {object} params
 * @param {boolean} params.encodesPicture - The output carries a picture and re-encodes it.
 * @param {boolean} params.exact - The size is produced exactly as asked.
 * @param {{ width: number, height: number }} params.target - The box asked for; zeroes mean the source's.
 * @param {{ width: number, height: number, megabitsPerSecond: number | null, decode: object | null }} params.source
 * @param {number} params.fps
 * @param {{ kind: string, name: string }} params.encoder
 * @param {unknown} params.benchmark - The startup measurement of the software encoder, or null.
 * @param {{ decodeModel: object | null, observedDecodeCostSec: number | null, requiredSpeed: number | null }} params.cost
 * @param {(params: object) => object | null} params.chooseBudget - The realtime budget's ladder choice.
 * @param {boolean} params.tonemap
 * @param {number | null} [params.capKbps] - A nominal limit asked for outright;
 *   above the size's own it is refused (`softwareRateControlFor`).
 * @param {(frame: { width: number, height: number }) => number[]} [params.limitsFor] -
 *   The nominal limits a frame may be produced at, highest first; the row is
 *   chosen by the frame's area (`limitRowFor`).
 * @param {import("./link-budget.js").LoadPart | null} [params.audioLoad] - The
 *   soundtrack this viewer receives with the picture, from it or beside it.
 * @param {(encode: object | null) => OutputSpec} params.specWith - The output
 *   with this picture format and every other part as the request made it.
 * @param {{ mode: "auto" | "manual", linkMbps: number | null, keys: Iterable<string>, readyAt: (key: string) => boolean, observedPeakMbps?: (spec: OutputSpec) => number | null }} params.serving
 * @returns {{
 *   spec: OutputSpec | null,
 *   budget: object | null,
 *   wantedKey: string,
 *   reusedKey: string | null,
 *   answer: object | null,
 *   unavailable: { reason: string, figures: object | null } | null
 * }}
 */
export function decideOutputFormat({
  encodesPicture,
  exact,
  target,
  source,
  fps,
  encoder,
  benchmark,
  cost,
  chooseBudget,
  tonemap,
  capKbps = null,
  limitsFor = (frame) => [nominalKbpsFor(frame)],
  audioLoad = null,
  specWith,
  serving
}) {
  const judge = (spec) => linkCouldCarry(
    serving.linkMbps,
    loadOf(videoLoadOfSpec(spec, source.megabitsPerSecond, serving.observedPeakMbps?.(spec) ?? null), audioLoad)
  );
  const given = (spec, answer, extra = {}) => ({
    spec,
    budget: null,
    wantedKey: spec.toKey(),
    reusedKey: null,
    answer,
    unavailable: null,
    ...extra
  });
  const refused = (spec, answer, reason, extra = {}) => ({
    spec: null,
    budget: null,
    wantedKey: spec.toKey(),
    reusedKey: null,
    answer,
    unavailable: { reason, figures: answer ? linkAnswerFigures(answer) : null, bound: "link" },
    ...extra
  });

  if (!encodesPicture) {
    const spec = specWith(null);
    if (!spec.video) {
      // A soundtrack on its own: the viewer's load was judged with the picture
      // it plays beside, which counted this track.
      return given(spec, null);
    }
    const answer = judge(spec);
    return answer.admitted
      ? given(spec, answer)
      : refused(spec, answer, "the source's own picture is more than this viewer's link carries");
  }

  const ceiling = computeOutputDimensions(target.width, target.height, source.width, source.height);
  const budget = exact
    ? null
    : chooseBudget({
        transcodeVideo: true,
        targetWidth: target.width,
        targetHeight: target.height,
        sourceWidth: source.width,
        sourceHeight: source.height,
        outputFps: fps,
        source: source.decode,
        requiredSpeed: cost.requiredSpeed
      });
  const width = budget?.width ?? ceiling?.w ?? 0;
  const height = budget?.height ?? ceiling?.h ?? 0;
  const priced = {
    decodeModel: cost.decodeModel,
    source: source.decode,
    observedDecodeCostSec: cost.observedDecodeCostSec,
    requiredSpeed: cost.requiredSpeed
  };
  const software = encoder.kind === "software";
  const measured = software && Boolean(benchmark);
  // WHETHER THIS MACHINE HAS SHOWN IT CAN ENCODE THIS SIZE (roadmap item 97,
  // step 14): a mode of this encoder qualified at startup, measured at this
  // frame, and fast enough on its own for this source. A size that fails is not
  // a format anybody is given here — not the one asked for, and not a lower
  // one in its place. Whether the machine has room for it BESIDE what already
  // runs is the admission's, asked when the output is opened.
  const machineCan = (w, h) => {
    if (!(w > 0 && h > 0)) {
      return true; // no size to judge: the source's own, which the probe could not read
    }
    if (!Array.isArray(benchmark)) {
      return true; // not calibrated: a wiring made without the startup calibration
    }
    if (benchmark.length === 0) {
      return false; // calibrated, and no mode qualified
    }
    return canSustainOutput({ benchmark, ...priced, outputPixelsPerSec: w * h * fps, frame: { width: w, height: h } }).sustainable;
  };
  const presetFor = (w, h) => (budget && w === width && h === height
    ? budget.preset
    : measured && w > 0
      ? pickSoftwarePreset(benchmark, w * h * fps, priced, { width: w, height: h })
      : null);
  // Every format at one size this viewer could be given, highest limit first.
  // A hardware encoder is given no limit, so it has exactly one.
  const formatsAt = (w, h) => {
    const limits = !software || !(w > 0 && h > 0)
      ? [null]
      : capKbps !== null && capKbps !== undefined && w === width && h === height
        ? [capKbps]
        : limitsFor({ width: w, height: h });
    return limits.map((limit) => specWith({
      encoder: encoder.name,
      width: w,
      height: h,
      fps,
      preset: presetFor(w, h),
      tonemap,
      rateControl: limit === null ? null : softwareRateControlFor({ width: w, height: h, fps, capKbps: limit })
    }));
  };
  const wantedFormats = formatsAt(width, height);
  const wantedSpec = wantedFormats[0];
  const wantedKey = wantedSpec.toKey();

  // A LIMIT NAMED IN THE REQUEST IS WHAT WAS ASKED FOR, and no other output
  // stands in for it. It is named when a viewer is being moved to another
  // limit of the height they watch (roadmap item 97, step 12), and the output
  // they are being moved OFF always suits them by the rule below — so letting
  // the rule answer would hand them back the very output the move is for
  // leaving. An output with exactly this limit is still reused: it has the same
  // key, and the key is what `OutputOpening` looks up.
  const limitNamed = capKbps !== null && capKbps !== undefined;
  if (ceiling && !limitNamed) {
    const served = chooseServingOutput({
      mode: serving.mode,
      wanted: { width, height },
      nextLowerArea: nextRungAreaBelow(buildResolutionLadder(ceiling.w, ceiling.h), height),
      atRisk: measured && !canSustainOutput({ benchmark, ...priced, outputPixelsPerSec: width * height * fps, frame: { width, height } }).sustainable,
      judge: (candidate) => judge(candidate.spec),
      candidates: servingCandidates({
        wanted: wantedSpec,
        keys: serving.keys,
        source,
        encoderName: encoder.name,
        readyAt: serving.readyAt
      })
    });
    if (served && served.key !== wantedKey) {
      return given(OutputSpec.fromKey(served.key), served.answer, { budget, wantedKey, reusedKey: served.key });
    }
  }

  let anySizeHeld = machineCan(width, height);
  if (anySizeHeld) {
    for (const spec of wantedFormats) {
      const answer = judge(spec);
      if (answer.admitted) {
        return given(spec, answer, { budget, wantedKey });
      }
    }
  }
  if (serving.mode !== "manual" && ceiling) {
    for (const rung of buildResolutionLadder(ceiling.w, ceiling.h).filter((one) => one.height < height)) {
      if (!machineCan(rung.width, rung.height)) {
        continue;
      }
      anySizeHeld = true;
      for (const spec of formatsAt(rung.width, rung.height)) {
        const answer = judge(spec);
        if (answer.admitted) {
          return given(spec, answer, { wantedKey });
        }
      }
    }
  }
  if (!anySizeHeld) {
    // Not the viewer's link: this machine. Said apart, because the answer to
    // it is another proxy, found before anything plays.
    return {
      ...refused(wantedSpec, null, `this machine has not shown it can re-encode this picture at ${width}x${height}@${fps} or any size below it`, { budget, wantedKey }),
      unavailable: {
        reason: `this machine has not shown it can re-encode this picture at ${width}x${height}@${fps} or any size below it`,
        figures: { width, height, fps, encoder: encoder.name },
        bound: "machine"
      }
    };
  }
  return refused(
    wantedSpec,
    judge(wantedSpec),
    serving.mode === "manual"
      ? "no limit of the size picked is admitted by this viewer's link"
      : "no size and limit this viewer's ladder offers is admitted by their link",
    { budget, wantedKey }
  );
}
