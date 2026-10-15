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
import { SelectionLimit } from "./SelectionLimit.js";
import { futureDownload } from "./FutureDownload.js";
import { urgencyName } from "../demand/index.js";
import { pieceStoreOf } from "../piece-store-of.js";

/** @type {WeakMap<object, { register: DemandRegister, selection: SwarmSelection }>} */
const byTorrent = new WeakMap();
/** @type {Set<{ register: DemandRegister, selection: SwarmSelection }>} */
const live = new Set();
let futurePending = null;
let publishingSelections = false;
/** What the last reconciliation told the swarm to fetch first, for the pool to say. */
let firstClassStated = "none";

/**
 * The last forecast that finished on the maps it was begun on: its result, the
 * demand and withdrawal revisions of each torrent it was worked out on, and
 * whether nothing has changed since; overdue once a missing piece outlived its
 * forecast time.
 *
 * @type {{ result: Map<object, { measuredAt: number, arrivals: Map<number, number | null> }>,
 *   versions: Map<object, { demand: number, withdrawal: number }>, describes: () => boolean, overdue?: boolean } | null}
 */
let latestForecast = null;
/** Who is told that a forecast failed: this layer decides from demand and storage and writes no log of its own. */
let reportForecastFailure = () => {};

/**
 * Say where a failed forecast is reported.
 *
 * @param {(error: unknown) => void} report
 * @returns {void}
 */
export function onForecastFailure(report) {
  reportForecastFailure = report;
}

/**
 * When this torrent's wanted pieces are forecast to be held, as far as the last
 * finished forecast says so for the map it now has; null when that forecast
 * does not describe it.
 *
 * NEVER AWAITED. Awaited afresh on every report, the forecast held a waiting
 * viewer's answer 3-11.6 s on Home Assistant while it took about a quarter of a
 * second of work, the machine 83-94 % busy: the page asks again only once
 * answered, so the hold after a seek to 100 s lasted 52.5 s (r51,
 * torrent-tv/meta#178). A newer forecast is worked out beside the answer,
 * one at a time, whenever the maps, the withdrawals or the held pieces have
 * changed since the last one.
 *
 * ONLY FOR THE MAP IT WAS WORKED OUT ON. The order pieces come in follows the
 * map, so a forecast made before the map changed says nothing of the new one,
 * and neither does one made before a piece was withdrawn: that piece goes back
 * into the queue ahead of others. Such a torrent gets null, and the caller
 * estimates its missing bytes from the measured rate, as before any forecast.
 *
 * AND WHAT IS HELD IS READ NOW, FROM THE STORE. A piece held now is available
 * now whatever was forecast. A piece still missing whose forecast time has
 * passed did not come when forecast — its peer stopped, or it failed
 * verification — and is unknown, not available: read as `max(0, at - now)`,
 * 2.99.11's stale time made a missing piece count as held.
 *
 * @param {object} torrent
 * @param {{ now?: number, findStore?: (torrent: object) => object | null }} [options]
 * @returns {{ measuredAt: number, arrivals: Map<number, number | null> } | null}
 */
export function downloadForecastOf(torrent, { now = Date.now(), findStore = pieceStoreOf } = {}) {
  const entry = byTorrent.get(torrent);
  if (!entry) return null;
  refreshForecast();
  const forecast = latestForecast?.result.get(torrent);
  const version = latestForecast?.versions.get(entry);
  if (!forecast || !version || version.demand !== entry.register.revision ||
      version.withdrawal !== entry.withdrawalRevision) return null;
  const store = findStore(torrent);
  const arrivals = new Map();
  let overdue = false;
  for (const [piece, at] of forecast.arrivals) {
    const held = store?.locationOf ? store.locationOf(piece) !== "missing" : torrent.bitfield?.get(piece) === true;
    if (!held && Number.isFinite(at) && at <= now) overdue = true;
    arrivals.set(piece, held ? now : Number.isFinite(at) && at > now ? at : null);
  }
  // A piece that did not come when forecast is a change no event announces:
  // the next forecast is begun on it, as on one.
  if (overdue) {
    latestForecast.overdue = true;
    refreshForecast();
  }
  return { measuredAt: forecast.measuredAt, arrivals };
}

/**
 * Begin a forecast of every live map unless one is being worked out or the
 * last one still describes them.
 *
 * A failed forecast is said and leaves the last one in place; the next report
 * begins another. Left unhandled, its rejection would end nobody's wait and
 * reach the thread's own handler as an unhandled rejection.
 *
 * @returns {void}
 */
function refreshForecast() {
  if (futurePending || (latestForecast?.describes() && !latestForecast.overdue)) return;
  const entries = [...live];
  const revisions = entries.map(entry => entry.register.revision);
  const withdrawals = entries.map(entry => entry.withdrawalRevision);
  const verified = entries.map(entry => entry.verifiedRevision);
  const isCurrent = () => entries.length === live.size && !entries.some((entry, index) =>
      !live.has(entry) || entry.register.revision !== revisions[index] ||
      entry.withdrawalRevision !== withdrawals[index]);
  // Worked out again once a piece has arrived as well: the pieces queued
  // behind it now come sooner.
  const describes = () => isCurrent() && entries.every((entry, index) => entry.verifiedRevision === verified[index]);
  const versions = new Map(entries.map((entry, index) =>
    [entry, { demand: revisions[index], withdrawal: withdrawals[index] }]));
  futurePending = futureDownload(entries, { isCurrent }).then(result => {
    if (isCurrent()) latestForecast = { result, versions, describes };
  }, error => {
    try { reportForecastFailure(error); } catch { /* a failing report must not end the next forecast */ }
  }).finally(() => { futurePending = null; });
}

/** The forecast being worked out, for checks that wait for it to finish. */
export function forecastSettled() {
  return futurePending ?? Promise.resolve();
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
  const selection = new SwarmSelection({ torrent, register });
  const entry = { torrent, register, selection, limit: new SelectionLimit({ torrent, register, selection }), withdrawalRevision: 0,
    verifiedRevision: 0 };
  byTorrent.set(torrent, entry);
  live.add(entry);
  entry.onBytesChanged = () => { entry.verifiedRevision++; reconcileAll(); };
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

/**
 * Whether this proxy's own selection held the swarm back, as grow-only totals
 * (`SelectionLimit`); null for a torrent nothing has been stated about.
 *
 * @param {object} torrent
 */
export function selectionLimitOf(torrent) {
  return byTorrent.get(torrent)?.limit.totals() ?? null;
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
  // Each torrent's connections looked at under what it has just been told:
  // on every verified piece and on the pool's timer.
  for (const entry of entries) entry.limit.sample();
  // What the swarm is told to fetch FIRST, said when it changes. Lower classes
  // are withheld because a wire with no first-class piece would fall through.
  const said = entries.map(entry => `${String(entry.torrent.infoHash ?? "").slice(0, 8)}: ` +
    `${(entry.selection.firstClassPieces ?? []).slice(0, 8).join(",") || "nothing"}` +
    `${(entry.selection.firstClassPieces?.length ?? 0) > 8 ? ` +${entry.selection.firstClassPieces.length - 8} more` : ""}`).join("; ");
  const head = firstClass ? `${urgencyName(firstClass.urgency)} priority ${firstClass.priority}` : "none";
  firstClassStated = `${head} — pieces ${said}`;
  return { torrents: entries.length, speculativeAllowed, stated, withdrawn };
}
