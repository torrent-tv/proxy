import { createHash } from "node:crypto";

/** Retain complete original byte ranges under the encoder's input allowance.
 * The available-only reader acquires complete pieces atomically before copying;
 * owned buffers then outlive torrent eviction without keeping duplicate pins.
 *
 * THE RUN STARTS ONCE WHAT FFMPEG OPENS WITH IS COPIED. Each source's largest
 * range — the stretch of film — is copied after the rest, and the answer comes
 * back before it: FFmpeg's start and its reads of the header and the index then
 * overlap that copy, and a read inside the stretch waits for it. Field
 * 2026-10-12, after a seek back: 126.5 MB copied in 16.3 s before the encoder
 * was started, then 10.1 s of its own open, and the viewer stood 33 s
 * (torrent-tv/meta#178). `whole` settles when everything is copied — true — or
 * when the copy failed or the input was released first — false.
 */
export async function admitOriginalInput({ sources, reserve, readRanges, now = Date.now, storage = null, files = new Map() }) {
  const bytes = originalInputBytes(sources);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new TypeError("Original input requires complete finite byte ranges.");
  const releaseBudget = storage ? storage.release : await reserve(bytes);
  if (typeof releaseBudget !== "function") return releaseBudget?.kind === "terminal" ? releaseBudget : { kind: "needs-memory", bytes };
  const held = new Map();
  const hash = createHash("sha256");
  let retained = false;
  // How long the copy itself took, apart from any wait for memory or bytes
  // before it: the figure a run's stretch is sized from, read where the copy is.
  let copyMs = 0;
  let diskBytes = 0;
  // Per source, the range copied after the answer: its position in the
  // source's ranges, and the copy's promise once it has begun.
  const later = [];
  const read = async (source, ranges) => {
    if (files.has(source.fileIndex)) return ranges.map(() => true);
    if (storage) return await storage.copy(source, ranges) ? ranges.map(() => true) : null;
    const startedAt = now();
    const buffers = await readRanges(source, ranges, bytes);
    copyMs += Math.max(0, now() - startedAt);
    if (buffers === null) return null;
    if (!Array.isArray(buffers) || buffers.length !== ranges.length || buffers.some((buffer, index) =>
      !Buffer.isBuffer(buffer) || buffer.length !== ranges[index][1] - ranges[index][0] + 1)) {
      throw new Error("Original input reader returned incomplete ranges.");
    }
    return buffers;
  };
  try {
    for (const source of sources) {
      const { ranges } = source.input;
      const largest = ranges.reduce((best, range, index) =>
        range[1] - range[0] > ranges[best][1] - ranges[best][0] ? index : best, 0);
      const deferred = !files.has(source.fileIndex) && ranges.length > 1 ? largest : -1;
      const first = ranges.filter((_, index) => index !== deferred);
      const buffers = await read(source, first);
      if (buffers === null) return { kind: "needs-bytes", sourceKey: source.sourceKey, fileIndex: source.fileIndex, ranges };
      // THE INPUT IS NAMED BY WHAT IT IS, NOT BY ITS BYTES. Every source is a
      // torrent whose pieces are verified before they are stored, and a read
      // gives every byte or none, so the same source, file, ranges and
      // selections are the same bytes. Hashing the bytes as well took 13.45 s
      // of 180 s of the main thread on a Matroska film whose picture and sound
      // copy the same ~30 MB a piece (torrent-tv/meta#178).
      hash.update(JSON.stringify([source.sourceKey, source.fileIndex, ranges, source.input.selections]));
      const entry = { source, buffers: ranges.map((_, index) => index === deferred ? null : buffers[index - (deferred >= 0 && index > deferred ? 1 : 0)]) };
      held.set(source.fileIndex, entry);
      if (deferred >= 0) later.push({ entry, position: deferred });
    }
    let released = false;
    let runReleased = false, owners = 1, finishClose;
    const closed = new Promise(resolve => { finishClose = resolve; });
    let failed = false;
    retained = true;
    // ONE READ FOR THE STRETCH. Copied a torrent piece per read (2.97.12), a
    // stretch took 33.1 s for 83.9 MB on the field's AVI against 126.5 MB in
    // 16.3 s as one read beside another copy (torrent-tv/meta#178): each read
    // waits its turn on two busy threads, and the stretch paid that once per
    // piece. A release therefore discards the stretch when its read returns.
    const copyLater = job => read(job.entry.source, [job.entry.source.input.ranges[job.position]]).then(buffers => {
      if (buffers === null) { failed = true; return false; }
      if (released) return false;
      job.entry.buffers[job.position] = buffers[0];
      return true;
    }, () => { failed = true; return false; });
    // The stretches, one source after another: they share one reader, and the
    // first source's stretch is the one FFmpeg reaches first.
    const whole = (async () => {
      for (const job of later) {
        if (released) return false;
        job.copy = job.copy ?? copyLater(job);
        if (!await job.copy) return false;
      }
      return !released;
    })();
    // A read of a stretch waits for its copy, which begins at once for the
    // stretch asked for even when another is still being copied before it.
    const copied = (entry, position) => {
      const job = later.find(candidate => candidate.entry === entry && candidate.position === position);
      if (!job) return Promise.resolve(entry.buffers[position] !== null);
      job.copy = job.copy ?? copyLater(job);
      return job.copy;
    };
    // What FFmpeg asked of this input, for the run's own account of where its
    // time went: field 2026-10-08, a run took 6-9 s for a piece FFmpeg makes in
    // 1.6 s from a file, and nothing said whether it was waiting on its input.
    const reads = { count: 0, bytes: 0, firstAt: 0, lastAt: 0 };
    // Each answer FFmpeg was sent, in order: where it began, where its range
    // ended, what was handed to the system before the connection closed, and
    // whether all of it was (torrent-tv/meta#177).
    /** @type {{ fileIndex: number, start: number, end: number, written: number, handedOver: boolean, at: number }[]} */
    const answers = [];
    // When FFmpeg's reads waited for a stretch still being copied.
    /** @type {{ from: number, to: number | null }[]} */
    const waits = [];
    const answer = (entry, position, start, stop, answeringHttp = false) => {
      const now = Date.now();
      reads.count += 1;
      reads.bytes += stop - start + 1;
      reads.firstAt ||= now;
      reads.lastAt = now;
      const [from] = entry.source.input.ranges[position];
      const file = files.get(entry.source.fileIndex);
      if (file) {
        // Packet learning reads only an already-owned memory copy; disk has no
        // such copy. Its ordinary container reader already reads this file.
        if (!answeringHttp) return null;
        const stream = file.stream(start, stop, bytes => { diskBytes += bytes; });
        return stream ? { length: file.length, end: stop, size: stop - start + 1, stream } : null;
      }
      if (storage) {
        const held = storage.slices(entry.source, start, stop, answeringHttp);
        if (!held) return null;
        return { length: entry.source.input.fileLength, end: stop, size: stop - start + 1,
          ...(answeringHttp && held.buffers.length > 1 ? { chunks: held.buffers }
            : { bytes: held.buffers.length === 1 ? held.buffers[0] : Buffer.concat(held.buffers) }),
          release: held.release };
      }
      return { length: entry.source.input.fileLength, end: stop, bytes: entry.buffers[position].subarray(start - from, stop - from + 1) };
    };
    const drop = () => {
      owners--;
      if (owners || released) return;
      released = true;
      held.clear();
      releaseBudget();
      void Promise.all([whole, ...[...files.values()].map(file => file.release())]).then(finishClose);
    };
    return {
      kind: "result", original: true, sources, bytes, fingerprint: hash.digest("hex"),
      // What the copy took so far; final once `whole` has settled.
      get copyMs() { return storage ? storage.stats.copyMs : copyMs; },
      get copiedBytes() { return storage ? storage.stats.copiedBytes : bytes; },
      get sharedBytes() { return storage ? storage.stats.sharedBytes : 0; },
      get diskBytes() { return diskBytes; },
      whole,
      // Bytes of the stretches still to be copied when the answer was given.
      deferredBytes: later.reduce((sum, job) => {
        const [first, last] = job.entry.source.input.ranges[job.position];
        return sum + last - first + 1;
      }, 0),
      copyFailed: () => failed,
      // No track's own end: the container names the bytes an interval needs,
      // not where each track stops. The final piece is judged by the input
      // reaching the end of the file instead (`piece-completeness.js`).
      tracks: sources.flatMap(source => (source.input.selections ?? []).map(selection => ({ track: selection.track }))),
      heldUntil(fileIndex, start) {
        if (released) return null;
        const entry = held.get(fileIndex);
        if (!entry || files.has(fileIndex)) return null;
        const range = entry.source.input.ranges.find(([first, last]) => first <= start && last >= start);
        return range ? Math.min(range[1] + 1, storage?.endOf(entry.source, start) ?? range[1] + 1) : null;
      },
      /**
       * The answer to a read from `start`, or null when it lies outside what
       * the run holds. Inside a stretch still being copied the answer is a
       * promise of the same, settled once the stretch is copied.
       */
      read(fileIndex, start, end, partial = false) {
        if (released) return null;
        const entry = held.get(fileIndex);
        if (!entry) return null;
        const { ranges, fileLength } = entry.source.input;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= fileLength) return null;
        let stop = Math.min(end, fileLength - 1);
        const position = ranges.findIndex(([from, to]) => from <= start && (partial ? start : stop) <= to);
        if (position < 0) return null;
        stop = Math.min(stop, ranges[position][1]);
        if (entry.buffers[position] !== null) return answer(entry, position, start, stop, partial);
        const wait = { from: Date.now(), to: null };
        waits.push(wait);
        return copied(entry, position).then(ok => {
          wait.to = Date.now();
          return ok && !released ? answer(entry, position, start, stop, partial) : null;
        });
      },
      /**
       * Wall-clock milliseconds FFmpeg's reads spent waiting for a stretch to
       * be copied before `until`. A run's open is measured from its first piece,
       * and this wait is the copy's, not the open's: counted in, the stretch
       * sized from the open would grow by its own copy time.
       */
      waitedBefore(until) {
        return waits.reduce((sum, wait) => sum + Math.max(0, Math.min(wait.to ?? until, until) - wait.from), 0);
      },
      lengthOf: fileIndex => held.get(fileIndex)?.source.input.fileLength ?? null,
      reads: () => ({ ...reads, answers: describeAnswers(answers) }),
      noteAnswer(answer) {
        if (!released) answers.push({ ...answer, at: Date.now() });
      },
      /** Packet learning can finish after the FFmpeg run that supplied it. */
      retain() {
        if (released || runReleased) return null;
        owners++;
        let dropped = false;
        return () => { if (!dropped) { dropped = true; drop(); } };
      },
      release() {
        if (!runReleased) { runReleased = true; drop(); }
        return closed;
      }
    };
  } finally {
    if (!retained) releaseBudget();
  }
}

