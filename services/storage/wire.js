/**
 * @file Who takes what of this machine, and how each of them is told its share.
 *
 * Kept apart from the owner because the owner knows nothing about this proxy —
 * it reads what is free, divides it and hands out shares — and kept out of the
 * session manager because a list of claimants is not a fact about a session.
 *
 * A CLAIMANT IS WHOEVER HOLDS BYTES, and every one of them is here. Four do:
 * the torrent's pieces in memory, the pieces spilled from there to disk, the
 * segments an encoder produced, the files downloaded whole — and the evidence,
 * which is a claimant with a rule of its own (`Diagnostics.js`). Three of the
 * five live on the torrent thread, so they arrive as pairs of closures over its
 * channel rather than as the objects themselves.
 *
 * **Which RESOURCE each takes is read, not assumed.** Memory is one. Disk is
 * one per device, because two filesystems cannot pay for each other: measured
 * on the addon host 2026-09-05, `/tmp` — the segments and the spill — is the
 * overlay, and `/data` — the evidence — is ext4 on the nvme. One figure divided
 * between claimants on both gave each a share of a disk it does not write to.
 *
 * What is NOT a claimant is anything that merely counts somebody else's bytes.
 * The torrent pool held a "disk cap" of 10 GB over `torrentDownloadedBytes` — a
 * sum over WebTorrent's bitfield, so a piece held purely in MEMORY told against
 * a ceiling called disk, while the bytes it was meant to bound belong to the
 * spill and to the whole files, which have owners of their own. It owned
 * nothing and is gone.
 */

import { deviceOf } from "./free.js";
import { MachineBudget } from "./MachineBudget.js";
import { availableMemoryBytes } from "./machine-memory.js";

/**
 * Build the owner of this machine's room and register everything that takes any.
 *
 * @param {object} params
 * @param {{ root: string, stats: () => { bytes: number } }} params.segmentStore
 * @param {{ held: () => number, allow: (bytes: number) => unknown }} [params.spill] -
 *   The pieces the memory store spills. They live on the torrent thread, so
 *   this is a pair of closures over the channel rather than the pool itself.
 * @param {{ held: () => number, wanted: () => number, allow: (bytes: number) => unknown }} [params.memory] -
 *   The pieces held IN memory, on the torrent thread as well. Told their share
 *   by the same owner that divides the disk, because the two trade: what does
 *   not fit in memory is spilled, so this share decides how much disk is needed.
 * @param {{ held: () => number, allow: (bytes: number) => unknown, root?: string }} [params.wholeFiles] -
 *   Files downloaded whole and kept as files, on the torrent thread as well.
 * @param {import("./Diagnostics.js").Diagnostics} [params.diagnostics] - The
 *   evidence. Built where the collectors are, so one object is both registered
 *   here and consulted by them.
 * @param {string} [params.diagnosticsRoot] - Where the evidence is written,
 *   which on the addon host is a different device from everything else.
 * @param {(directory: string) => Promise<number | null>} params.readFree
 * @param {import("./MachineBudget.js").BudgetPolicy} [params.policy] - What the
 *   operator has said this proxy may take. Absent, the measured default.
 * @param {{ info: Function, warn?: Function }} [params.logger]
 * @returns {{ revise: () => Promise<unknown>, segmentBytes: () => number, diagnostics: object | null, describe: () => string }}
 *   What the segments may hold is asked for rather than pushed: zero until the
 *   first revision, and zero stops growth rather than licensing it.
 */
export function wireMachineBudget({
  segmentStore,
  spill,
  memory,
  encodeInputs,
  indexMemory,
  wholeFiles,
  diagnostics,
  diagnosticsRoot = "",
  readFree,
  policy,
  logger
}) {
  // THE OPERATOR NAMES ONE FIGURE FOR DISK, and disk is one resource per
  // device — so the floor they named is given to every disk resource as it is
  // defined, rather than asking them to name a device they have never heard of.
  const floors = { ...(policy?.floors ?? {}) };
  const diskFloorBytes = Math.max(0, Number(policy?.diskFloorBytes) || 0);
  const effective = { ...(policy ?? {}), floors };
  const budget = new MachineBudget({ policy: effective, logger });
  /**
   * @param {string} name
   * @param {string} directory
   */
  const defineDisk = (name, directory) => {
    if (diskFloorBytes > 0 && !(name in floors)) {
      floors[name] = diskFloorBytes;
    }
    budget.defineResource({ name, readFree: () => readFree(directory) });
  };

  budget.defineResource({ name: "memory", readFree: () => availableMemoryBytes() });
  if (encodeInputs) budget.register({ name: "admitted encode inputs", resource: "memory",
    held: () => encodeInputs.held(), wanted: () => encodeInputs.wanted(), required: () => encodeInputs.required(), allow: bytes => encodeInputs.allow(bytes) });
  if (indexMemory) budget.register({ name: "media metadata", resource: "memory",
    held: () => indexMemory.held(), wanted: () => indexMemory.wanted(), required: () => indexMemory.required(), allow: bytes => indexMemory.allow(bytes) });

  const segmentsOn = deviceOf(segmentStore.root);
  defineDisk(segmentsOn, segmentStore.root);

  let segmentBytes = 0;
  budget.register({
    name: "segments",
    resource: segmentsOn,
    held: () => segmentStore.stats().bytes,
    // The whole of every film anybody is watching. There is no smaller honest
    // answer, so it asks for everything and is cut in proportion like the rest.
    wanted: () => Number.MAX_SAFE_INTEGER,
    allow: (bytes) => {
      segmentBytes = bytes;
    }
  });

  if (typeof memory?.allow === "function") {
    budget.register({
      name: "pieces in memory",
      resource: "memory",
      held: () => memory.held?.() ?? 0,
      wanted: () => memory.wanted?.() ?? 0,
      allow: (bytes) => {
        void memory.allow(bytes);
      }
    });
  }

  if (typeof spill?.allow === "function") {
    // The share travels the channel that already carries everything else, and
    // the reply says what they hold — one exchange, both directions.
    budget.register({
      name: "spilled pieces",
      resource: segmentsOn,
      held: () => spill.held?.() ?? 0,
      wanted: () => Number.MAX_SAFE_INTEGER,
      allow: (bytes) => {
        void spill.allow(bytes);
      }
    });
  }

  if (typeof wholeFiles?.allow === "function") {
    const filesOn = wholeFiles.root ? deviceOf(wholeFiles.root) : segmentsOn;
    defineDisk(filesOn, wholeFiles.root || segmentStore.root);
    budget.register({
      name: "whole files",
      resource: filesOn,
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
    const evidenceOn = diagnosticsRoot ? deviceOf(diagnosticsRoot) : segmentsOn;
    defineDisk(evidenceOn, diagnosticsRoot || segmentStore.root);
    budget.register({
      name: "diagnostics",
      resource: evidenceOn,
      held: () => diagnostics.held(),
      // What it holds plus one more of the largest kind seen — measured, and
      // nothing at all before a fault has happened.
      wanted: () => diagnostics.wanted(),
      allow: (bytes) => diagnostics.allow(bytes)
    });
  }

  return {
    capacityOf: name => budget.capacityOf(name),
    revise: async () => {
      // Re-read the evidence before dividing: it is the one claimant whose
      // bytes are written by something that never reports them.
      await diagnostics?.measure();
      return budget.revise();
    },
    segmentBytes: () => segmentBytes,
    diagnostics: diagnostics ?? null,
    describe: () => budget.describe()
  };
}
