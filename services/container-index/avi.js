/**
 * @file Keyframe index for AVI, read without downloading the file.
 *
 * AVI ends with an `idx1` chunk: one fixed-size entry per stream chunk, each
 * carrying a flags word whose keyframe bit says whether that chunk starts a
 * keyframe. Frame number times the video stream's frame duration gives the
 * time, so the index alone is enough — no media has to be read.
 *
 * `idx1` lives at the end of the file and the top-level chunk headers state
 * their sizes, so it is reached by stepping over headers (typically two hops:
 * `LIST hdrl`, `LIST movi`), not by scanning.
 *
 * Still relevant despite the format's age: older releases are largely XviD in
 * AVI, and those are exactly the files that get copied rather than re-encoded.
 */

const HEADER_BYTES = 8;
const PROBE_BYTES = 4096;
// Keyframe flag in an idx1 entry's flags word (AVIIF_KEYFRAME).
const KEYFRAME_FLAG = 0x10;
const IDX1_ENTRY_BYTES = 16;
// Cap on the idx1 read. One entry per chunk, 16 bytes each — a long film runs
// to a few MB; beyond this is not a normal index.
const MAX_IDX1_BYTES = 64 * 1024 * 1024;

/**
 * Whether this looks like AVI: a RIFF container whose form type is `AVI `.
 *
 * @param {Buffer} head
 * @returns {boolean}
 */
export function isAvi(head) {
  return (
    head.length >= 12 &&
    head.toString("latin1", 0, 4) === "RIFF" &&
    head.toString("latin1", 8, 12) === "AVI "
  );
}

/**
 * Microseconds per frame and the video stream's chunk id prefix, from the main
 * header. Both live in the `hdrl` list near the file start.
 *
 * @param {Buffer} head
 * @returns {{ microsecondsPerFrame: number } | null}
 */
function readMainHeader(head) {
  // Top-level: "RIFF" size "AVI " then chunks. `avih` sits inside `LIST hdrl`.
  let offset = 12;
  while (offset + HEADER_BYTES <= head.length) {
    const id = head.toString("latin1", offset, offset + 4);
    const size = head.readUInt32LE(offset + 4);
    if (size <= 0) {
      return null;
    }
    if (id === "LIST") {
      // Descend: list type follows the header, then its own chunks.
      const listType = head.toString("latin1", offset + 8, offset + 12);
      if (listType === "hdrl") {
        let inner = offset + 12;
        while (inner + HEADER_BYTES <= Math.min(head.length, offset + 8 + size)) {
          const innerId = head.toString("latin1", inner, inner + 4);
          const innerSize = head.readUInt32LE(inner + 4);
          if (innerSize <= 0) {
            return null;
          }
          if (innerId === "avih" && inner + 8 + 4 <= head.length) {
            return { microsecondsPerFrame: head.readUInt32LE(inner + 8) };
          }
          inner += HEADER_BYTES + innerSize + (innerSize % 2);
        }
      }
      offset += HEADER_BYTES + 4 + (size - 4) + ((size - 4) % 2);
      continue;
    }
    offset += HEADER_BYTES + size + (size % 2);
  }
  return null;
}

/**
 * Step over top-level chunks to find `idx1`.
 *
 * @param {(start: number, end: number) => Promise<Buffer | null>} readRange
 * @param {number} fileSize
 * @returns {Promise<{ offset: number, size: number } | null>}
 */
async function findIdx1(readRange, fileSize) {
  let offset = 12; // Past "RIFF" size "AVI ".
  while (offset + HEADER_BYTES < fileSize) {
    const probe = await readRange(offset, Math.min(fileSize - 1, offset + HEADER_BYTES - 1));
    if (!probe || probe.length < HEADER_BYTES) {
      return null;
    }
    const id = probe.toString("latin1", 0, 4);
    const size = probe.readUInt32LE(4);
    if (size <= 0) {
      return null;
    }
    if (id === "idx1") {
      return { offset: offset + HEADER_BYTES, size };
    }
    // Chunks are word-aligned; a LIST carries its type inside the payload, so
    // the same size arithmetic covers both cases.
    offset += HEADER_BYTES + size + (size % 2);
  }
  return null;
}

/**
 * Read the keyframe times of an AVI file.
 *
 * @param {(start: number, end: number) => Promise<Buffer | null>} readRange
 * @param {number} fileSize
 * @returns {Promise<number[] | null>} Ascending seconds, or null when the file
 *   has no `idx1` (OpenDML-only index, interrupted write, damaged upload).
 */
export async function readAviKeyframeTimes(readRange, fileSize) {
  const head = await readRange(0, Math.min(PROBE_BYTES - 1, fileSize - 1));
  if (!head || !isAvi(head)) {
    return null;
  }
  const mainHeader = readMainHeader(head);
  if (!mainHeader || !mainHeader.microsecondsPerFrame) {
    return null;
  }

  const idx1 = await findIdx1(readRange, fileSize);
  if (!idx1 || idx1.size > MAX_IDX1_BYTES) {
    return null;
  }

  const table = await readRange(idx1.offset, Math.min(fileSize - 1, idx1.offset + idx1.size - 1));
  if (!table || table.length < IDX1_ENTRY_BYTES) {
    return null;
  }

  const secondsPerFrame = mainHeader.microsecondsPerFrame / 1e6;
  const times = [];
  let videoFrame = 0;
  for (let at = 0; at + IDX1_ENTRY_BYTES <= table.length; at += IDX1_ENTRY_BYTES) {
    const chunkId = table.toString("latin1", at, at + 4);
    // Video chunks are "##db" (uncompressed) or "##dc" (compressed); audio is
    // "##wb" and must not advance the frame counter.
    const isVideo = chunkId.endsWith("db") || chunkId.endsWith("dc");
    if (!isVideo) {
      continue;
    }
    const flags = table.readUInt32LE(at + 4);
    if ((flags & KEYFRAME_FLAG) !== 0) {
      times.push(videoFrame * secondsPerFrame);
    }
    videoFrame += 1;
  }
  if (times.length === 0) {
    return null;
  }
  // AVI names a keyframe by its FRAME NUMBER, and the time above is that number
  // multiplied by the frame duration the header declares. The frames are the
  // right ones — measured 2026-08-21 against the files themselves, 1196 index
  // entries against 1196 real keyframes and 901 against 901, exactly — but the
  // names are 10-44 ms away from the presentation times the demuxer computes,
  // always under one frame. So the caller is told how far a time here may be
  // from the instant it refers to, and can ask for a seek late enough that it
  // still lands on the frame rather than on the one before it.
  return { times, tolerance: secondsPerFrame };
}
