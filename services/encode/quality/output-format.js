/**
 * @file The format an output produces, decided before it is named — because
 * the name IS the format (decided with the user 2026-09-16).
 *
 * A copy is the source's own picture. A re-encode is which encoder, the size,
 * the frame rate, the speed setting and whether HDR is tone mapped:
 *
 * 1. a size produced exactly — every rung of a master — is the box asked for,
 *    fitted to the source, and only its speed setting is chosen;
 * 2. a size left to the budget is the highest rung of the viewer's own ladder
 *    this machine holds, with the speed setting for that rung;
 * 3. on a hardware encoder, or with no startup measurement, there is no ladder
 *    to choose from and the box asked for is produced.
 *
 * Then an output already made may serve the viewer instead
 * (`serving-output.js`).
 *
 * Nothing here reads the machine or the disk: what it needs arrives as values
 * and as functions over them.
 */

import { computeOutputDimensions } from "../args.js";
import { buildResolutionLadder, canSustainOutput, pickSoftwarePreset } from "../hwaccel.js";
import { OutputSpec } from "../output/OutputSpec.js";
import { chooseServingOutput, nextRungAreaBelow, servingCandidates } from "./serving-output.js";
import { linkCouldCarry } from "./link-budget.js";

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
 * @param {(encode: object | null) => OutputSpec} params.specWith - The output
 *   with this picture format and every other part as the request made it.
 * @param {{ mode: "auto" | "manual", linkMbps: number | null, keys: Iterable<string>, readyAt: (key: string) => boolean }} params.serving
 * @returns {{ spec: OutputSpec, budget: object | null, wantedKey: string, servedBy: string | null }}
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
  specWith,
  serving
}) {
  if (!encodesPicture) {
    const spec = specWith(null);
    return { spec, budget: null, wantedKey: spec.toKey(), servedBy: null };
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
  const software = encoder.kind === "software" && Boolean(benchmark);
  const preset = budget
    ? budget.preset
    : software && width > 0
      ? pickSoftwarePreset(benchmark, width * height * fps, priced)
      : null;
  const spec = specWith({ encoder: encoder.name, width, height, fps, preset, tonemap });
  const wantedKey = spec.toKey();
  if (!ceiling) {
    return { spec, budget, wantedKey, servedBy: null };
  }
  const served = chooseServingOutput({
    mode: serving.mode,
    wanted: { width, height },
    nextLowerArea: nextRungAreaBelow(buildResolutionLadder(ceiling.w, ceiling.h), height),
    atRisk: software && !canSustainOutput({ benchmark, ...priced, outputPixelsPerSec: width * height * fps }).sustainable,
    linkCarries: (peakMbps) => linkCouldCarry(serving.linkMbps, peakMbps),
    candidates: servingCandidates({
      wanted: spec,
      keys: serving.keys,
      source,
      encoderName: encoder.name,
      readyAt: serving.readyAt
    })
  });
  const chosen = served && served !== wantedKey ? OutputSpec.fromKey(served) : null;
  return chosen
    ? { spec: chosen, budget, wantedKey, servedBy: served }
    : { spec, budget, wantedKey, servedBy: null };
}
