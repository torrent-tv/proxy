/**
 * @file One run of a piece of work per key at a time, and one more after it
 * whenever it was asked for meanwhile.
 *
 * For work that is asked for by events — pieces arriving — and that reads
 * whatever is there when it runs. A request that arrives while a run is going
 * is neither queued nor dropped: it is remembered as "run again", once,
 * because one more run reads everything that arrived during the first. Dropping
 * it lost exactly the run that would have found the last pieces of a file
 * (`research/subtitles-never-appear-2026-10-01.md`).
 */

/**
 * @template {unknown[]} A
 * @param {(...args: A) => Promise<void>} work
 * @returns {(key: string, ...args: A) => Promise<void>}
 */
export function coalescing(work) {
  /** @type {Set<string>} */
  const running = new Set();
  /** The latest arguments a run was asked for with meanwhile. @type {Map<string, A>} */
  const askedAgain = new Map();
  const run = async (key, ...args) => {
    if (running.has(key)) {
      askedAgain.set(key, args);
      return;
    }
    running.add(key);
    try {
      await work(...args);
    } finally {
      running.delete(key);
      const again = askedAgain.get(key);
      if (again) {
        askedAgain.delete(key);
        void run(key, ...again);
      }
    }
  };
  return run;
}
