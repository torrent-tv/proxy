/**
 * @file Which output a viewer has on screen.
 *
 * The browser addresses the picture output for the whole film. After a quality
 * change, the viewer's record identifies the selected output. Keeping this per
 * viewer prevents one viewer's quality change from changing another viewer's
 * selection.
 *
 * An unnamed viewer has its own record under the empty id. This module stores
 * no output, viewer or encoder state.
 */

import { viewersOf } from "./Viewer.js";

/**
 * @param {object} params
 * @param {object} params.base - The picture output.
 * @param {string} [params.consumerId] - Whose screen. Empty asks about the
 *   unnamed viewer.
 * @param {{ get: (id: string) => object | undefined }} params.outputs - Every live output, by id.
 * @returns {object} A live output, never a disposed one.
 */
export function activeOutputFor({ base, consumerId = "", outputs }) {
  const viewer = viewersOf(base).get(consumerId) ?? null;
  const activeId = viewer?.activeVariantId ?? null;
  if (!activeId || activeId === base.id) {
    return base;
  }
  const active = outputs.get(activeId);
  if (!active) {
    // The rung is gone, so the viewer is watching the picture again.
    if (viewer) {
      viewer.activeVariantId = null;
    }
    return base;
  }
  return active;
}
