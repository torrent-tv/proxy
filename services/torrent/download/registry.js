/**
 * @file One demand register and one swarm selection per torrent, found from the
 * torrent itself.
 *
 * The same shape the piece store already uses — `pieceStoreOf(torrent)`
 * reaches the store without it being threaded through every call — and for the
 * same reason: the reader, the pool and the background fill all need the same
 * instance, and passing it through six layers of arguments would make the
 * argument lists bigger than the thing they carry.
 *
 * Kept in a live set as well as a weak map, because one question cannot be
 * answered per torrent: whether ANYTHING anywhere is still missing something
 * urgent. The link and the machine are shared between torrents, so a viewer
 * starving on one film must stop the speculative fetching on the other. Asked
 * per torrent, that question has the wrong answer.
 */

import { DemandRegister } from "../demand/DemandRegister.js";
import { SwarmSelection } from "./SwarmSelection.js";
import { futureDownload } from "./FutureDownload.js";
import { urgencyName } from "../demand/index.js";

/** @type {WeakMap<object, { register: DemandRegister, selection: SwarmSelection }>} */
const byTorrent = new WeakMap();
/** @type {Set<{ register: DemandRegister, selection: SwarmSelection }>} */
const live = new Set();
let futurePending = null;
let publishingSelections = false;
/** What the last reconciliation told the swarm to fetch first, for the pool to say. */
let firstClassStated = "none";

/** Concurrent file reports share one snapshot of every live download map. */
export function forecastDownloads() {
  if (!futurePending) {
    const entries = [...live];
    const revisions = entries.map(entry => entry.register.revision);
    const withdrawals = entries.map(entry => entry.withdrawalRevision);
    const isCurrent = () => entries.length === live.size && !entries.some((entry, index) =>
        !live.has(entry) || entry.register.revision !== revisions[index] ||
        entry.withdrawalRevision !== withdrawals[index]);
    futurePending = futureDownload(entries, { isCurrent }).then(result =>
      isCurrent() ? result : new Map()).finally(() => { futurePending = null; });
  }
  return futurePending;
}

/**
 * The register and selection for a torrent, made on first use.
 *
 * @param {object} torrent
 * @returns {{ register: DemandRegister, selection: SwarmSelection }}
 */
export function demandFor(torrent) {
  const held = byTorrent.get(torrent);
  if (held) {
    return held;
  }
  const register = new DemandRegister();
  const entry = { torrent, register, selection: new SwarmSelection({ torrent, register }), withdrawalRevision: 0 };
  byTorrent.set(torrent, entry);
  live.add(entry);
  entry.onBytesChanged = () => reconcileAll();
  entry.onWithdrawn = () => { entry.withdrawalRevision++; reconcileAll(); };
  torrent.on?.("verified", entry.onBytesChanged);
  torrent.on?.("piece-withdrawn", entry.onWithdrawn);
  return entry;
}

/**
 * Whether this torrent is still short of anything anybody asked for.
 *
 * Read by the upload policy: while a reader is missing bytes, a little upload
 * buys the reciprocity that gets them; once nothing declared is missing it buys
 * nothing at all, and on 2026-09-11 the proxy went on offering 512 KB/s of a
 * fully downloaded file to 596 peers for forty-eight minutes, reading a 4 MB
 * piece off the disk for every 16 KB it sent.
 *
 * False for a torrent nothing has been stated about, which is the same answer
 * and the right one: nobody is waiting for it.
 *
 * @param {object} torrent
 * @returns {boolean}
 */
export function hasUnmetDemand(torrent) {
  const held = byTorrent.get(torrent);
  return held ? held.selection.hasUrgentMissing() : false;
}

/**
 * Give up everything stated for a torrent that is going.
 *
 * @param {object} torrent
 * @returns {void}
 */
export function forgetTorrent(torrent) {
  const held = byTorrent.get(torrent);
  if (!held) {
    return;
  }
  held.selection.releaseAll();
  held.register.clear();
  torrent.removeListener?.("verified", held.onBytesChanged);
  torrent.removeListener?.("piece-withdrawn", held.onWithdrawn);
  byTorrent.delete(torrent);
  live.delete(held);
}

/** What the swarm was last told to fetch first: the level, its priority and the pieces per torrent. */
export function firstClassStatement() {
  return firstClassStated;
}

/**
 * Bring every torrent's download set into line with what is stated.
 *
 * The cross-torrent rule lives here and not in a selection, because it is not a
 * per-torrent question: two films on one proxy share the link, so filling the
 * tail of one while a viewer of the other has a still picture spends the same
 * bandwidth twice over. The answer is worked out once and given to all.
 *
 * @returns {{ torrents: number, speculativeAllowed: boolean, stated: number, withdrawn: number }}
 */
export function reconcileAll() {
  if (publishingSelections) return { torrents: live.size, speculativeAllowed: false, stated: 0, withdrawn: 0 };
  const entries = [...live];
  const speculativeAllowed = !entries.some((entry) => entry.selection.hasUrgentMissing());
  // The first class across every torrent: the most urgent missing level and
  // its highest priority. Lower classes stay out of every torrent's selection.
  const bands = entries.map(entry => entry.selection.missingBand()).filter(Boolean);
  const urgency = bands.length ? Math.min(...bands.map(band => band.urgency)) : null;
  const firstClass = urgency === null ? null
    : { urgency, priority: Math.max(...bands.filter(band => band.urgency === urgency).map(band => band.priority)) };
  let stated = 0;
  let withdrawn = 0;
  publishingSelections = true;
  try {
    for (const entry of entries) {
      const result = entry.selection.reconcile({ speculativeAllowed, firstClass });
      stated += result.stated;
      withdrawn += result.withdrawn;
    }
  } finally {
    publishingSelections = false;
  }
  // What the swarm is told to fetch FIRST, said when it changes. Lower classes
  // are withheld because a wire with no first-class piece would fall through.
  const said = entries.map(entry => `${String(entry.torrent.infoHash ?? "").slice(0, 8)}: ` +
    `${(entry.selection.firstClassPieces ?? []).slice(0, 8).join(",") || "nothing"}` +
    `${(entry.selection.firstClassPieces?.length ?? 0) > 8 ? ` +${entry.selection.firstClassPieces.length - 8} more` : ""}`).join("; ");
  const head = firstClass ? `${urgencyName(firstClass.urgency)} priority ${firstClass.priority}` : "none";
  firstClassStated = `${head} — pieces ${said}`;
  return { torrents: entries.length, speculativeAllowed, stated, withdrawn };
}
