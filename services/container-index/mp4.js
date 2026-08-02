/**
 * @file Keyframe index for MP4/MOV, read without downloading the file.
 *
 * MP4 keeps its tables in a `moov` box: `stss` lists which samples are sync
 * samples (keyframes) by number, and `stts` gives each sample's duration, so
 * the two together turn "sample #N" into "second T". `moov` sits either at the
 * start (files written for streaming) or at the end (the common case for a
 * plain mux); box headers state their own size, so it is found by stepping over
 * top-level boxes rather than scanning bytes — a couple of 64-byte reads even
 * when `mdat` is gigabytes.
 *
 * Same purpose as the Matroska reader: on the video-COPY path the segment
 * boundaries ARE the source's keyframes, and inventing an even grid instead
 * makes players walk the whole file or present audio with no picture.
 */

// A 64-bit box size is signalled by a 32-bit size of 1, the real size following
// in the next 8 bytes.
const LARGE_SIZE_MARKER = 1;
const HEADER_BYTES = 8;
const LARGE_HEADER_BYTES = 16;
// Enough to read any box header while walking the top level.
const PROBE_BYTES = 64;
// Cap on the moov read. A feature-length file indexes to a few hundred KB;
// beyond this is not a normal index and not worth pulling over a torrent.
const MAX_MOOV_BYTES = 32 * 1024 * 1024;

/**
 * Whether this looks like MP4/MOV — every real file opens with an `ftyp` box.
 *
 * @param {Buffer} head
 * @returns {boolean}
 */
export function isMp4(head) {
  return head.length >= 12 && head.toString("latin1", 4, 8) === "ftyp";
}

/**
 * Read a box header at `offset`.
 *
 * @param {Buffer} buffer
 * @param {number} offset
 * @returns {{ type: string, size: number, headerBytes: number } | null}
 */
function readBoxHeader(buffer, offset) {
  if (offset + HEADER_BYTES > buffer.length) {
    return null;
  }
  const size32 = buffer.readUInt32BE(offset);
  const type = buffer.toString("latin1", offset + 4, offset + 8);
  if (size32 === LARGE_SIZE_MARKER) {
    if (offset + LARGE_HEADER_BYTES > buffer.length) {
      return null;
    }
    // High word is zero for any file we can practically handle.
    const high = buffer.readUInt32BE(offset + 8);
    const low = buffer.readUInt32BE(offset + 12);
    return { type, size: high * 4294967296 + low, headerBytes: LARGE_HEADER_BYTES };
  }
  return { type, size: size32, headerBytes: HEADER_BYTES };
}

/**
 * Walk the top-level boxes to find `moov`, reading only each box header.
 *
 * @param {(start: number, end: number) => Promise<Buffer | null>} readRange
 * @param {number} fileSize
 * @returns {Promise<{ offset: number, size: number, headerBytes: number } | null>}
 */
async function findMoov(readRange, fileSize) {
  let offset = 0;
  while (offset < fileSize) {
    const probe = await readRange(offset, Math.min(fileSize - 1, offset + PROBE_BYTES - 1));
    if (!probe || probe.length < HEADER_BYTES) {
      return null;
    }
    const header = readBoxHeader(probe, 0);
    // Size 0 means "extends to end of file" — legal only for the last box, and
    // never for one we would step over.
    if (!header || header.size <= 0) {
      return null;
    }
    if (header.type === "moov") {
      return { offset, size: header.size, headerBytes: header.headerBytes };
    }
    offset += header.size;
  }
  return null;
}

/**
 * Find the first box of `type` directly inside a range of an already-read buffer.
 *
 * @param {Buffer} buffer
 * @param {number} start
 * @param {number} end
 * @param {string} type
 * @returns {{ dataOffset: number, end: number } | null}
 */
function findBox(buffer, start, end, type) {
  let offset = start;
  while (offset + HEADER_BYTES <= end) {
    const header = readBoxHeader(buffer, offset);
    if (!header || header.size <= 0) {
      return null;
    }
    if (header.type === type) {
      return { dataOffset: offset + header.headerBytes, end: Math.min(end, offset + header.size) };
    }
    offset += header.size;
  }
  return null;
}

/**
 * All boxes of `type` directly inside a range.
 *
 * @param {Buffer} buffer
 * @param {number} start
 * @param {number} end
 * @param {string} type
 * @returns {{ dataOffset: number, end: number }[]}
 */
