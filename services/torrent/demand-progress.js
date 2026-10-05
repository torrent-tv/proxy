/** Count exact wanted bytes and their available residence without a read window. */
export function demandProgress({ windows, file, pieceLength, locationOf }) {
  if (!Number.isSafeInteger(pieceLength) || pieceLength <= 0 || typeof locationOf !== "function") return null;
  const ordered = windows.map(window => [Math.max(0, window.byteStart), Math.min(file.length - 1, window.byteEnd)])
    .filter(([from, to]) => to >= from).sort((left, right) => left[0] - right[0]);
  const ranges = [];
  for (const range of ordered) {
    const previous = ranges.at(-1);
    if (previous && range[0] <= previous[1] + 1) previous[1] = Math.max(previous[1], range[1]);
    else ranges.push(range);
  }
  if (!ranges.length) return null;
  let totalBytes = 0, downloadedBytes = 0;
  for (const [from, to] of ranges) {
    totalBytes += to - from + 1;
    const first = Math.floor((file.offset + from) / pieceLength), last = Math.floor((file.offset + to) / pieceLength);
    for (let index = first; index <= last; index++) {
      if (locationOf(index) === "missing") continue;
      const start = Math.max(from, index * pieceLength - file.offset);
      const end = Math.min(to, (index + 1) * pieceLength - file.offset - 1);
      downloadedBytes += end - start + 1;
    }
  }
  return { totalBytes, downloadedBytes };
}
