/**
 * @file Who takes disk, and how each of them is told its share.
 *
 * Kept apart from the owner because the owner knows nothing about this proxy —
 * it reads a number, divides it and hands out shares — and kept out of the
 * session manager because a list of claimants is not a fact about a session.
 *
 * A CLAIMANT IS WHOEVER HOLDS BYTES, and every one of them is here. Three do:
 * the segments an encoder produced, the pieces the memory store spilled, and
 * the files downloaded whole. Two of the three live on the torrent thread, so
 * they arrive as a pair of closures over its channel rather than as the objects
 * themselves.
 *
 * What is NOT a claimant is anything that merely counts somebody else's bytes.
 * The torrent pool held a "disk cap" of 10 GB over `torrentDownloadedBytes` —
 * a sum over WebTorrent's bitfield, so a piece held purely in MEMORY told
 * against a ceiling called disk, while the bytes it was meant to bound belong
 * to the spill and to the whole files, which have owners of their own. It owned
 * nothing and is gone.
 */

import { DiskSpace } from "./DiskSpace.js";

/**
 * Build the owner of the disk and register everything that takes any of it.
 *
 * @param {object} params
 * @param {{ root: string, stats: () => { bytes: number } }} params.segmentStore
 * @param {{ held: () => number, allow: (bytes: number) => unknown }} [params.spill] -
 *   The pieces the memory store spills. They live on the torrent thread, so
 *   this is a pair of closures over the channel rather than the pool itself.
 * @param {{ held: () => number, allow: (bytes: number) => unknown }} [params.wholeFiles] -
 *   Files downloaded whole and kept as files, on the torrent thread as well.
 * @param {import("./Diagnostics.js").Diagnostics} [params.diagnostics] - The
 *   evidence: core dumps, heap snapshots, packet captures. A claimant like the
 *   rest, and the one that stops COLLECTING rather than deleting when it is
 *   over its share. Built where the collectors are, so one object is both
 *   registered here and consulted by them.
 * @param {(directory: string) => Promise<number | null>} params.readFree
 * @param {{ info: Function, warn?: Function }} [params.logger]
 * @returns {{ revise: () => Promise<unknown>, segmentBytes: () => number, describe: () => string }}
 *   What the segments may hold is asked for rather than pushed: zero until the
 *   first revision, and zero stops growth rather than licensing it.
 */
export function wireDiskSpace({ segmentStore, spill, wholeFiles, diagnostics, readFree, logger }) {
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
  if (typeof spill?.allow === "function") {
    // The share travels the channel that already carries everything else, and
    // the reply says what they hold — one exchange, both directions.
    space.register({
      name: "spilled pieces",
      held: () => spill.held?.() ?? 0,
      wanted: () => Number.MAX_SAFE_INTEGER,
      allow: (bytes) => {
        void spill.allow(bytes);
      }
    });
  }
  if (typeof wholeFiles?.allow === "function") {
    space.register({
      name: "whole files",
      held: () => wholeFiles.held?.() ?? 0,
      // A whole file is worth keeping while anybody may read it again, and
      // there is no smaller honest answer than "all of them" — like the rest,
      // it is cut in proportion.
      wanted: () => Number.MAX_SAFE_INTEGER,
      allow: (bytes) => {
        void wholeFiles.allow(bytes);
      }
    });
  }
  if (diagnostics) {
    space.register({
      name: "diagnostics",
      held: () => diagnostics.held(),
      // What it holds plus one more of the largest kind seen — measured, and
      // nothing before a fault has happened.
      wanted: () => diagnostics.wanted(),
      allow: (bytes) => diagnostics.allow(bytes)
    });
  }
  return {
    revise: async () => {
      // Re-read the evidence before dividing: it is the one claimant whose
      // bytes are written by something that never reports them.
      await diagnostics?.measure();
      return space.revise();
    },
    segmentBytes: () => segmentBytes,
    diagnostics,
    describe: () => `${space.describe()}${diagnostics ? `; ${diagnostics.describe()}` : ""}`
  };
}
