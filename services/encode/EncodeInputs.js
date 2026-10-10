import { admitInput } from "./AdmittedInput.js";
import { admitOriginalInput, originalInputBytes } from "./OriginalInput.js";

/**
 * How many recent readings a learned figure here is taken from: long enough
 * that one reading does not move the answer, short enough that the answer
 * still follows the host. The same count as `run-costs.js`.
 */
const RECENT_READINGS = 20;

/** @param {number[]} values @returns {number | null} */
function middleOf(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/** @param {number[]} readings @param {number} value */
function keep(readings, value) {
  readings.push(value);
  while (readings.length > RECENT_READINGS) readings.shift();
}

/** Event-driven preparation; a synchronous run request can take only ready input. */
export class EncodeInputs {
  #requests = new Map();
  #revision = 0;
  #memoryRevision = 0;
  #held = 0;
  #allowed = 0;
  /** What each preparing request asks of memory: all it would use, and the least it can run with. */
  #wanted = new Map();
  /** Bytes per millisecond of recent original-input copies, read where the copy is made. */
  #copyRates = [];
  /** Seconds an encoder took to open its original input, per output. */
  #opens = new Map();
  #resolve;
  #read;
  #heldRanges;
  #revise;
  #changed;
  #failed;
  #capacity;
  #urgent;
  #log;
  #now;

  constructor({ resolve, readRanges, heldRanges = null, reviseBudget, changed, failed, capacity = () => null, urgent = () => true, log = () => {}, now = Date.now }) {
    this.#resolve = resolve;
    this.#read = readRanges;
    this.#heldRanges = heldRanges;
    this.#revise = reviseBudget;
    this.#changed = changed;
    this.#failed = failed;
    this.#capacity = capacity;
    this.#urgent = urgent;
    this.#log = log;
    this.#now = now;
  }

  /**
   * One line when a request's state changes, so a wait that never ends names
   * what it waits for. `detail` is said with it and does not count as a change.
   */
  #note(request, state, detail = "") {
    if (request.noted === state) return;
    request.noted = state;
    this.#log(`encode input #${request.from}..#${request.to} of ${request.output.outputKey ?? request.output.id}: ${state}` +
      ` (held ${this.#held} of ${this.#allowed} allowed)${detail}`);
  }

  /** The container's statement of an interval, its time added to the request's account. */
  async #resolveTimed(timing, output, from, to) {
    const startedAt = this.#now();
    try {
      return await this.#resolve(output, from, to, timing);
    } finally {
      timing.resolutions += 1;
      timing.resolveMs += this.#now() - startedAt;
    }
  }

  /** `work`'s time added to one field of the request's account. */
  async #spent(timing, field, work) {
    const startedAt = this.#now();
    try {
      return await work();
    } finally {
      timing[field] += this.#now() - startedAt;
    }
  }

  held() { return this.#held; }
  wanted() { return this.#held + [...this.#wanted.values()].reduce((sum, asked) => sum + asked.wanted, 0); }
  required() {
    let bytes = this.#held;
    for (const [key, asked] of this.#wanted) {
      // The encode plan already chose this finite input. Its least runnable
      // part must fit before production can advance, even when playback has
      // not reached it yet. Sharing against speculative whole-file demand can
      // otherwise deny it forever, so urgency must not decide that minimum
      // again. What a stretch asks beyond it is shared like any other want.
      if (this.#requests.has(key)) bytes += asked.required;
    }
    return bytes;
  }
  allow(bytes) {
    const changed = this.#allowed !== Math.max(0, bytes);
    this.#allowed = Math.max(0, bytes);
    if (changed) this.memoryChanged();
  }

  /** Metadata admission and input admission can change independently. */
  memoryChanged() {
    this.#memoryRevision++;
    this.#retryMemory();
  }

  #retryMemory() {
    for (const request of this.#requests.values()) {
      if (!request.pending && request.result?.kind === "needs-memory") this.#prepare(request);
    }
  }

  failureOf(output) {
    for (const request of this.#requests.values()) {
      if (request.output === output && request.result?.kind === "terminal") return request.result;
    }
    return null;
  }

  retain(output, windows) {
    for (const [key, request] of this.#requests) {
      if (request.output !== output || windows.some(window => request.from <= window.to && request.to >= window.from)) continue;
      this.#note(request, "withdrawn: no wanted window covers it");
      this.#requests.delete(key);
      this.#wanted.delete(key);
      request.result?.release?.();
    }
    this.#retryMemory();
  }

  /**
   * The input of a run starting at `from`, once it is prepared.
   *
   * `to` is the last number the run may reach. A packet input is prepared for
   * `from` alone; an original input for the longest stretch from `from` that
   * is present, fits memory and copies no longer than an open of that input.
   * The answer carries the stretch it holds as `from` and `to`.
   */
  take(output, from, to) {
    const key = keyOf(output, from);
    let existing = this.#requests.get(key);
    if (existing && existing.to !== to) {
      // The plan's bound for this start moved. A copy already made beyond it
      // would be a run over somebody else's stretch, so it is given back; one
      // being made is checked when it is done, and one waiting for bytes or
      // memory takes the new bound when its own event prepares it again.
      existing.to = to;
      if (existing.result?.kind === "result" && existing.result.to > to) {
        this.#requests.delete(key);
        this.#wanted.delete(key);
        existing.result.release();
        existing = undefined;
      }
    }
    if (existing?.result?.kind === "result") {
      this.#requests.delete(key);
      return existing.result;
    }
    if (existing?.pending || existing?.revision === this.#revision || existing?.result?.kind === "terminal") return null;
    const request = existing ?? { output, from, to, key };
    this.#requests.set(key, request);
    this.#prepare(request);
    return null;
  }

  async acquire(output, from, to) {
    const key = keyOf(output, from);
    const ready = this.take(output, from, to);
    if (ready) return ready;
    await this.#requests.get(key)?.promise;
    const request = this.#requests.get(key);
    if (request?.result?.kind !== "result") return null;
    return this.take(output, from, to);
  }

  bytesChanged() {
    this.#revision++;
    for (const request of this.#requests.values()) {
      if (!request.pending && request.result?.kind !== "result" && request.result?.kind !== "terminal") this.#prepare(request);
    }
  }

  forget(output) {
    for (const [key, request] of this.#requests) {
      if (request.output !== output) continue;
      this.#requests.delete(key);
      this.#wanted.delete(key);
      request.result?.release?.();
    }
    this.#opens.delete(addressOf(output));
  }

  /**
   * How long an encoder took to open this output's original input: from its
   * spawn to the name of its first closed piece, less what encoding that piece
   * costs. Measured by whoever ran it, kept here where a stretch is sized.
   *
   * @param {object} output
   * @param {number} seconds
   */
  noteOpen(output, seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    const readings = this.#opens.get(addressOf(output)) ?? [];
    keep(readings, seconds);
    this.#opens.set(addressOf(output), readings);
  }

  /**
   * How many bytes a stretch may hold so that copying it takes no longer than
   * opening the input it replaces: the recent copy rate times this output's
   * recent open. Beyond it the open's share of each piece falls below the
   * copy's, which is the same for every piece; a longer stretch buys less and
   * delays the run's start more. Null until both have been measured, and the
   * run then gets one piece, as it did before either reading existed.
   *
   * @param {object} output
   * @returns {number | null}
   */
  stretchBytesFor(output) {
    const rate = middleOf(this.#copyRates);
    const open = middleOf(this.#opens.get(addressOf(output)) ?? []);
    return rate === null || open === null ? null : Math.floor(rate * open * 1000);
  }

  #prepare(request) {
    request.pending = true;
    request.stale = false;
    request.revision = this.#revision;
    request.memoryRevision = this.#memoryRevision;
    // Where the time from the request to its input goes, across every attempt:
    // field 2026-10-10, a picture's request took 38 s before its copy began and
    // nothing said on what (torrent-tv/meta#166).
    request.timing ??= { askedAt: this.#now(), attempts: 0, resolutions: 0, resolveMs: 0,
      reads: 0, queuedMs: 0, readMs: 0, heldMs: 0, budgetMs: 0 };
    request.timing.attempts += 1;
    request.promise = (async () => {
      const resolved = await this.#resolveTimed(request.timing, request.output, request.from, request.from);
      if (this.#requests.get(request.key) !== request) return;
      let result;
      if (resolved.kind !== "result") {
        result = resolved;
      } else if (resolved.sources?.every(source => source.input.original === true)) {
        result = await this.#admitStretch(request, resolved.sources);
        if (!result) return;
      } else {
        result = await admitInput({ sources: resolved.sources, readRanges: this.#read, reserve: this.#reserveFor(request) });
        if (result.kind === "result") Object.assign(result, { from: request.from, to: request.from });
      }
      if (this.#requests.get(request.key) !== request) { result.release?.(); return; }
      if (result.kind === "result" && result.to > request.to) {
        // The plan narrowed this start while the copy was being made.
        result.release();
        request.result = null;
        request.stale = true;
        return;
      }
      request.result = result;
      this.#note(request, result.kind === "result" ? `ready #${result.from}..#${result.to}, ${result.bytes ?? "?"} bytes` +
        (Number.isFinite(result.copyMs) ? `, copied in ${result.copyMs}ms` : "")
        : `${result.kind}${result.reason ? ` ${result.reason}` : ""}${Number.isFinite(result.bytes) ? ` ${result.bytes} bytes` : ""}`,
      describeTiming(request.timing, this.#now()));
      if (result.kind === "result" || result.kind === "terminal") this.#changed(request.output, result);
    })().catch(error => {
      if (this.#requests.get(request.key) === request) {
        request.result = { kind: "terminal", reason: "input-preparation-failed", message: error.message };
        this.#failed(request.output, error);
      }
    }).finally(() => {
      request.pending = false;
      if (request.result?.kind !== "needs-memory") this.#wanted.delete(request.key);
      const changed = request.stale || (request.result?.kind === "needs-memory"
        ? request.memoryRevision !== this.#memoryRevision : request.revision !== this.#revision);
      if (this.#requests.get(request.key) === request && changed &&
        request.result?.kind !== "result" && request.result?.kind !== "terminal") this.#prepare(request);
    });
  }

  /** The reservation a packet input makes: all of it, or nothing. */
  #reserveFor(request) {
    return async bytes => {
      this.#wanted.set(request.key, { wanted: bytes, required: bytes });
      await this.#spent(request.timing, "budgetMs", () => this.#revise());
      const capacity = this.#capacity();
      if (capacity !== null && bytes > capacity && this.#urgent(request.output, request.from)) return {
        kind: "terminal", reason: "source-input-exceeds-memory-capacity", bytes, capacity
      };
      return this.#hold(request, bytes);
    };
  }

  /** Take `bytes` of the allowance for this request now, or answer null. */
  #hold(request, bytes) {
    if (this.#requests.get(request.key) !== request || this.#allowed - this.#held < bytes) return null;
    this.#wanted.delete(request.key);
    this.#held += bytes;
    let released = false;
    return () => {
      if (!released) {
        released = true; this.#held -= bytes;
        queueMicrotask(() => this.memoryChanged());
      }
    };
  }

  /**
   * Choose and copy one finite stretch of an original input, starting at the
   * request's `from` and ending at the largest `e <= to` such that every byte
   * of `from … e` is present now, the stretch copies no longer than an open,
   * and it fits the memory the budget allows. One piece is the least it runs
   * with; only that least is required of the budget, and only that least being
   * larger than the policy's whole capacity is terminal.
   *
   * @returns {Promise<object | undefined>} Undefined when the request was withdrawn.
   */
  async #admitStretch(request, firstSources) {
    const { output, from } = request;
    const minimum = originalInputBytes(firstSources);
    const stretches = new Map([[from, { sources: firstSources, bytes: minimum }]]);
    const held = new Map();
    const at = async end => {
      if (!stretches.has(end)) {
        // A longer stretch that cannot be stated is not one to copy; the
        // shorter one already stated still runs.
        const resolved = await this.#resolveTimed(request.timing, output, from, end).catch(() => null);
        stretches.set(end, resolved?.kind === "result" && resolved.sources?.every(source => source.input.original === true)
          ? { sources: resolved.sources, bytes: originalInputBytes(resolved.sources) } : null);
      }
      return stretches.get(end);
    };
    const fits = async (end, maxBytes) => {
      const stretch = await at(end);
      return Boolean(stretch) && stretch.bytes <= maxBytes && await this.#present(stretch.sources, held, request.timing);
    };
    // Grows by doubling and then halves back: a handful of resolutions find
    // the end whether it is a piece away or the rest of the film.
    const longest = async maxBytes => {
      let good = from, bad = null, step = 1;
      while (bad === null) {
        const end = good + step;
        if (end > request.to) bad = request.to + 1;
        else if (await fits(end, maxBytes)) { good = end; step *= 2; }
        else bad = end;
      }
      while (bad - good > 1) {
        const middle = Math.floor((good + bad) / 2);
        if (await fits(middle, maxBytes)) good = middle; else bad = middle;
      }
      return good;
    };
    const target = this.stretchBytesFor(output);
    let end = target === null || this.#heldRanges === null ? from : await longest(target);
    if (this.#requests.get(request.key) !== request) return undefined;
    this.#wanted.set(request.key, { wanted: stretches.get(end).bytes, required: minimum });
    await this.#spent(request.timing, "budgetMs", () => this.#revise());
    if (this.#requests.get(request.key) !== request) return undefined;
    const capacity = this.#capacity();
    if (capacity !== null && minimum > capacity && this.#urgent(output, from)) {
      return { kind: "terminal", reason: "source-input-exceeds-memory-capacity", bytes: minimum, capacity };
    }
    const roomNow = () => Math.min(capacity ?? Number.POSITIVE_INFINITY, this.#allowed - this.#held);
    let room = roomNow();
    let result;
    for (;;) {
      if (minimum > room) {
        // Wait for memory with the least it can run with, not the larger stretch.
        this.#wanted.set(request.key, { wanted: minimum, required: minimum });
        return { kind: "needs-memory", bytes: minimum };
      }
      if (stretches.get(end).bytes > room) {
        end = await longest(Math.min(target ?? minimum, room));
        if (this.#requests.get(request.key) !== request) return undefined;
      }
      const chosen = stretches.get(end);
      this.#wanted.set(request.key, { wanted: chosen.bytes, required: chosen.bytes });
      result = await admitOriginalInput({ sources: chosen.sources, readRanges: this.#read, now: this.#now,
        reserve: async bytes => this.#hold(request, bytes) });
      // Another output's copy can take the room this one was sized for while
      // it was being chosen. A shorter stretch is tried at once rather than
      // waiting for a memory change that may never come.
      if (result.kind !== "needs-memory" || this.#requests.get(request.key) !== request || roomNow() >= room) break;
      room = roomNow();
    }
    if (result.kind === "needs-memory") this.#wanted.set(request.key, { wanted: minimum, required: minimum });
    if (result.kind === "result") {
      Object.assign(result, { from, to: end });
      if (result.copyMs > 0) keep(this.#copyRates, result.bytes / result.copyMs);
    }
    return result;
  }

  /** Whether every range of these sources is downloaded whole now. */
  async #present(sources, held, timing) {
    for (const source of sources) {
      const name = `${source.sourceKey}:${source.fileIndex}`;
      if (!held.has(name)) held.set(name, await this.#spent(timing, "heldMs", () => Promise.resolve().then(() => this.#heldRanges(source)).catch(() => null)) ?? []);
      const ranges = held.get(name);
      if (!source.input.ranges.every(([start, end]) => ranges.some(([first, last]) => first <= start && last >= end))) return false;
    }
    return true;
  }
}

/**
 * Where a request has spent its time since it was asked, as one clause of its
 * log line. The resolutions include the reads of the file they made, and those
 * reads are split into the time spent behind earlier reads of the same file and
 * the time of the read itself; what is left of the total is the copy and the
 * waits between attempts for bytes or memory.
 *
 * @param {object | undefined} timing
 * @param {number} now
 * @returns {string}
 */
function describeTiming(timing, now) {
  if (!timing) return "";
  return `; asked ${Math.max(0, now - timing.askedAt)}ms ago over ${timing.attempts} attempt(s): ` +
    `${timing.resolutions} resolution(s) ${timing.resolveMs}ms ` +
    `(${timing.reads} file read(s): queued ${timing.queuedMs}ms, reading ${timing.readMs}ms), ` +
    `held ranges ${timing.heldMs}ms, budget ${timing.budgetMs}ms`;
}

function addressOf(output) { return output.outputKey ?? output.id; }
function keyOf(output, from) { return `${addressOf(output)}:${from}`; }
