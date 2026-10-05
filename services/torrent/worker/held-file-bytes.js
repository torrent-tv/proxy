import { readHeldBytes } from "./held-bytes.js";

/** Whole-file assembly reads held storage pieces without creating download demand. */
export async function* heldFileBytes(torrent, fileIndex) {
  const file = torrent?.files?.[fileIndex];
  const pieceLength = Number(torrent?.pieceLength), offset = Number(file?.offset) || 0;
  if (!file || !Number.isSafeInteger(file.length) || file.length <= 0 || !Number.isSafeInteger(pieceLength) || pieceLength <= 0) {
    throw new Error("Whole-file assembly requires a declared file and piece length.");
  }
  for (let start = 0; start < file.length;) {
    const end = Math.min(file.length - 1, (Math.floor((offset + start) / pieceLength) + 1) * pieceLength - offset - 1);
    const bytes = await readHeldBytes(torrent, fileIndex, start, end);
    if (!bytes) throw new Error(`Whole-file assembly lost held bytes ${start}-${end} of file ${fileIndex}.`);
    yield bytes;
    start = end + 1;
  }
}
