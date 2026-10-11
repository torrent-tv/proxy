import { createHash } from "node:crypto";

/** Retain complete original byte ranges under the encoder's input allowance.
 * The available-only reader acquires complete pieces atomically before copying;
 * owned buffers then outlive torrent eviction without keeping duplicate pins.
 */
export async function admitOriginalInput({ sources, reserve, readRanges, now = Date.now }) {
  const bytes = originalInputBytes(sources);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new TypeError("Original input requires complete finite byte ranges.");
  const releaseBudget = await reserve(bytes);
  if (typeof releaseBudget !== "function") return releaseBudget?.kind === "terminal" ? releaseBudget : { kind: "needs-memory", bytes };
  const held = new Map();
  const hash = createHash("sha256");
  let retained = false;
  // How long the copy itself took, apart from any wait for memory or bytes
  // before it: the figure a run's stretch is sized from, read where the copy is.
  let copyMs = 0;
  try {
    for (const source of sources) {
      const startedAt = now();
      const buffers = await readRanges(source, source.input.ranges, bytes);
      copyMs += Math.max(0, now() - startedAt);
      if (buffers === null) return { kind: "needs-bytes", sourceKey: source.sourceKey, fileIndex: source.fileIndex, ranges: source.input.ranges };
      if (!Array.isArray(buffers) || buffers.length !== source.input.ranges.length || buffers.some((buffer, index) =>
        !Buffer.isBuffer(buffer) || buffer.length !== source.input.ranges[index][1] - source.input.ranges[index][0] + 1)) {
        throw new Error("Original input reader returned incomplete ranges.");
      }
      // THE INPUT IS NAMED BY WHAT IT IS, NOT BY ITS BYTES. Every source is a
      // torrent whose pieces are verified before they are stored, and a read
      // gives every byte or none, so the same source, file, ranges and
      // selections are the same bytes. Hashing the bytes as well took 13.45 s
      // of 180 s of the main thread on a Matroska film whose picture and sound
      // copy the same ~30 MB a piece (torrent-tv/meta#178).
      hash.update(JSON.stringify([source.sourceKey, source.fileIndex, source.input.ranges, source.input.selections]));
      held.set(source.fileIndex, { source, buffers });
    }
    let released = false;
    retained = true;
    // What FFmpeg asked of this input, for the run's own account of where its
    // time went: field 2026-10-08, a run took 6-9 s for a piece FFmpeg makes in
    // 1.6 s from a file, and nothing said whether it was waiting on its input.
    const reads = { count: 0, bytes: 0, firstAt: 0, lastAt: 0 };
    // Each answer FFmpeg was sent, in order: where it began, where its range
    // ended, what was handed to the system before the connection closed, and
    // whether all of it was (torrent-tv/meta#177).
    /** @type {{ fileIndex: number, start: number, end: number, written: number, handedOver: boolean, at: number }[]} */
    const answers = [];
    return {
      kind: "result", original: true, sources, bytes, copyMs, fingerprint: hash.digest("hex"),
      // No track's own end: the container names the bytes an interval needs,
      // not where each track stops. The final piece is judged by the input
      // reaching the end of the file instead (`piece-completeness.js`).
      tracks: sources.flatMap(source => (source.input.selections ?? []).map(selection => ({ track: selection.track }))),
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
        const now = Date.now();
        reads.count += 1;
        reads.bytes += stop - start + 1;
        reads.firstAt ||= now;
        reads.lastAt = now;
        return { length: fileLength, end: stop, bytes: entry.buffers[position].subarray(start - ranges[position][0], stop - ranges[position][0] + 1) };
      },
      lengthOf: fileIndex => held.get(fileIndex)?.source.input.fileLength ?? null,
      reads: () => ({ ...reads, answers: describeAnswers(answers) }),
      noteAnswer(answer) {
        if (!released) answers.push({ ...answer, at: Date.now() });
      },
      release() {
        if (released) return;
        released = true;
        held.clear();
        releaseBudget();
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
