export function parseRange(rangeHeader, fileLength) {
  if (!rangeHeader || !rangeHeader.startsWith("bytes=")) {
    return null;
  }
  const [startRaw, endRaw] = rangeHeader.slice("bytes=".length).split("-");
  const start = startRaw.length > 0 ? Number(startRaw) : 0;
  const end = endRaw && endRaw.length > 0 ? Number(endRaw) : fileLength - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    return null;
  }
  return { start, end: Math.min(end, fileLength - 1) };
}
