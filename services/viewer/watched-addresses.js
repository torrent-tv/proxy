/**
 * @file Which output addresses are being prepared, and which are watched, for
 * the encoder admission. Moved out of `wire-outputs.js` verbatim
 * (torrent-tv/meta#280).
 */

import { outputsBeingPrepared } from "./choices.js";

/**
 * The output keys of the outputs a viewer is being prepared for.
 *
 * @param {object} viewers
 * @param {{ get: (id: string) => { outputKey?: string } | undefined }} outputs
 * @returns {Set<string>}
 */
export function preparedAddresses(viewers, outputs) {
  const addresses = new Set();
  for (const id of outputsBeingPrepared(viewers)) {
    const key = outputs.get(id)?.outputKey;
    if (key) {
      addresses.add(key);
    }
  }
  return addresses;
}

/**
 * Every output a present viewer receives that still has something left to
 * make, by address.
 *
 * @param {object} viewers
 * @param {{ values: () => Iterable<object>, supersededBy: (session: object, variantId: string | null) => boolean }} outputs
 * @param {(output: object) => boolean} finished
 * @returns {Set<string>}
 */
export function watchedAddresses(viewers, outputs, finished) {
  const addresses = new Set();
  for (const session of outputs.values()) {
    const address = session.outputKey;
    if (!address || addresses.has(address) || finished(session)) {
      continue;
    }
    for (const viewer of viewers.forOutput(session).values()) {
      if (viewer.isPresent() && !outputs.supersededBy(session, viewer.activeVariantId ?? null)) {
        addresses.add(address);
        break;
      }
    }
  }
  return addresses;
}