function findAllBoxes(buffer, start, end, type) {
  const found = [];
  let offset = start;
  while (offset + HEADER_BYTES <= end) {
    const header = readBoxHeader(buffer, offset);
    if (!header || header.size <= 0) {
      break;
    }
    if (header.type === type) {
      found.push({ dataOffset: offset + header.headerBytes, end: Math.min(end, offset + header.size) });
    }
    offset += header.size;
  }
  return found;
}

/**
 * Turn sample numbers into seconds using the time-to-sample table.
 *
 * `stts` is run-length encoded — pairs of (sample count, per-sample duration) —
 * so one walk yields every sample's start time without expanding the table.
 *
 * @param {Buffer} buffer
 * @param {{ dataOffset: number, end: number }} stts
 * @param {number} timescale - Ticks per second.
 * @param {Set<number>} wanted - Sample numbers (1-based).
 * @returns {number[]} Seconds, ascending.
 */
function resolveSampleTimes(buffer, stts, timescale, wanted) {
  const entryCount = buffer.readUInt32BE(stts.dataOffset + 4);
  const times = [];
  let sampleNumber = 1;
  let ticks = 0;
  let cursor = stts.dataOffset + 8;
  for (let entry = 0; entry < entryCount && cursor + 8 <= stts.end; entry += 1) {
    const count = buffer.readUInt32BE(cursor);
    const delta = buffer.readUInt32BE(cursor + 4);
    for (let index = 0; index < count; index += 1) {
      if (wanted.has(sampleNumber)) {
        times.push(ticks / timescale);
      }
      ticks += delta;
      sampleNumber += 1;
    }
    cursor += 8;
  }
  return times;
}

/**
 * Read the keyframe times of an MP4/MOV file.
 *
 * @param {(start: number, end: number) => Promise<Buffer | null>} readRange
 * @param {number} fileSize
 * @returns {Promise<number[] | null>} Ascending seconds, or null when the file
 *   carries no usable index (fragmented MP4, truncated or damaged `moov`).
 */
export async function readMp4KeyframeTimes(readRange, fileSize) {
  const moovBox = await findMoov(readRange, fileSize);
  if (!moovBox || moovBox.size > MAX_MOOV_BYTES) {
    return null;
  }

  const moov = await readRange(moovBox.offset, Math.min(fileSize - 1, moovBox.offset + moovBox.size - 1));
  if (!moov || moov.length < moovBox.headerBytes) {
    return null;
  }

  // Examine every track; the video one is whichever carries sync samples. A
  // track with no `stss` has every sample a keyframe, so it constrains nothing
  // and is skipped.
  for (const trak of findAllBoxes(moov, moovBox.headerBytes, moov.length, "trak")) {
    const mdia = findBox(moov, trak.dataOffset, trak.end, "mdia");
    if (!mdia) {
      continue;
    }
    const mdhd = findBox(moov, mdia.dataOffset, mdia.end, "mdhd");
    if (!mdhd) {
      continue;
    }
    // mdhd layout: version(1) + flags(3), then creation/modification times —
    // 32-bit each in version 0, 64-bit in version 1 — then the timescale.
    const version = moov[mdhd.dataOffset];
    const timescaleOffset = version === 1 ? mdhd.dataOffset + 20 : mdhd.dataOffset + 12;
    if (timescaleOffset + 4 > mdhd.end) {
      continue;
    }
    const timescale = moov.readUInt32BE(timescaleOffset);
    if (!timescale) {
      continue;
    }

    const minf = findBox(moov, mdia.dataOffset, mdia.end, "minf");
    const stbl = minf && findBox(moov, minf.dataOffset, minf.end, "stbl");
    if (!stbl) {
      continue;
    }
    const stss = findBox(moov, stbl.dataOffset, stbl.end, "stss");
    const stts = findBox(moov, stbl.dataOffset, stbl.end, "stts");
    if (!stss || !stts) {
      continue;
    }

    const syncCount = moov.readUInt32BE(stss.dataOffset + 4);
    const wanted = new Set();
    for (let index = 0; index < syncCount; index += 1) {
      const at = stss.dataOffset + 8 + index * 4;
      if (at + 4 > stss.end) {
        break;
      }
      wanted.add(moov.readUInt32BE(at));
    }
    if (wanted.size === 0) {
      continue;
    }

    const times = resolveSampleTimes(moov, stts, timescale, wanted);
    if (times.length > 0) {
      return times;
    }
  }
  return null;
}
