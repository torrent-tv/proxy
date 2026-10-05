/** All outputs still consumed by this viewer must cover the urgent interval. */
export function urgentOutputsReady({ sourceKey, fileIndex, durationSeconds, atSeconds, seconds,
  outputs, consumed, segmentIndex, segmentStart, closed }) {
  if (!Number.isFinite(durationSeconds) || !(durationSeconds > 0) ||
      !Number.isFinite(atSeconds) || atSeconds < 0 ||
      !Number.isFinite(seconds) || !(seconds > 0)) return false;
  const target = Math.min(durationSeconds, atSeconds + seconds);
  let found = false;
  for (const output of outputs) {
    if (output.file?.sourceKey !== sourceKey || output.file?.fileIndex !== fileIndex || !consumed(output)) continue;
    found = true;
    if (!output.timeline || !output.outputKey) return false;
    let index = segmentIndex(output, atSeconds);
    if (!Number.isSafeInteger(index) || index < 0) return false;
    let start = segmentStart(output, index);
    if (!Number.isFinite(start) || start > atSeconds) return false;
    while (start < target) {
      if (!closed(output.outputKey, index)) return false;
      const next = segmentStart(output, index + 1);
      if (!Number.isFinite(next) || !(next > start)) return false;
      start = next;
      index += 1;
    }
  }
  return found;
}
