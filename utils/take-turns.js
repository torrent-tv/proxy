/**
 * Long work on one thread, shared with the rest of that thread in equal turns.
 *
 * The returned function is called between steps of the work. It hands the
 * thread back once the work has run, since it last did, as long as the rest
 * of the thread took in its own turn then: the work takes at most about twice
 * its own time, and nothing else waits longer than it took itself. Handed back
 * after every step, the download map's first pass over a two-hour AVI took
 * 14.7-22 s of wall time for about 4 s of its own work, and the start forecast,
 * which needs the whole pass, could not answer meanwhile; held in one stretch
 * it held the thread for that work (Home Assistant 2026-10-12,
 * torrent-tv/meta#178).
 *
 * @param {{ now?: () => number, nextTurn?: () => Promise<void> }} [options]
 * @returns {() => Promise<boolean>} Resolves true when the thread was handed back.
 */
export function takeTurns({ now = () => performance.now(), nextTurn = () => new Promise(resolve => setImmediate(resolve)) } = {}) {
  let workingSince = now();
  let othersTook = 0;
  return async () => {
    if (now() - workingSince < othersTook) return false;
    const handedBackAt = now();
    await nextTurn();
    workingSince = now();
    othersTook = workingSince - handedBackAt;
    return true;
  };
}
