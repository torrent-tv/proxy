import { createHash } from "node:crypto";
import { ENCODE_EXIT } from "./encode-exit.js";

/** Process and resource failures are not evidence against the admitted bytes. */
export function failedAdmittedInput(ended, hardwareEncode = false) {
  if (ended.ending === ENCODE_EXIT.PUBLICATION_FAILED) {
    return !hardwareEncode && ended.publicationCode === "ERR_INCOMPLETE_MEDIA";
  }
  if (hardwareEncode || ended.signal || ended.code === null || ended.code === undefined) return false;
  if (!Number.isInteger(ended.code) || ended.code < 0) return false;
  if (/cannot allocate memory|out of memory|no space left|resource temporarily unavailable|too many open files|ENOMEM|ENOSPC|EMFILE|EAGAIN/i.test(ended.because ?? "")) return false;
  return ended.ending === ENCODE_EXIT.SHORT || ended.ending === ENCODE_EXIT.FAILED;
}

/**
 * A failed input is retried only after its identity — source, file, ranges and
 * what is stated about them — or the output parameters change.
 *
 * A failure of an input that held more pieces than the one that failed is not
 * the end of the output: the piece is made again from an input holding it
 * alone, which is another input (`retryAlone`). Only the failure of that input
 * — or of any input holding one piece — ends production. Field 2026-10-11,
 * torrent-tv/meta#178: one refused piece of a six-piece copy ended the viewer's
 * playback with a 500 while the same piece made alone was published in an
 * earlier session.
 */
export class InputFailures {
  #failures = new Map();

  key(input, parameters) {
    return createHash("sha256").update(input.fingerprint).update(JSON.stringify(parameters)).digest("hex");
  }

  failure(address, index, key) {
    const entries = this.#failures.get(address);
    const entry = entries?.get(index);
    if (entry?.key === key) return entry.reason;
    if (entry) entries.delete(index);
    return null;
  }

  /** Why production of this output has ended, or null while every failed piece can still be made alone. */
  reason(address) {
    for (const entry of this.#failures.get(address)?.values() ?? []) if (!entry.retryAlone) return entry.reason;
    return null;
  }

  /** Whether a failed piece of this output waits to be made from an input holding it alone. */
  retrying(address) {
    for (const entry of this.#failures.get(address)?.values() ?? []) if (entry.retryAlone) return true;
    return false;
  }

  /**
   * The last number a run starting at `from` may reach so that a piece waiting
   * to be made alone is not taken again inside a longer input: the number
   * before it, or `from` itself when the run starts there.
   *
   * @param {string} address
   * @param {number} from
   * @param {number} to
   * @returns {number}
   */
  boundFor(address, from, to) {
    let bound = to;
    for (const [index, entry] of this.#failures.get(address) ?? []) {
      if (!entry.retryAlone || index < from || index > bound) continue;
      bound = index === from ? from : index - 1;
    }
    return bound;
  }

  /**
   * @param {string} address
   * @param {number} index - The piece that failed.
   * @param {string} key
   * @param {string} reason
   * @param {{ pieces?: number }} [held] - How many pieces the failed input held.
   */
  note(address, index, key, reason, { pieces = 1 } = {}) {
    const entries = this.#failures.get(address) ?? new Map();
    entries.set(index, { key, reason, retryAlone: pieces > 1 });
    this.#failures.set(address, entries);
  }

  forget(address) { this.#failures.delete(address); }
}
