/**
 * @file Torrents this process has destroyed and the collector has not taken
 * back yet.
 *
 * Destroying a torrent ends its swarm; it frees nothing while anything still
 * refers to the object. On 2026-10-04 a torrent worker held 595 destroyed
 * copies of one film, kept by the listeners of uTP connections whose close
 * never came back and by idle timers left running for an hour, and the only
 * sign of it was memory growing at 17 MB a minute. The heap snapshot that named
 * it was taken by luck. This says it every time the worker reports memory.
 *
 * The count is the collector's own answer, so it lags: a figure that returns
 * towards zero is ordinary, one that only grows is a reference that was not let
 * go.
 */

let destroyedTotal = 0;
let notCollected = 0;

/** @type {WeakSet<object>} */
const counted = new WeakSet();

const collected = new FinalizationRegistry(() => {
  notCollected -= 1;
});

/**
 * Say that a torrent has been destroyed. Counted once however often it is said.
 *
 * @param {object} torrent
 * @returns {void}
 */
export function noteTorrentDestroyed(torrent) {
  if (!torrent || typeof torrent !== "object" || counted.has(torrent)) {
    return;
  }
  counted.add(torrent);
  destroyedTotal += 1;
  notCollected += 1;
  collected.register(torrent, null);
}

/**
 * @returns {{ total: number, notCollected: number }}
 */
export function destroyedTorrents() {
  return { total: destroyedTotal, notCollected };
}
