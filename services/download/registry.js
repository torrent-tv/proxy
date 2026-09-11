/**
 * @file One demand register and one swarm selection per torrent, found from the
 * torrent itself.
 *
 * The same shape the piece store already uses — `findSharedStore(torrent)`
 * reaches the store without it being threaded through every call — and for the
 * same reason: the reader, the pool and the background fill all need the same
 * instance, and passing it through six layers of arguments would make the
 * plumbing bigger than the thing.
 *
 * Kept in a live set as well as a weak map, because one question cannot be
 * answered per torrent: whether ANYTHING anywhere is still missing something
 * urgent. The link and the machine are shared between torrents, so a viewer
 * starving on one film must stop the speculative fetching on the other. Asked
 * per torrent, that question has the wrong answer.
 */

import { DemandRegister } from "../demand/DemandRegister.js";
import { SwarmSelection } from "./SwarmSelection.js";

/** @type {WeakMap<object, { register: DemandRegister, selection: SwarmSelection }>} */
const byTorrent = new WeakMap();
/** @type {Set<{ register: DemandRegister, selection: SwarmSelection }>} */
const live = new Set();

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
  const entry = { register, selection: new SwarmSelection({ torrent, register }) };
  byTorrent.set(torrent, entry);
  live.add(entry);
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
  byTorrent.delete(torrent);
  live.delete(held);
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
  const entries = [...live];
  const speculativeAllowed = !entries.some((entry) => entry.selection.hasUrgentMissing());
  let stated = 0;
  let withdrawn = 0;
  for (const entry of entries) {
    const result = entry.selection.reconcile({ speculativeAllowed });
    stated += result.stated;
    withdrawn += result.withdrawn;
  }
  return { torrents: entries.length, speculativeAllowed, stated, withdrawn };
}
