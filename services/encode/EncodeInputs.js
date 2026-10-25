import { admitInput } from "./AdmittedInput.js";
import { admitOriginalInput, originalInputBytes } from "./OriginalInput.js";
import { OriginalInputStore } from "./OriginalInputStore.js";

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
  /** Output → how long its last input took to be ready, ms. @type {WeakMap<object, number>} */
  #preparedIn = new WeakMap();
  #memoryRevision = 0;
  #held = 0;
  #shared = new OriginalInputStore({ changed: () => queueMicrotask(() => this.memoryChanged()) });
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
  #openWholeFile;
  #heldRanges;
  #revise;
  #changed;
  #failed;
  #capacity;
  #urgent;
  #rankAt;
  #log;
  #now;
  /**
   * Told when an original input's stretch is copied whole, while its bytes are
   * held, so what else they answer can be read from them (`learnPackets`).
   *
   * @type {(output: object, from: number, to: number, input: object) => void}
   */
  #stretchCopied;
  #observeWait;

  constructor({ resolve, readRanges, openWholeFile = null, heldRanges = null, reviseBudget, changed, failed, capacity = () => null, urgent = () => true,
    rankAt = () => null, openOf = () => null, log = () => {}, now = Date.now, stretchCopied = () => {},
    observeWait = null }) {
    this.#stretchCopied = stretchCopied;
    this.#observeWait = observeWait;
    this.#openOf = openOf;
    this.#resolve = resolve;
    this.#read = readRanges;
    this.#openWholeFile = openWholeFile;
    this.#heldRanges = heldRanges;
    this.#revise = reviseBudget;
    this.#changed = changed;
    this.#failed = failed;
    this.#capacity = capacity;
    this.#urgent = urgent;
    this.#rankAt = rankAt;
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
    const rank = request.readPriority?.serves === serves
      ? request.readPriority : this.#rankAt(request.output, serves);
    this.#log(`encode input #${request.from}..#${request.to} of ${request.output.outputKey ?? request.output.id}: ${state}` +
      ` (held ${this.held()} of ${this.#allowed} allowed; for #${serves}` +
      `${rank ? `, rank ${rank.rank} of ${rank.topRank}` : ""})${detail}`);
  }

  #observe(request, phase, fields = {}) {
    const sourceKey = request.output?.file?.sourceKey;
    if (typeof sourceKey !== "string") return;
    const process = request.output?.spec?.carries === "audio-only" ? "P8.a" : "P8.v";
    this.#observeWait?.(sourceKey, "process", { process, phase, at: performance.now(),
      output: request.output.outputKey ?? request.output.id, from: request.from, to: request.to, ...fields });
  }

  /** The container's statement of an interval, its time added to the request's account. */
  async #resolveTimed(timing, output, from, to, isCurrent = null, signal = null, readPriority = null) {
    const startedAt = this.#now();
    try {
      return await this.#resolve(output, from, to, timing, isCurrent, signal, readPriority);
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

  held() { return this.#held + this.#shared.bytes; }
  wanted() { return this.held() + [...this.#wanted.values()].reduce((sum, asked) => sum + asked.wanted, 0); }
  required() {
    let bytes = this.#held + this.#shared.required;
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
    this.#shared.trim(this.#allowed - this.#held);
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
      request.controller?.abort();
      request.result?.release?.();
    }
    this.#retryMemory();
  }

  /**
   * Withdraw what is being prepared or held for a start the plan no longer
   * places: `starts` holds every start the last plan of this output placed or
   * held back, and the number after each run it left alive. `retain` withdrew
   * such a copy only once it was held, and only when a run was started; while
   * it was being made it shared the torrent thread with the copy the viewer
   * was waiting for. Field 2026-10-12: after a seek back, the next stretch of
   * the run the seek had stopped went on being copied beside the one for the
   * new position, 127.5 and 126.5 MB in 16 s each, and was withdrawn only once
   * it was done (torrent-tv/meta#178).
   *
   * @param {object} output
   * @param {Set<number>} starts
   */
  withdrawUnplaced(output, starts) {
    for (const [key, request] of this.#requests) {
      if (request.output !== output || request.result?.kind === "terminal" || starts.has(request.from)) continue;
      this.#note(request, "withdrawn: the plan places no run there");
      this.#requests.delete(key);
      this.#wanted.delete(key);
      request.controller?.abort();
      // A copy already answered may still be copying its stretch; released,
      // the stretch is dropped when its read returns.
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
    const request = existing ?? { output, from, to, key, serves, traceStartedAt: performance.now() };
    if (!existing) this.#observe(request, "begin", { request: key });
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

  /**
   * Bytes of a source changed: every waiting input is tried again, except one
   * that waits for named bytes none of which have come. Tried at every piece
   * of the file, a seek's input was prepared 28 times in 8.5 s on Home
   * Assistant, each time asking the torrent thread which ranges it holds
   * (171 ms on average), and the try that found its bytes could start only
   * after the one in flight (r34, torrent-tv/meta#178).
   *
   * @param {{ sourceKey: string, ranges: Array<{ fileIndex: number, start: number, end: number }> } | null} [arrived] -
   *   The bytes that arrived, inclusive, when the event names them.
   */
  /**
   * How long this output's last input took from being asked for to being
   * ready, in milliseconds, or null before one was: the time a run gives the
   * input after it to be prepared in (`EncodeRuns`).
   *
   * @param {object} output
   * @returns {number | null}
   */
  preparationMsOf(output) {
    return this.#preparedIn.get(output) ?? null;
  }

  bytesChanged(arrived = null) {
    this.#revision++;
    for (const request of this.#requests.values()) {
      if (request.pending) {
        // The try in flight may have read before these bytes came. What it
        // waits for is known only when it answers, so they are kept for that
        // answer; bytes not named make it try again whatever it answers.
        if (!arrived) request.unnamedArrival = true;
        else (request.arrivedMeanwhile ??= []).push(arrived);
        continue;
      }
      if (request.result?.kind === "result" || request.result?.kind === "terminal") continue;
      if (arrived && request.result?.kind === "needs-bytes" && !awaitedIn(request.result, arrived)) {
        // Nothing it waits for has come: it stands as tried at this revision.
        request.revision = this.#revision;
        continue;
      }
      this.#prepare(request);
    }
  }

  forget(output) {
    for (const [key, request] of this.#requests) {
      if (request.output !== output) continue;
      this.#requests.delete(key);
      this.#wanted.delete(key);
      request.controller?.abort();
      request.result?.release?.();
    }
    this.#shared.forget(output);
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
    const sizing = this.#sizingFor(output);
    return sizing ? { bytes: sizing.bytes, openMeasured: sizing.openMeasured } : null;
  }

  #sizingFor(output) {
    const rate = middleOf(this.#copyRates);
    const open = this.#openOf(output);
    return rate === null || !open ? null : { bytes: Math.floor(rate * open.seconds * 1000),
      openMeasured: open.measured, openSeconds: open.seconds, copyBytesPerMs: rate };
  }

  /**
   * What a stretch is sized from, for an output that may not exist yet: the
   * recent copy rate in bytes per millisecond, and the memory encoder inputs
   * may hold, each null while not known (`effective-speed.js`).
   *
   * @returns {{ copyBytesPerMs: number | null, capacityBytes: number | null }}
   */
  stretchTerms() {
    const capacity = this.#capacity();
    return { copyBytesPerMs: middleOf(this.#copyRates), capacityBytes: Number.isFinite(capacity) ? capacity : null };
  }

  /**
   * @param {object} output
   * @returns {number | null}
   */
  stretchBytesFor(output) {
    return this.stretchFor(output)?.bytes ?? null;
  }

  /**
   * What the next run of this output would be given to copy, whatever has
   * arrived: the stretch `stretchFor` sizes, within the memory encoder inputs
   * may hold. The download map asks the swarm for that much as one group
   * (`torrent/PlaybackProjection.js`); a stretch shortened to what is here
   * would ask only for what is here. Null while it is not known.
   *
   * @param {object} output
   * @returns {number | null}
   */
  targetInputBytes(output) {
    const bytes = this.stretchBytesFor(output);
    if (bytes === null) return null;
    const capacity = this.#capacity();
    return Number.isFinite(capacity) ? Math.min(bytes, capacity) : bytes;
  }

  #prepare(request) {
    request.controller ??= new AbortController();
    request.pending = true;
    request.readPriority = this.#readPriority(request, request.from, request.from);
    request.revision = this.#revision;
    request.memoryRevision = this.#memoryRevision;
    request.arrivedMeanwhile = null;
    request.unnamedArrival = false;
    // Where the time from the request to its input goes, across every attempt:
    // field 2026-10-10, a picture's request took 38 s before its copy began and
    // nothing said on what (torrent-tv/meta#166).
    request.timing ??= { askedAt: this.#now(), attempts: 0, resolutions: 0, resolveMs: 0,
      reads: 0, queuedMs: 0, readMs: 0, readsByStatement: {}, heldMs: 0, budgetMs: 0 };
    request.timing.attempts += 1;
    this.#observe(request, "attempt", { request: request.key, attempt: request.timing.attempts });
    request.promise = (async () => {
      // A request the plan withdraws stops its reads: a soundtrack piece's
      // packet walk, left to run, held the file's reads and the piece the
      // viewer had seeked to waited 16.9 s behind it (r59, torrent-tv/meta#178).
      const resolved = await this.#resolveTimed(request.timing, request.output, request.from, request.from,
        () => this.#requests.get(request.key) === request && !request.controller.signal.aborted, request.controller.signal,
        request.readPriority);
      if (resolved.kind === "result") this.#original.set(request.output, resolved.sources?.every(source => source.input.original === true) === true);
      if (this.#requests.get(request.key) !== request) return;
      let result;
      if (resolved.kind !== "result") {
        result = resolved;
      } else if (resolved.sources?.every(source => source.input.original === true)) {
        const sharing = resolved.sources.every(source => Array.isArray(source.input.commonRanges));
        if (sharing) this.#shared.retain(request.output, resolved.sources);
        const files = new Map();
        let unpin = () => {};
        try {
          for (const source of resolved.sources) {
            const file = await this.#openWholeFile?.(source);
            if (file && file.length === source.input.fileLength) files.set(source.fileIndex, file);
            else if (file) await file.release();
            if (this.#requests.get(request.key) !== request) return;
          }
          if (sharing) unpin = this.#shared.protect(resolved.sources.filter(source => !files.has(source.fileIndex)));
          result = await this.#admitStretch(request, resolved.sources, files);
        } finally {
          unpin();
          if (result?.kind !== "result") await Promise.all([...files.values()].map(file => file.release()));
        }
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
      if (result.kind === "result") this.#preparedIn.set(request.output, this.#now() - request.timing.askedAt);
      this.#note(request, result.kind === "result" ? `ready #${result.from}..#${result.to}, ${result.bytes ?? "?"} bytes` +
        (Number.isFinite(result.copyMs) ? (result.deferredBytes > 0
          ? `, opening part copied in ${result.copyMs}ms, ${result.deferredBytes} bytes of the stretch copied while the run opens`
          : `, copied in ${result.copyMs}ms`) : "")
        : `${result.kind}${result.reason ? ` ${result.reason}` : ""}${Number.isFinite(result.bytes) ? ` ${result.bytes} bytes` : ""}`,
      describeTiming(request.timing, this.#now()));
      if (result.kind === "result" || result.kind === "terminal") {
        this.#observe(request, "end", { request: request.key, startedAt: request.traceStartedAt,
          endedAt: performance.now(), outcome: result.kind, reason: result.reason ?? null,
          bytes: result.bytes ?? null, attempts: request.timing.attempts });
      } else {
        this.#observe(request, "waiting", { request: request.key, reason: result.kind,
          bytes: result.bytes ?? null, attempts: request.timing.attempts });
      }
      if (result.kind === "result" || result.kind === "terminal") this.#changed(request.output, result);
    })().catch(error => {
      if (this.#requests.get(request.key) === request) {
        request.result = { kind: "terminal", reason: "input-preparation-failed", message: error.message };
        this.#observe(request, "end", { request: request.key, startedAt: request.traceStartedAt,
          endedAt: performance.now(), outcome: "error", reason: "input-preparation-failed", attempts: request.timing.attempts });
        this.#failed(request.output, error);
      }
    }).finally(() => {
      request.pending = false;
      if (request.result?.kind !== "needs-memory") this.#wanted.delete(request.key);
      const changed = request.result?.kind === "needs-memory"
        ? request.memoryRevision !== this.#memoryRevision : this.#arrivedFor(request);
      if (this.#requests.get(request.key) === request && changed &&
        request.result?.kind !== "result" && request.result?.kind !== "terminal") this.#prepare(request);
    });
  }

  /**
   * The media reads that prepare one input keep the output map's urgency and
   * the segment they serve, so a container can run an exact nearby interval
   * before a speculative attempt to extend that input.
   *
   * @param {object} request
   * @param {number} from
   * @param {number} to
   * @returns {{ rank: number, serves: number, from: number, to: number }}
   */
  #readPriority(request, from, to) {
    const serves = request.serves ?? request.from;
    const rank = this.#rankAt(request.output, serves);
    return { rank: Number.isFinite(rank?.rank) ? rank.rank : 0, topRank: Number.isFinite(rank?.topRank) ? rank.topRank : 0,
      serves, from, to };
  }

  /**
   * Whether bytes came during a try that the try may have missed. A try that
   * waits for named bytes is repeated only when some of them came, or when an
   * event named nothing; the others stand it as tried at this revision. In r36
   * a held-range check took 344 ms, and a piece of the file arriving during it
   * started another (torrent-tv/meta#178).
   */
  #arrivedFor(request) {
    if (request.revision === this.#revision) return false;
    const arrivals = request.arrivedMeanwhile ?? [];
    request.arrivedMeanwhile = null;
    if (request.unnamedArrival || request.result?.kind !== "needs-bytes" ||
      arrivals.some(arrived => awaitedIn(request.result, arrived))) return true;
    request.revision = this.#revision;
    return false;
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
    if (this.#requests.get(request.key) !== request) return null;
    this.#shared.trim(this.#allowed - this.#held - bytes);
    if (this.#allowed - this.held() < bytes) return null;
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
  async #admitStretch(request, firstSources, files = new Map()) {
    const { output, from } = request;
    const sharing = files.size > 0 || firstSources.every(source => Array.isArray(source.input.commonRanges));
    const inMemory = sources => sources.filter(source => !files.has(source.fileIndex));
    const memoryBytes = sources => sharing ? this.#shared.bytesNeeded(inMemory(sources)) : originalInputBytes(sources);
    // Record existing decisions only: diagnostics must not resolve another
    // interval or ask storage for an additional availability reading.
    const probes = [], reservations = [];
    let minimum = originalInputBytes(firstSources);
    const stretches = new Map([[from, { sources: firstSources, bytes: minimum }]]);
    const held = new Map();
    const at = async end => {
      if (!stretches.has(end)) {
        // A longer stretch that cannot be stated is not one to copy; the
        // shorter one already stated still runs.
        const current = () => this.#requests.get(request.key) === request && !request.controller.signal.aborted;
        const resolved = await this.#resolveTimed(request.timing, output, from, end, current, request.controller.signal,
          this.#readPriority(request, from, end)).catch(() => null);
        stretches.set(end, resolved?.kind === "result" && resolved.sources?.every(source => source.input.original === true)
          ? { sources: resolved.sources, bytes: originalInputBytes(resolved.sources) } : null);
      }
      return stretches.get(end);
    };
    const fits = async (end, maxBytes, memory = false) => {
      const stretch = await at(end);
      const withinLimit = Boolean(stretch) && (memory ? memoryBytes(stretch.sources) <= maxBytes && stretch.bytes <= (target ?? minimum) : stretch.bytes <= maxBytes);
      const result = !stretch ? "unresolved" : !withinLimit ? "size"
        : await this.#present(stretch.sources, held, request.timing, files) ? "fits" : "missing-bytes";
      probes.push({ end, limitBytes: maxBytes, bytes: stretch?.bytes ?? null, result,
        ...(sharing ? { bound: memory ? "memory" : "target", memoryBytes: stretch ? memoryBytes(stretch.sources) : null } : {}) });
      return result === "fits";
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
    const longest = async (maxBytes, memory = false) => {
      let good = floor, bad = null, step = 1;
      while (bad === null) {
        const end = good + step;
        if (end > request.to) bad = request.to + 1;
        else if (await fits(end, maxBytes, memory)) { good = end; step *= 2; }
        else bad = end;
      }
      while (bad - good > 1) {
        const middle = Math.floor((good + bad) / 2);
        if (await fits(middle, maxBytes, memory)) good = middle; else bad = middle;
      }
      return good;
    };
    const sizing = this.#sizingFor(output);
    const target = sizing?.bytes ?? null;
    if (sizing && !sizing.openMeasured) request.timing.openApproximate = true;
    let end = target === null || this.#heldRanges === null ? floor : await longest(target);
    const targetEnd = end;
    if (this.#requests.get(request.key) !== request) return undefined;
    const minimumMemory = () => memoryBytes(stretches.get(floor).sources);
    this.#wanted.set(request.key, { wanted: memoryBytes(stretches.get(end).sources), required: minimumMemory() });
    await this.#spent(request.timing, "budgetMs", () => this.#revise());
    if (this.#requests.get(request.key) !== request) return undefined;
    const capacity = this.#capacity();
    const minimumCapacity = originalInputBytes(inMemory(stretches.get(floor).sources));
    if (capacity !== null && minimumCapacity > capacity && this.#urgent(output, from)) {
      return { kind: "terminal", reason: "source-input-exceeds-memory-capacity", bytes: minimumCapacity, capacity };
    }
    const roomNow = () => Math.min(capacity ?? Number.POSITIVE_INFINITY, this.#allowed - this.held());
    let room = roomNow();
    let result;
    for (;;) {
      if (minimumMemory() > room) {
        // Wait for memory with the least it can run with, not the larger stretch.
        this.#wanted.set(request.key, { wanted: minimumMemory(), required: minimumMemory() });
        return { kind: "needs-memory", bytes: minimumMemory() };
      }
      if (memoryBytes(stretches.get(end).sources) > room) {
        end = await longest(sharing ? room : Math.min(target ?? minimum, room), sharing);
        if (this.#requests.get(request.key) !== request) return undefined;
      }
      const chosen = stretches.get(end);
      // EVERY BYTE IS HERE BEFORE THE RUN IS ANSWERED. The stretch is copied
      // after the answer (`OriginalInput.js`), so a stretch that is not all
      // downloaded would start an encoder whose input then fails; checked here,
      // it waits for the bytes as one read of everything used to. Field
      // 2026-10-12: a cold MKV's first piece was answered, its stretch read
      // found pieces missing, and the run was refused for good (torrent-tv/meta#178).
      if (this.#heldRanges !== null && !await this.#present(chosen.sources, held, request.timing, files)) {
        const [first] = chosen.sources;
        return { kind: "needs-bytes", sourceKey: first.sourceKey, fileIndex: first.fileIndex, ranges: first.input.ranges,
          // Every source of the stretch, so the bytes of any of them wake it.
          awaiting: chosen.sources.map(source => ({ sourceKey: source.sourceKey, fileIndex: source.fileIndex, ranges: source.input.ranges })) };
      }
      if (this.#requests.get(request.key) !== request) return undefined;
      const needed = memoryBytes(chosen.sources);
      this.#wanted.set(request.key, { wanted: needed, required: needed });
      if (sharing) {
        const reservation = { bytes: needed, minimumMemoryBytes: minimumMemory(), allowed: this.#allowed, held: this.held(), capacity, room: roomNow(), end };
        const storage = this.#shared.acquire(inMemory(chosen.sources), roomNow(), { readRanges: this.#read, now: this.#now });
        reservations.push({ ...reservation, admitted: storage !== null });
        if (storage) {
          this.#wanted.delete(request.key);
          result = await admitOriginalInput({ sources: chosen.sources, storage, files, now: this.#now });
        } else result = { kind: "needs-memory", bytes: needed };
      } else result = await admitOriginalInput({ sources: chosen.sources, readRanges: this.#read, now: this.#now,
        reserve: async bytes => {
          const reservation = { bytes, allowed: this.#allowed, held: this.held(), capacity,
            room: roomNow(), end };
          const release = this.#hold(request, bytes);
          reservations.push({ ...reservation, admitted: typeof release === "function" });
          return release;
        } });
      // Another output's copy can take the room this one was sized for while
      // it was being chosen. A shorter stretch is tried at once rather than
      // waiting for a memory change that may never come.
      if (result.kind !== "needs-memory" || this.#requests.get(request.key) !== request || roomNow() >= room) break;
      room = roomNow();
    }
    if (result.kind === "needs-memory") this.#wanted.set(request.key, { wanted: minimumMemory(), required: minimumMemory() });
    if (result.kind === "result") {
      this.#log(`encode input selection of ${addressOf(output)}: ${JSON.stringify({
        from, requestedTo: request.to, serves, floor, targetEnd, chosenEnd: end,
        targetBytes: target, minimumBytes: minimum, inputBytes: result.bytes,
        ...(sharing ? { minimumMemoryBytes: reservations.at(-1)?.minimumMemoryBytes ?? null, reservedMemoryBytes: reservations.at(-1)?.bytes ?? null } : {}),
        copyBytesPerMs: sizing?.copyBytesPerMs ?? null, openSeconds: sizing?.openSeconds ?? null,
        openMeasured: sizing?.openMeasured ?? null, reservations, probes
      })}`);
      Object.assign(result, { from, to: end });
      // The stretch is copied after the answer, while the run opens; the rate
      // is the whole copy's, learned once it is done.
      const copied = result.whole ?? Promise.resolve(true);
      void copied.then(whole => {
        if (whole && result.copyMs > 0 && result.copiedBytes > 0) keep(this.#copyRates, result.copiedBytes / result.copyMs);
        if (whole && result.copiedBytes + result.sharedBytes > 0) {
          try { this.#stretchCopied(output, from, end, result); }
          catch (error) { this.#log(`encode input #${from}..#${end} of ${addressOf(output)}: what was told of its copy failed: ${error?.message ?? error}`); }
        }
        this.#log(`encode input #${from}..#${end} of ${addressOf(output)}: ` + (whole
          ? `stretch copied, ${result.bytes} bytes in ${result.copyMs}ms of copying since it was admitted; copied ${result.copiedBytes}, shared ${result.sharedBytes}, disk ${result.diskBytes} bytes`
          : result.copyFailed?.() ? "the stretch could not be copied: a piece it needs is no longer held"
            : "released before its stretch was copied"));
      });
    }
    return result;
  }

  /** Whether every range of these sources is downloaded whole now. */
  async #present(sources, held, timing, files = new Map()) {
    for (const source of sources) {
      if (files.has(source.fileIndex)) continue;
      const name = `${source.sourceKey}:${source.fileIndex}`;
      if (!held.has(name)) held.set(name, await this.#spent(timing, "heldMs", () => Promise.resolve().then(() => this.#heldRanges(source)).catch(() => null)) ?? []);
      const ranges = [...held.get(name), ...this.#shared.available(source)].sort((a, b) => a[0] - b[0]);
      if (!source.input.ranges.every(([start, end]) => {
        let at = start;
        for (const [first, last] of ranges) {
          if (first > at) return false;
          if (last >= at) at = last + 1;
          if (at > end) return true;
        }
        return false;
      })) return false;
    }
    return true;
  }
}

/**
 * Whether some of the bytes an input waits for are among those that arrived.
 *
 * @param {{ sourceKey: string, fileIndex: number, ranges: Array<[number, number]>,
 *   awaiting?: Array<{ sourceKey: string, fileIndex: number, ranges: Array<[number, number]> }> }} waiting
 * @param {{ sourceKey: string, ranges: Array<{ fileIndex: number, start: number, end: number }> }} arrived
 * @returns {boolean}
 */
function awaitedIn(waiting, arrived) {
  const sources = waiting.awaiting ?? [waiting];
  return sources.some(source => source.sourceKey === arrived.sourceKey && Array.isArray(source.ranges) &&
    arrived.ranges.some(range => range.fileIndex === source.fileIndex &&
      source.ranges.some(([start, end]) => range.start <= end && range.end >= start)));
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
  const statements = Object.entries(timing.readsByStatement ?? {}).map(([statement, measured]) =>
    `${statement} queued ${measured.queuedMs}ms/read ${measured.readMs}ms`).join(", ");
  return `; asked ${Math.max(0, now - timing.askedAt)}ms ago over ${timing.attempts} attempt(s): ` +
    `${timing.resolutions} resolution(s) ${timing.resolveMs}ms ` +
    `(${timing.reads} file read(s): queued ${timing.queuedMs}ms, reading ${timing.readMs}ms), ` +
    (statements ? `by statement: ${statements}, ` : "") +
    `held ranges ${timing.heldMs}ms, budget ${timing.budgetMs}ms` +
    // Where a packet input's walk spent its read: waiting for the same
    // track's earlier walks, or reading the file (r62, torrent-tv/meta#178).
    (timing.walk ? `; packet walk waited ${timing.walk.lockMs}ms for its track and read ${timing.walk.reads} time(s), ${timing.walk.bytes} bytes of the file` : "") +
    (timing.openApproximate ? "; sized by the host's startup open, this output has not opened yet" : "");
}

function addressOf(output) { return output.outputKey ?? output.id; }
function keyOf(output, from) { return `${addressOf(output)}:${from}`; }
