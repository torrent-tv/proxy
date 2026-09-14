/**
 * @file A session manager for a test, with a store of its own.
 *
 * ONE MANAGER, ONE ROOT. In production that is true by construction: one
 * process holds one manager, and the store's root is a fixed path so that a
 * restart can find what the process before it finished (`SegmentStore.sweep`).
 * Under `node --test` it is false — the runner starts one PROCESS PER FILE and
 * runs them in parallel, so every manager built without a store of its own
 * shared the one default root with every other file running at that moment.
 *
 * What that cost, measured 2026-09-14: `disposeAll` removes the store's whole
 * root, and four files call it between them 40 times. Running the twenty-one
 * files that build a manager gave 2, 3 and 4 failures on consecutive runs and
 * zero with `--test-concurrency=1`; the victim was always
 * `segment-serve-wiring.test.js`, reporting a segment missing that it had
 * written itself a moment earlier, because another process had deleted the
 * directory under it. `npm test` is `node --test`, so this was the project's
 * own test command, and it is why a red result had become something to read
 * past rather than to act on.
 *
 * A test that fails by luck is worse than one that does not exist: it costs a
 * run every time, and it trains everyone to ignore red.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HlsSessionManager } from "../../services/hls-session-manager.js";
import { SegmentStore } from "../../services/encode/SegmentStore.js";

/**
 * A manager whose produced segments live where nothing else can reach them.
 *
 * @param {object} [options] - Passed to the manager, over the defaults below.
 *   A `segmentStore` given here wins, for a test that wants to watch the store
 *   itself.
 * @returns {{ manager: HlsSessionManager, store: SegmentStore, root: string,
 *   cleanup: () => void }} `cleanup` removes the root; call it from `t.after`.
 */
export function managerWithOwnStore(options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ttv-store-"));
  const store = options.segmentStore ?? new SegmentStore({ root });
  const manager = new HlsSessionManager({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090,
    ...options,
    segmentStore: store
  });
  return {
    manager,
    store,
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}
