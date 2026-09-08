/**
 * @file How well the priority map is being served, measured where somebody waits.
 *
 * The map says what matters most. Nothing said whether what mattered most was
 * actually delivered first — so "is the prioritisation any good" had no answer
 * of any kind, for either of the two things that read the map.
 *
 * The measure is the same for both, and it is a wait recorded against the rank
 * the map gave the thing waited for AT THE MOMENT it was asked for. Read that
 * way it says which part is wrong rather than whether the whole scheme is:
 *
 * - long waits at the TOP rank mean the urgent zone is not being served first,
 *   which is a fault in whoever acts on the map;
 * - long waits further down with none at the top mean the zones are the wrong
 *   width — the urgent one too narrow, so the viewer reaches material that was
 *   only ever ranked "soon";
 * - a rank with no waits at all is not a good sign or a bad one, it is silence,
 *   and it is reported as such rather than as a zero.
 *
 * There is nothing in here about encoders, torrents, sessions or viewers: it is
 * given a rank and a number of milliseconds.
 */

/** How many waits to keep per rank. A median wants a sample, not a history. */
const HISTORY = 200;

/**
 * Ranks are collapsed into bands before they are counted.
 *
 * The map's ranks are as many as the film needs — 100 down to 1 on a long file
 * — and a table with a hundred rows says nothing a reader can hold. What is
 * being asked is coarse: was the thing waited for what the viewer needs NOW,
 * what they reach shortly, or the rest of the film. So the top rank is its own
 * band, the next few are the second, and everything below is the third.
 *
 * @param {number} rank
 * @param {number} topRank - The highest rank the map currently states.
 * @returns {"now" | "soon" | "later"}
 */
export function bandOf(rank, topRank) {
  if (!Number.isFinite(rank) || rank <= 0) {
    return "later";
  }
  const top = Number.isFinite(topRank) && topRank > 0 ? topRank : rank;
  if (rank >= top) {
    return "now";
  }
  // Within a tenth of the top: what a viewer reaches while watching what they
  // hold. A tenth is the map's own shape — its zones widen geometrically — and
  // not a threshold chosen for this table.
  return rank >= top - Math.max(1, Math.round(top / 10)) ? "soon" : "later";
}

export class WaitLedger {
  /** @type {Map<string, Map<string, number[]>>} */
  #waits = new Map();

  /** @type {Map<string, Map<string, number>>} */
  #counts = new Map();

  /**
   * Somebody waited this long for something the map ranked this highly.
   *
   * @param {string} key - What the waits belong to: an output, or a file.
   * @param {number} waitedMs
   * @param {number} rank - The map's rank for the thing waited for.
   * @param {number} topRank - The highest rank the map states, so the rank can
   *   be read as a position rather than as an absolute number.
   */
  note(key, waitedMs, rank, topRank) {
    if (!key || !Number.isFinite(waitedMs) || waitedMs < 0) {
      return;
    }
    const band = bandOf(rank, topRank);
    let byBand = this.#waits.get(key);
    if (!byBand) {
      byBand = new Map();
      this.#waits.set(key, byBand);
    }
    const held = byBand.get(band) ?? [];
    held.push(waitedMs);
    while (held.length > HISTORY) {
      held.shift();
    }
    byBand.set(band, held);

    let counts = this.#counts.get(key);
    if (!counts) {
      counts = new Map();
      this.#counts.set(key, counts);
    }
    counts.set(band, (counts.get(band) ?? 0) + 1);
  }

  /**
   * What the waits say, in one line, or null while nothing has waited.
   *
   * The count is the whole run and the median and worst are the recent sample,
   * because those answer different questions: how often, and how badly.
   *
   * @param {string} key
   * @returns {string | null}
   */
  describe(key) {
    const byBand = this.#waits.get(key);
    if (!byBand || byBand.size === 0) {
      return null;
    }
    const counts = this.#counts.get(key) ?? new Map();
    const parts = [];
    for (const band of ["now", "soon", "later"]) {
      const held = byBand.get(band);
      if (!held || held.length === 0) {
        // Said out loud, because an absent band and a band that never waited
        // are the same silence and neither is a zero.
        parts.push(`${band} none`);
        continue;
      }
      const sorted = [...held].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      parts.push(
        `${band} ${counts.get(band) ?? held.length} wait(s) median ${Math.round(median)}ms ` +
        `worst ${Math.round(sorted[sorted.length - 1])}ms`
      );
    }
    return parts.join(", ");
  }

  /**
   * @param {string} key
   */
  forget(key) {
    this.#waits.delete(key);
    this.#counts.delete(key);
  }
}

/**
 * One ledger for the process, because the question is asked in two layers and
 * the answer is comparable only if the scale is the same.
 */
export const waits = new WaitLedger();
