/**
 * @file Where playback starts: viewer changes reach the source preparation and
 * the download maps, and what an earlier process left behind is adopted.
 *
 * The subscription is made before the adoption, so whatever the adoption or
 * anything after it changes about viewers reaches the maps. This is the seam
 * the start order is tested through, since `server.js` cannot run in a test.
 */

/**
 * @param {object} graph
 * @param {{ viewerChanges: import("node:events").EventEmitter,
 *           lifecycle: { adoptSegmentsLeftBehind(): object } }} graph.outputParts
 * @param {{ viewersChanged(): Promise<unknown> }} graph.downloadMaps
 * @param {() => { refresh(): unknown }} graph.preparation   - read when a change comes, never at the call
 * @param {() => void} graph.onStateChanged
 * @param {(line: string) => void} graph.warn
 * @returns {object} what `adoptSegmentsLeftBehind` returned
 */
export function startPlayback({ outputParts, downloadMaps, preparation, onStateChanged, warn }) {
  outputParts.viewerChanges.on("change", () => {
    void preparation().refresh();
    void downloadMaps.viewersChanged().catch(error => warn(`download maps after a viewer change: ${error.message}`));
    onStateChanged();
  });
  // What the last life of this process left on the disk. The kernel kills this
  // one often enough for that to be an ordinary state rather than an odd one —
  // twice in a single viewing on 2026-09-02 — and when it does, no exit handler
  // runs and nothing is cleared up. So this is both the cleanup and the only
  // record that those encoders ended at all: it says what it found before it
  // decides anything, keeps the segments whose closure is proven, and removes
  // the one piece per output that was being written when the process died.
  return outputParts.lifecycle.adoptSegmentsLeftBehind();
}
