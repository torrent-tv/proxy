/**
 * @file Who takes disk, and how each of them is told its share.
 *
 * Kept apart from the owner because the owner knows nothing about this proxy —
 * it reads a number, divides it and hands out shares — and kept out of the
 * session manager because a list of claimants is not a fact about a session.
 *
 * Two claimants today. The diagnostics are a third and are not here yet: they
 * are bounded by a COUNT and never by a size, which on the addon host let two
 * core dumps and five heap snapshots come to 3.2 GB, and they cannot simply be
 * thrown away when space is short — a dump is the only evidence of the death it
 * records. That needs a rule of its own.
 */

import { DiskSpace } from "./DiskSpace.js";

/**
 * Build the owner of the disk and register everything that takes any of it.
 *
 * @param {object} params
 * @param {{ root: string, stats: () => { bytes: number } }} params.segmentStore
 * @param {{ spilledBytes?: number, allowSpillBytes?: (bytes: number) => unknown }} [params.torrentPool]
 * @param {(directory: string) => Promise<number | null>} params.readFree
 * @param {{ info: Function, warn?: Function }} [params.logger]
 * @returns {{ revise: () => Promise<unknown>, segmentBytes: () => number, describe: () => string }}
 *   What the segments may hold is asked for rather than pushed: zero until the
 *   first revision, and zero stops growth rather than licensing it.
 */
export function wireDiskSpace({ segmentStore, torrentPool, readFree, logger }) {
  const space = new DiskSpace({ readFree: () => readFree(segmentStore.root), logger });
  let segmentBytes = 0;
  space.register({
    name: "segments",
    held: () => segmentStore.stats().bytes,
    // The whole of every film anybody is watching. There is no smaller honest
    // answer, so it asks for everything and is cut in proportion like the rest.
    wanted: () => Number.MAX_SAFE_INTEGER,
    allow: (bytes) => {
      segmentBytes = bytes;
    }
  });
  if (typeof torrentPool?.allowSpillBytes === "function") {
    // The pieces the memory store spills. They live on the torrent thread, so
    // the share travels the channel that already carries everything else, and
    // the reply says what they hold — one exchange, both directions.
    space.register({
      name: "spilled pieces",
      held: () => torrentPool.spilledBytes ?? 0,
      wanted: () => Number.MAX_SAFE_INTEGER,
      allow: (bytes) => {
        void torrentPool.allowSpillBytes?.(bytes);
      }
    });
  }
  return {
    revise: () => space.revise(),
    segmentBytes: () => segmentBytes,
    describe: () => space.describe()
  };
}
