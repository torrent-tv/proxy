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
function resolveSampleTimes(buffer, stts, timescale, wanted, offsets = null) {
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
        // `CT(n) = DT(n) + CTTS(n)` — ISO/IEC 14496-12 §8.6.1.3. The offset is
        // what turns decode order into the order frames are shown in, and it is
        // the timeline ffmpeg cuts on.
        times.push((ticks + (offsets?.get(sampleNumber) ?? 0)) / timescale);
      }
      ticks += delta;
      sampleNumber += 1;
    }
    cursor += 8;
  }
  return times;
}

/**
 * Composition offsets for the sample numbers asked for.
 *
 * `ctts` is run-length encoded like `stts`, and version 1 carries SIGNED
 * offsets — which is what the version exists for: a frame may be shown before
 * it is decoded. Reading them as unsigned turns a small negative offset into
 * roughly four billion ticks.
 *
 * @param {Buffer} buffer
 * @param {{ dataOffset: number, end: number }} ctts
 * @param {Set<number>} wanted - Sample numbers (1-based).
 * @returns {Map<number, number>} Sample number to offset in media ticks.
 */
function readCompositionOffsets(buffer, ctts, wanted) {
  const version = buffer[ctts.dataOffset];
  const entryCount = buffer.readUInt32BE(ctts.dataOffset + 4);
  const offsets = new Map();
  let sampleNumber = 1;
  let cursor = ctts.dataOffset + 8;
  for (let entry = 0; entry < entryCount && cursor + 8 <= ctts.end; entry += 1) {
    const count = buffer.readUInt32BE(cursor);
    const offset = version === 1 ? buffer.readInt32BE(cursor + 4) : buffer.readUInt32BE(cursor + 4);
    for (let index = 0; index < count; index += 1) {
      if (wanted.has(sampleNumber)) {
        offsets.set(sampleNumber, offset);
      }
      sampleNumber += 1;
    }
    cursor += 8;
  }
  return offsets;
}

/**
 * How far the edit list shifts this track's composition timeline, in media
 * ticks.
 *
 * ISO/IEC 14496-12 §8.6.6.3: `media_time` is the start of the edit within the
 * media, in the MEDIA timescale and in composition time, while
 * `segment_duration` is in the MOVIE timescale — two different units in one
 * structure, which is why only the first is read here. `media_time = -1` is an
 * empty edit: it inserts blank presentation time and starts no media, so the
 * first real edit is the one that matters.
 *
 * Measured 2026-08-19: every LostFilm MP4 that carries a composition offset
 * also carries an edit list cancelling it exactly, which is why decode times
 * have been right on those files. `Firefly.S01E03` has the offset and NO edit
 * list, and its times were 62.1 ms early on all 34 keyframes checked.
 *
 * @param {Buffer} buffer
 * @param {{ dataOffset: number, end: number }} elst
 * @returns {number} Ticks to subtract; zero when nothing is shifted.
 */
function readEditShift(buffer, elst) {
  const version = buffer[elst.dataOffset];
  const entryCount = buffer.readUInt32BE(elst.dataOffset + 4);
  const wide = version === 1;
  const entryBytes = wide ? 20 : 12;
  let cursor = elst.dataOffset + 8;
  for (let entry = 0; entry < entryCount && cursor + entryBytes <= elst.end; entry += 1) {
    const mediaTime = wide
      ? Number(buffer.readBigInt64BE(cursor + 8))
      : buffer.readInt32BE(cursor + 4);
    if (mediaTime >= 0) {
      return mediaTime;
    }
    cursor += entryBytes;
  }
  return 0;
}

/**
 * Whether this track's handler says it carries video.
 *
 * The standard identifies a track by its `hdlr`, and nothing else does. Picking
 * "the first track that happens to carry sync samples" worked only because the
 * seven releases measured all put video first; a file whose audio track carries
 * them, or one that leads with a cover-art video track, would be read from the
 * wrong place. That is the same defect that was fixed in the Matroska reader on
 * 2026-08-18, arrived at from the other side.
 *
 * @param {Buffer} buffer
 * @param {{ dataOffset: number, end: number }} mdia
 * @returns {boolean}
 */
function isVideoTrack(buffer, mdia) {
  const hdlr = findBox(buffer, mdia.dataOffset, mdia.end, "hdlr");
  if (!hdlr || hdlr.dataOffset + 12 > hdlr.end) {
    return false;
  }
  // FullBox header (4) then a reserved pre_defined (4), then the handler type.
  return buffer.toString("latin1", hdlr.dataOffset + 8, hdlr.dataOffset + 12) === "vide";
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

  // Examine every track, and take the one whose HANDLER says it is video. A
  // track with no `stss` has every sample a keyframe, so it constrains nothing
  // and is skipped even when it is the video one.
  for (const trak of findAllBoxes(moov, moovBox.headerBytes, moov.length, "trak")) {
    const mdia = findBox(moov, trak.dataOffset, trak.end, "mdia");
    if (!mdia || !isVideoTrack(moov, mdia)) {
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

    // The two terms that turn decode times into the timeline ffmpeg cuts on.
    // Both are optional: a file without them is one whose decode and
    // composition orders already agree, and then nothing is added or taken.
    const ctts = findBox(moov, stbl.dataOffset, stbl.end, "ctts");
    const offsets = ctts ? readCompositionOffsets(moov, ctts, wanted) : null;
    const edts = findBox(moov, trak.dataOffset, trak.end, "edts");
    const elst = edts && findBox(moov, edts.dataOffset, edts.end, "elst");
    const editShift = elst ? readEditShift(moov, elst) : 0;

    const times = resolveSampleTimes(moov, stts, timescale, wanted, offsets);
    if (times.length > 0) {
      // A shift applied after the division would be in the wrong units: the
      // edit's `media_time` is in MEDIA ticks, like everything else here.
      const shifted = editShift === 0 ? times : times.map((time) => time - editShift / timescale);
      // A negative time is not a position in the file. It happens when an edit
      // starts later than a keyframe the table lists, and those frames are not
      // presented at all.
      return shifted.filter((time) => time >= 0);
    }
  }
  return null;
}
