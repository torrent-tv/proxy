import { createHash } from "node:crypto";

/** Retain complete original byte ranges under the encoder's input allowance.
 * The available-only reader acquires complete pieces atomically before copying;
 * owned buffers then outlive torrent eviction without keeping duplicate pins.
 */
export async function admitOriginalInput({ sources, reserve, readRanges }) {
  const bytes = sources.reduce((total, source) => total + source.input.ranges
    .reduce((sum, [start, end]) => sum + end - start + 1, 0), 0);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new TypeError("Original input requires complete finite byte ranges.");
  const releaseBudget = await reserve(bytes);
  if (typeof releaseBudget !== "function") return releaseBudget?.kind === "terminal" ? releaseBudget : { kind: "needs-memory", bytes };
  const held = new Map();
  const hash = createHash("sha256");
  let retained = false;
  try {
    for (const source of sources) {
      const buffers = await readRanges(source, source.input.ranges, bytes);
      if (buffers === null) return { kind: "needs-bytes", sourceKey: source.sourceKey, fileIndex: source.fileIndex, ranges: source.input.ranges };
      if (!Array.isArray(buffers) || buffers.length !== source.input.ranges.length || buffers.some((buffer, index) =>
        !Buffer.isBuffer(buffer) || buffer.length !== source.input.ranges[index][1] - source.input.ranges[index][0] + 1)) {
        throw new Error("Original input reader returned incomplete ranges.");
      }
      hash.update(JSON.stringify([source.sourceKey, source.fileIndex, source.input.ranges, source.input.selections]));
      for (const buffer of buffers) hash.update(buffer);
      held.set(source.fileIndex, { source, buffers });
    }
    let released = false;
    retained = true;
    return {
      kind: "result", original: true, sources, bytes, fingerprint: hash.digest("hex"),
      tracks: sources.flatMap(source => (source.input.selections ?? []).map(selection => ({ track: selection.track,
        ...(Number.isFinite(source.input.sourceEnds?.[selection.track.trackNumber]) ? {
          sourceEndSeconds: source.input.sourceEnds[selection.track.trackNumber] - source.timeShiftSeconds
        } : {}) }))),
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
        return { length: fileLength, end: stop, bytes: entry.buffers[position].subarray(start - ranges[position][0], stop - ranges[position][0] + 1) };
      },
      lengthOf: fileIndex => held.get(fileIndex)?.source.input.fileLength ?? null,
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