/** The bytes an original input of these sources holds once copied. */
export function originalInputBytes(sources) {
  return sources.reduce((total, source) => total + source.input.ranges
    .reduce((sum, [start, end]) => sum + end - start + 1, 0), 0);
}

/**
 * The shape of FFmpeg's reads of one input, from the answers it was sent:
 * how much was handed to the system (at most what FFmpeg read), how many
 * connections closed before all of an answer was handed over, what share began
 * at or after the end of the previous one (a forward read), the largest jump
 * back, and the bytes written again that an earlier answer had already
 * written. Per file, since two files are read independently.
 *
 * @param {{ fileIndex: number, start: number, end: number, written: number, handedOver: boolean, at: number }[]} answers
 * @returns {{ count: number, written: number, unfinished: number, forwardShare: number | null, largestBackBytes: number, rewritten: number, list: object[] }}
 */
export function describeAnswers(answers) {
  let written = 0, unfinished = 0, forward = 0, largestBackBytes = 0, rewritten = 0;
  const reachedOf = new Map();
  const coveredOf = new Map();
  for (const answer of answers) {
    written += answer.written;
    if (!answer.handedOver) unfinished += 1;
    const reached = reachedOf.get(answer.fileIndex);
    if (reached === undefined || answer.start >= reached) forward += 1;
    else largestBackBytes = Math.max(largestBackBytes, reached - answer.start);
    // Bytes actually taken by this answer, as a range from its start.
    const takenEnd = answer.start + Math.max(0, answer.written) - 1;
    const covered = coveredOf.get(answer.fileIndex) ?? [];
    for (const [from, to] of covered) {
      const overlap = Math.min(to, takenEnd) - Math.max(from, answer.start) + 1;
      if (overlap > 0) rewritten += overlap;
    }
    if (takenEnd >= answer.start) covered.push([answer.start, takenEnd]);
    coveredOf.set(answer.fileIndex, covered);
    reachedOf.set(answer.fileIndex, Math.max(reached ?? 0, takenEnd + 1));
  }
  return { count: answers.length, written, unfinished,
    forwardShare: answers.length ? forward / answers.length : null, largestBackBytes, rewritten, list: answers };
}
