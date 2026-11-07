/**
 * @file How a check waits. `until` waits for an event it proves DID happen;
 * `settle` lets everything already queued run before a check looks for
 * something that did NOT happen. A check never sleeps a fixed time and hopes.
 */

const POLL_MS = 5;

/**
 * Asks `check` until it answers true (it may answer with a promise).
 *
 * @param {() => boolean | Promise<boolean>} check
 * @param {string} what - named in the error when the limit passes
 * @param {{ limitMs?: number }} [options]
 * @returns {Promise<void>}
 */
export async function until(check, what, { limitMs = 5_000 } = {}) {
  const deadline = Date.now() + limitMs;
  while (!(await check())) {
    if (Date.now() >= deadline) {
      throw new Error(`gave up after ${limitMs} ms waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/**
 * Lets queued microtasks and immediates run, `turns` times over.
 *
 * @param {number} [turns]
 * @returns {Promise<void>}
 */
export async function settle(turns = 1) {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
