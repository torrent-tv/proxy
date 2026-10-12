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
  /** Whether an output's last resolved input was its original file. @type {WeakMap<object, boolean>} */
  #original = new WeakMap();
  #revision = 0;
  #memoryRevision = 0;
  #held = 0;
  #allowed = 0;
  /** What each preparing request asks of memory: all it would use, and the least it can run with. */
  #wanted = new Map();
  /** Bytes per millisecond of recent original-input copies, read where the copy is made. */
  #copyRates = [];
  /**
   * How long an encoder takes to open an output's original input: asked of
   * the one owner of start readings (`RunCosts`, torrent-tv/meta#184).
   *
   * @type {(output: object) => { seconds: number, measured: boolean } | null}
   */
  #openOf;
  #resolve;
  #read;
  #heldRanges;
  #revise;
  #changed;
  #failed;
  #capacity;
  #urgent;
  #rankAt;
  #deadlineOf;
  #firstPieceIn;
  #log;
  #now;

  constructor({ resolve, readRanges, heldRanges = null, reviseBudget, changed, failed, capacity = () => null, urgent = () => true,
    rankAt = () => null, deadlineOf = () => null, firstPieceIn = () => null, openOf = () => null, log = () => {}, now = Date.now }) {
    this.#openOf = openOf;
    this.#resolve = resolve;
    this.#read = readRanges;
    this.#heldRanges = heldRanges;
    this.#revise = reviseBudget;
    this.#changed = changed;
    this.#failed = failed;
    this.#capacity = capacity;
    this.#urgent = urgent;
    this.#rankAt = rankAt;
    this.#deadlineOf = deadlineOf;
    this.#firstPieceIn = firstPieceIn;
    this.#log = log;
    this.#now = now;
  }

  /**
   * One line when a request's state changes, so a wait that never ends names
   * what it waits for. `detail` is said with it and does not count as a change.
   *
   * It names the piece the input is prepared FOR and that piece's rank in the
   * output's map: an input read from the keyframe before starts one piece
   * early, and its own first piece would understate how urgently it is wanted
   * (torrent-tv/meta#178).
   */
  #note(request, state, detail = "") {
    if (request.noted === state) return;
    request.noted = state;
    const serves = request.serves ?? request.from;
    const rank = this.#rankAt(request.output, serves);
    this.#log(`encode input #${request.from}..#${request.to} of ${request.output.outputKey ?? request.output.id}: ${state}` +
      ` (held ${this.#held} of ${this.#allowed} allowed; for #${serves}` +
      `${rank ? `, rank ${rank.rank} of ${rank.topRank}` : ""})${detail}`);
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

  /**
   * Whether this output reads its original file, as its last resolved input
   * did, or undefined before any was resolved.
   *
   * @param {object} output
   * @returns {boolean | undefined}
   */
  readsOriginal(output) {
    return this.#original.get(output);
  }

  failureOf(output) {
    for (const request of this.#requests.values()) {
      if (request.output === output && request.result?.kind === "terminal") return request.result;
    }
    return null;
  }

  /**
   * Withdraw what this output no longer needs: a request no wanted window
   * covers, and — when `starts` is given — a copy already held whose start is
   * neither where a live run ends nor where one is being started. A next
   * stretch is copied for the run working before it (torrent-tv/meta#158);
   * once that run has gone and the plan starts elsewhere, after a seek, the
   * copy held memory nobody would use (torrent-tv/meta#184).
   *
   * @param {object} output
   * @param {{ from: number, to: number }[]} windows
   * @param {Set<number> | null} [starts]
   */
  retain(output, windows, starts = null) {
    for (const [key, request] of this.#requests) {
      if (request.output !== output) continue;
      const covered = windows.some(window => request.from <= window.to && request.to >= window.from);
      const unused = starts !== null && request.result?.kind === "result" && !starts.has(request.from);
      if (covered && !unused) continue;
      this.#note(request, covered ? "withdrawn: no live run ends before it and no start is placed there"
        : "withdrawn: no wanted window covers it");
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
   * The answer carries the stretch it holds as `from` and `to`. `serves` is
   * the piece the run is started for, which is `from` unless the input is read
   * from the keyframe before.
   */
  take(output, from, to, serves = from) {
    const key = keyOf(output, from);
    let existing = this.#requests.get(key);
    if (existing) existing.serves = serves;
    if (existing && existing.to !== to) {
      // The plan's bound for this start moved. A copy already made beyond it
      // holds the shorter stretch whole, so the run is commanded over its
      // prefix and the copy is kept until the run ends: copying it again cost
      // as long as the first copy (torrent-tv/meta#184). One being made is
      // narrowed when it is done, and one waiting for bytes or memory takes the
      // new bound when its own event prepares it again.
      existing.to = to;
      if (existing.result?.kind === "result" && existing.result.to > to) existing.result.to = Math.max(existing.from, to);
    }
    if (existing?.result?.kind === "result") {
      this.#requests.delete(key);
      return existing.result;
    }
    if (existing?.pending || existing?.revision === this.#revision || existing?.result?.kind === "terminal") return null;
    const request = existing ?? { output, from, to, key, serves };
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
  }

  /**
   * How many bytes a stretch may hold so that copying it takes no longer than
   * opening the input it replaces: the recent copy rate times this output's
   * recent open. Beyond it the open's share of each piece falls below the
   * copy's, which is the same for every piece; a longer stretch buys less and
   * delays the run's start more. Null until a copy rate is measured and an
   * open is known, and the run then gets one piece. An output that has not
   * opened yet is sized by the host's startup reading, which is said: at a
   * cold start the second run was one piece too for want of it, and cost
   * another open (6.34 s, torrent-tv/meta#166 run 12).
   *
   * @param {object} output
   * @returns {{ bytes: number, openMeasured: boolean } | null}
   */
  stretchFor(output) {
    const rate = middleOf(this.#copyRates);
    const open = this.#openOf(output);
    return rate === null || !open ? null : { bytes: Math.floor(rate * open.seconds * 1000), openMeasured: open.measured };
  }

  /**
   * @param {object} output
   * @returns {number | null}
   */
  stretchBytesFor(output) {
    return this.stretchFor(output)?.bytes ?? null;
  }

  #prepare(request) {
    request.pending = true;
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
      if (resolved.kind === "result") this.#original.set(request.output, resolved.sources?.every(source => source.input.original === true) === true);
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
      // The plan narrowed this start while the copy was being made: the run
      // is commanded over its prefix.
      if (result.kind === "result" && result.to > request.to) result.to = Math.max(request.from, request.to);
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
      const changed = request.result?.kind === "needs-memory"
        ? request.memoryRevision !== this.#memoryRevision : request.revision !== this.#revision;
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
    let minimum = originalInputBytes(firstSources);
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
    // THE LEAST THAT MAKES THE PIECE IT IS FOR. An input read from the keyframe
    // before starts one piece early; holding that piece alone would not make
    // the one the viewer wants (torrent-tv/meta#178).
    const serves = Math.max(from, Math.min(request.serves ?? from, request.to));
    let floor = from;
    if (serves > from) {
      const covering = await at(serves);
      if (covering) { floor = serves; minimum = covering.bytes; }
    }
    const longest = async maxBytes => {
      let good = floor, bad = null, step = 1;
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
    const sizing = this.stretchFor(output);
    let target = sizing?.bytes ?? null;
    if (sizing && !sizing.openMeasured) request.timing.openApproximate = true;
    // NO LONGER THAN THE VIEWER CAN WAIT. A stretch is sized so its copy takes
    // no longer than an open; for a piece the viewer reaches soon, the copy and
    // the time to that piece's being served must both fit before they reach it.
    // Field 2026-10-12: after a seek back, 222.4 MB were copied for 7.7 s ahead
    // of a piece needed in about 8 s, and the picture stood 13.2 s. Unknown
    // terms leave the stretch as it was.
    const deadline = this.#deadlineOf(output, serves);
    const firstPiece = this.#firstPieceIn(output, from, serves);
    const copyRate = middleOf(this.#copyRates);
    if (target !== null && Number.isFinite(deadline) && Number.isFinite(firstPiece) && copyRate !== null) {
      const fitting = Math.floor(copyRate * Math.max(0, deadline - firstPiece) * 1000);
      if (fitting < target) {
        const capped = Math.max(minimum, fitting);
        this.#log(`encode input #${from}..#${request.to} of ${output.outputKey ?? output.id}: copy held to ${capped} of ${target} bytes ` +
          `— #${serves} is needed in ${deadline.toFixed(1)}s and its first piece takes ${firstPiece.toFixed(1)}s to be served`);
        target = capped;
      }
    }
    let end = target === null || this.#heldRanges === null ? floor : await longest(target);
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
    `held ranges ${timing.heldMs}ms, budget ${timing.budgetMs}ms` +
    (timing.openApproximate ? "; sized by the host's startup open, this output has not opened yet" : "");
}

function addressOf(output) { return output.outputKey ?? output.id; }
function keyOf(output, from) { return `${addressOf(output)}:${from}`; }
