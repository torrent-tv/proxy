/** OpenDML indexes address stream payloads directly, including later RIFF AVIX forms. */
export async function* openDmlPackets({ readRange, fileSize, indexes, streamId }) {
  const seen = new Set();
  for (const chunk of indexes) yield* entries(chunk, false);

  async function* entries(chunk, child) {
    if (seen.has(chunk.start)) throw new Error("AVI OpenDML repeats an index address.");
    seen.add(chunk.start);
    if (chunk.start < 0 || chunk.end > fileSize || chunk.end - chunk.start < 24) throw new Error("AVI OpenDML index header is truncated.");
    const header = await readRange(chunk.start, chunk.start + 23);
    const words = header.readUInt16LE(), subtype = header[2], type = header[3];
    const count = header.readUInt32LE(4), chunkId = header.toString("ascii", 8, 12);
    if (!/^[0-9]{2}(db|dc|wb)$/.test(chunkId) || Number(chunkId.slice(0, 2)) !== streamId) throw new Error("AVI OpenDML index refers to another stream.");
    const entryBytes = words * 4;
    if (!entryBytes || count > Math.floor((chunk.end - chunk.start - 24) / entryBytes)) throw new Error("AVI OpenDML index entry count exceeds its chunk.");
    if (type === 0) {
      if (child || words !== 4 || subtype !== 0) throw new Error("AVI OpenDML super index structure is invalid.");
      for (let at = 0; at < count; at++) {
        const entry = await readRange(chunk.start + 24 + at * 16, chunk.start + 39 + at * 16);
        const offset = safeOffset(entry.readBigUInt64LE()), size = entry.readUInt32LE(8);
        if (!offset && !size) continue;
        if (size < 32 || offset + size > fileSize) throw new Error("AVI OpenDML child index exceeds the file.");
        const prefix = await readRange(offset, offset + 7);
        if (!/^ix[0-9]{2}$/.test(prefix.toString("ascii", 0, 4)) || prefix.readUInt32LE(4) + 8 !== size) throw new Error("AVI OpenDML child index size disagrees with its header.");
        yield* entries({ start: offset + 8, end: offset + size }, true);
      }
      return;
    }
    if (type !== 1 || !((subtype === 0 && words === 2) || (subtype === 1 && words === 3))) throw new Error("AVI OpenDML standard index structure is invalid.");
    const base = safeOffset(header.readBigUInt64LE(12));
    for (let at = 0; at < count; at++) {
      const entry = await readRange(chunk.start + 24 + at * entryBytes, chunk.start + 23 + (at + 1) * entryBytes);
      const start = base + entry.readUInt32LE(), encodedSize = entry.readUInt32LE(4), length = encodedSize & 0x7fffffff;
      if (!Number.isSafeInteger(start) || start < 8 || start + length > fileSize) throw new Error("AVI OpenDML packet exceeds the file.");
      if (subtype === 1 && entry.readUInt32LE(8) >= length) throw new Error("AVI OpenDML second field exceeds its frame.");
      if (!length) { yield { chunkId, start, length, keyframe: false }; continue; }
      const prefix = await readRange(start - 8, start - 1);
      if (prefix.toString("ascii", 0, 4) !== chunkId || prefix.readUInt32LE(4) !== length) throw new Error("AVI OpenDML packet disagrees with its chunk header.");
      yield { chunkId, start, length, keyframe: !(encodedSize & 0x80000000) };
    }
  }
}

function safeOffset(value) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("AVI OpenDML address exceeds exact integer precision.");
  return Number(value);
}
