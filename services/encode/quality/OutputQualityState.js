/**
 * Mutable quality observations for one output.
 *
 * An encoded output describes media. Measurements and cached
 * offers belong to the quality component and disappear with its owner.
 */

const states = new WeakMap();

export function qualityStateOf(output) {
  let state = states.get(output);
  if (!state) {
    state = {
      predictedSpeedWhenOffered: null,
      predictedMode: null,
      offeredSpeedAtCheapestMode: null,
      lastPredictionRatio: null,
      lastAloneSpeed: undefined,
      saidNoVariants: undefined,
      offeredHeightsVersion: undefined,
      offeredHeightsCache: undefined
    };
    states.set(output, state);
  }
  return state;
}
