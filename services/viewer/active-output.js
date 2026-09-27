/**
 * @file Which output a viewer has on screen.
 *
 * The browser addresses the picture output for the whole film. After a quality
 * change, the viewer's record identifies the selected output. Keeping this per
 * viewer prevents one viewer's quality change from changing another viewer's
 * selection.
 *
 * A request that names nobody has the picture itself on screen. This module
 * stores no output, viewer or encoder state.
 */

/**
 * @param {object} params
 * @param {object} params.base - The picture output.
 * @param {string} [params.consumerId] - Whose screen. Empty names nobody, and
 *   the answer is the picture.
 * @param {{ get: (id: string) => object | undefined }} params.outputs - Every live output, by id.
 * @param {{ getForOutput: (output: object, consumerId: string) => object | null }} params.viewers
 * @returns {object} A live output, never a disposed one.
 */
export function activeOutputFor({ base, consumerId = "", outputs, viewers }) {
  const viewer = viewers.getForOutput(base, consumerId);
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
