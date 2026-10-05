import { createHash } from "node:crypto";
import { ENCODE_EXIT } from "./encode-exit.js";

/** Process and resource failures are not evidence against the admitted bytes. */
export function failedAdmittedInput(ended, hardwareEncode = false) {
  if (hardwareEncode || ended.signal || ended.code === null || ended.code === undefined) return false;
  if (!Number.isInteger(ended.code) || ended.code < 0) return false;
  if (/cannot allocate memory|out of memory|no space left|resource temporarily unavailable|too many open files|ENOMEM|ENOSPC|EMFILE|EAGAIN/i.test(ended.because ?? "")) return false;
  return ended.ending === ENCODE_EXIT.SHORT || ended.ending === ENCODE_EXIT.FAILED;
}

/** A failed input is retried only after its bytes or output parameters change. */
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

  reason(address) { return this.#failures.get(address)?.values().next().value?.reason ?? null; }

  note(address, index, key, reason) {
    const entries = this.#failures.get(address) ?? new Map();
    entries.set(index, { key, reason });
    this.#failures.set(address, entries);
  }

  forget(address) { this.#failures.delete(address); }
}
