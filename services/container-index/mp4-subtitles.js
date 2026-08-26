/**
 * @file The text subtitle tracks of an MP4, and where each cue's bytes are.
 *
 * The same rule as the Matroska side: nothing is extracted with ffmpeg and
 * nothing is fetched for its own sake. Here it is cheaper still. Matroska hides
 * its subtitle blocks inside clusters shared with the picture, so a cue costs
 * whatever cluster holds it; an MP4 states every sample's offset and length in
 * the sample table, so a cue costs its own bytes and nothing more — usually a
 * few dozen of them.
 *
 * The tables, from ISO/IEC 14496-12:
 *
 *   stsd — what the samples are (`tx3g` timed text, `wvtt` WebVTT, `stpp` TTML)
 *   stts — how long each sample lasts, run-length encoded (§8.6.1.2)
 *   stsz — how long each sample is, in bytes (§8.7.3)
 *   stsc — how samples are grouped into chunks (§8.7.4)
 *   stco / co64 — where each chunk begins in the file (§8.7.5)
 *
 * Together they give, for sample N: when it starts, how long it stays, and the
 * exact byte range holding it. That is everything needed to show a cue without
 * reading anything else.
 */

const HEADER_BYTES = 8;
const LARGE_SIZE_MARKER = 1;
const LARGE_HEADER_BYTES = 16;
const PROBE_BYTES = 64;
const MAX_MOOV_BYTES = 32 * 1024 * 1024;

/** Handlers that mean "this track is text on screen". */
const TEXT_HANDLERS = new Set(["text", "sbtl", "subt"]);
/**
 * Every handler ffmpeg's mov demuxer turns into a SUBTITLE stream, whether or
 * not this file can read it — `subp` is a DVD subpicture and `clcp` closed
 * captions, both pictures or caption data rather than text. They are counted
 * because `declaredIndex` has to equal ffmpeg's `0:s:N`, and a track left out
 * of the count shifts every text track after it, which is the very defect
 * `declaredIndex` exists to remove.
 */
const SUBTITLE_HANDLERS = new Set([...TEXT_HANDLERS, "subp", "clcp"]);
/** Sample formats this can turn into cues. `stpp` (TTML) is XML and is not one. */
const TEXT_FORMATS = new Set(["tx3g", "text", "wvtt"]);

/**
 * One box header at `offset`, or null when the bytes do not hold one.
 *
 * @param {Buffer} buffer
 * @param {number} offset
 * @returns {{ type: string, size: number, dataOffset: number, end: number } | null}
 */
function readBox(buffer, offset) {
  if (offset + HEADER_BYTES > buffer.length) {
    return null;
  }
  let size = buffer.readUInt32BE(offset);
  const type = buffer.toString("latin1", offset + 4, offset + 8);
  let headerBytes = HEADER_BYTES;
  if (size === LARGE_SIZE_MARKER) {
    if (offset + LARGE_HEADER_BYTES > buffer.length) {
      return null;
    }
    size = Number(buffer.readBigUInt64BE(offset + 8));
    headerBytes = LARGE_HEADER_BYTES;
  }
  if (size < headerBytes) {
    return null;
  }
  return { type, size, dataOffset: offset + headerBytes, end: offset + size };
}

/**
 * Every direct child of a range with the given type.
 *
 * @param {Buffer} buffer
 * @param {number} start
 * @param {number} end
 * @param {string} type
 * @returns {{ type: string, size: number, dataOffset: number, end: number }[]}
 */
function childrenOf(buffer, start, end, type) {
  const found = [];
  let at = start;
  while (at < end) {
    const box = readBox(buffer, at);
    if (!box) {
      break;
    }
    if (box.type === type) {
      found.push(box);
    }
    at = box.end;
  }
  return found;
}

/**
 * The first child of a range with the given type, or null.
 *
 * @param {Buffer} buffer
 * @param {number} start
 * @param {number} end
 * @param {string} type
 * @returns {{ type: string, size: number, dataOffset: number, end: number } | null}
 */
function childOf(buffer, start, end, type) {
  return childrenOf(buffer, start, end, type)[0] ?? null;
}

/**
 * Walk the top level of the file to find `moov`, reading only box headers.
 *
 * @param {(start: number, end: number) => Promise<Buffer | null>} readRange
 * @param {number} fileSize
 * @returns {Promise<{ offset: number, size: number } | null>}
 */
async function findMoov(readRange, fileSize) {
  let at = 0;
  while (at < fileSize) {
    const probe = await readRange(at, Math.min(fileSize - 1, at + PROBE_BYTES - 1));
    if (!probe || probe.length < HEADER_BYTES) {
      return null;
    }
    const box = readBox(probe, 0);
    if (!box) {
      return null;
    }
    if (box.type === "moov") {
      return { offset: at, size: box.size };
    }
    at += box.size;
  }
  return null;
}

/**
 * Sample durations, expanded from the run-length table.
 *
 * @param {Buffer} moov
 * @param {{ dataOffset: number, end: number }} stts
 * @param {number} total - How many samples the size table declares.
 * @returns {number[]} Ticks each sample lasts.
 */
function sampleDurations(moov, stts, total) {
  const durations = new Array(total).fill(0);
  const entries = moov.readUInt32BE(stts.dataOffset + 4);
  let at = stts.dataOffset + 8;
  let sample = 0;
  for (let entry = 0; entry < entries && at + 8 <= stts.end && sample < total; entry += 1, at += 8) {
    const count = moov.readUInt32BE(at);
    const delta = moov.readUInt32BE(at + 4);
    for (let index = 0; index < count && sample < total; index += 1, sample += 1) {
      durations[sample] = delta;
    }
  }
  return durations;
}

/**
 * Sample sizes, whether the table states one for all or one for each.
 *
 * @param {Buffer} moov
 * @param {{ dataOffset: number, end: number }} stsz
 * @returns {number[]}
 */
function sampleSizes(moov, stsz) {
  const uniform = moov.readUInt32BE(stsz.dataOffset + 4);
  const count = moov.readUInt32BE(stsz.dataOffset + 8);
  if (uniform > 0) {
    return new Array(count).fill(uniform);
  }
  const sizes = new Array(count).fill(0);
  let at = stsz.dataOffset + 12;
  for (let index = 0; index < count && at + 4 <= stsz.end; index += 1, at += 4) {
    sizes[index] = moov.readUInt32BE(at);
  }
  return sizes;
}

/**
 * Where every sample of a track begins in the file.
 *
 * The sample-to-chunk table says how many samples each run of chunks holds, and
 * the chunk-offset table says where each chunk starts; a sample's own offset is
 * its chunk's start plus the sizes of the samples before it in that chunk.
 *
 * @param {Buffer} moov
 * @param {{ dataOffset: number, end: number }} stsc
 * @param {number[]} chunkOffsets
 * @param {number[]} sizes
 * @returns {number[]}
 */
function sampleOffsets(moov, stsc, chunkOffsets, sizes) {
  const offsets = new Array(sizes.length).fill(0);
  const entries = moov.readUInt32BE(stsc.dataOffset + 4);
  /** @type {{ firstChunk: number, perChunk: number }[]} */
  const runs = [];
  let at = stsc.dataOffset + 8;
  for (let entry = 0; entry < entries && at + 12 <= stsc.end; entry += 1, at += 12) {
    runs.push({ firstChunk: moov.readUInt32BE(at), perChunk: moov.readUInt32BE(at + 4) });
  }
  let sample = 0;
  for (let run = 0; run < runs.length && sample < sizes.length; run += 1) {
    const from = runs[run].firstChunk;
    const to = run + 1 < runs.length ? runs[run + 1].firstChunk - 1 : chunkOffsets.length;
    for (let chunk = from; chunk <= to && sample < sizes.length; chunk += 1) {
      let inChunk = chunkOffsets[chunk - 1];
      if (inChunk === undefined) {
        break;
      }
      for (let index = 0; index < runs[run].perChunk && sample < sizes.length; index += 1, sample += 1) {
        offsets[sample] = inChunk;
        inChunk += sizes[sample];
      }
    }
  }
  return offsets;
}

/**
 * @typedef {object} Mp4SubtitleSample
 * @property {number} startSeconds
 * @property {number} endSeconds
 * @property {number} offset - Where the sample's bytes are in the file.
 * @property {number} size
 */

/**
 * @typedef {object} Mp4SubtitleTrack
 * @property {number} trackId
 * @property {number} declaredIndex - Its position among ALL of the file's
 *   subtitle tracks, including the ones whose sample format this cannot turn
 *   into cues (`stpp` TTML). That is the number ffmpeg gives the same stream in
 *   `0:s:N`, which is the number the browser names; counting only the readable
 *   ones would shift every track after a TTML one.
 * @property {string} format - `tx3g`, `text` or `wvtt`.
 * @property {string} language - Three letters, as the file declares them.
 * @property {Mp4SubtitleSample[]} samples - In time order.
 */

/**
 * The text subtitle tracks of an MP4, with every cue's time and byte range.
 *
 * @param {(start: number, end: number) => Promise<Buffer | null>} readRange
 * @param {number} fileSize
 * @returns {Promise<{ tracks: Mp4SubtitleTrack[] } | null>}
 */
export async function readMp4SubtitlePlan(readRange, fileSize) {
  const found = await findMoov(readRange, fileSize);
  if (!found || found.size > MAX_MOOV_BYTES) {
    return null;
  }
  const moov = await readRange(found.offset, Math.min(fileSize - 1, found.offset + found.size - 1));
  if (!moov || moov.length < HEADER_BYTES) {
    return null;
  }
  const moovBox = readBox(moov, 0);
  if (!moovBox) {
    return null;
  }

  /** @type {Mp4SubtitleTrack[]} */
  const tracks = [];
  // Counts every subtitle track the file has, whether or not this can read it,
  // so the number handed out matches ffmpeg's `0:s:N`. See `declaredIndex`.
  let declaredIndex = -1;
  for (const trak of childrenOf(moov, moovBox.dataOffset, moov.length, "trak")) {
    const mdia = childOf(moov, trak.dataOffset, trak.end, "mdia");
    if (!mdia) {
      continue;
    }
    const hdlr = childOf(moov, mdia.dataOffset, mdia.end, "hdlr");
    const handler = hdlr ? moov.toString("latin1", hdlr.dataOffset + 8, hdlr.dataOffset + 12) : "";
    if (!SUBTITLE_HANDLERS.has(handler)) {
      continue;
    }
    // Counted before the readability checks below, and before the handler is
    // narrowed to the text ones: this number is the track's place in the file,
    // not its place among the tracks this code can turn into cues.
    declaredIndex += 1;
    if (!TEXT_HANDLERS.has(handler)) {
      continue;
    }
    const mdhd = childOf(moov, mdia.dataOffset, mdia.end, "mdhd");
    if (!mdhd) {
      continue;
    }
    const version = moov[mdhd.dataOffset];
    const timescale = moov.readUInt32BE(version === 1 ? mdhd.dataOffset + 20 : mdhd.dataOffset + 12);
    if (!timescale) {
      continue;
    }
    // The language is five bits per letter, offset from 0x60, packed into two
    // bytes after the times (ISO/IEC 14496-12 §8.4.2.3).
    const languageAt = version === 1 ? mdhd.dataOffset + 32 : mdhd.dataOffset + 20;
    let language = "";
    if (languageAt + 2 <= mdhd.end) {
      const packed = moov.readUInt16BE(languageAt);
      language = [10, 5, 0]
        .map((shift) => String.fromCharCode(((packed >> shift) & 0x1f) + 0x60))
        .join("")
        .replace(/[^a-z]/g, "");
    }

    const tkhd = childOf(moov, trak.dataOffset, trak.end, "tkhd");
    const trackId = tkhd
      ? moov.readUInt32BE(moov[tkhd.dataOffset] === 1 ? tkhd.dataOffset + 20 : tkhd.dataOffset + 12)
      : tracks.length + 1;

    const minf = childOf(moov, mdia.dataOffset, mdia.end, "minf");
    const stbl = minf && childOf(moov, minf.dataOffset, minf.end, "stbl");
    if (!stbl) {
      continue;
    }
    const stsd = childOf(moov, stbl.dataOffset, stbl.end, "stsd");
    const first = stsd && readBox(moov, stsd.dataOffset + 8);
    const format = first ? first.type : "";
    if (!TEXT_FORMATS.has(format)) {
      continue;
    }
    const stts = childOf(moov, stbl.dataOffset, stbl.end, "stts");
    const stsz = childOf(moov, stbl.dataOffset, stbl.end, "stsz");
    const stsc = childOf(moov, stbl.dataOffset, stbl.end, "stsc");
    const stco = childOf(moov, stbl.dataOffset, stbl.end, "stco");
    const co64 = childOf(moov, stbl.dataOffset, stbl.end, "co64");
    if (!stts || !stsz || !stsc || (!stco && !co64)) {
      continue;
    }

    const sizes = sampleSizes(moov, stsz);
    const durations = sampleDurations(moov, stts, sizes.length);
    const chunkOffsets = [];
    if (stco) {
      const count = moov.readUInt32BE(stco.dataOffset + 4);
      let at = stco.dataOffset + 8;
      for (let index = 0; index < count && at + 4 <= stco.end; index += 1, at += 4) {
        chunkOffsets.push(moov.readUInt32BE(at));
      }
    } else {
      const count = moov.readUInt32BE(co64.dataOffset + 4);
      let at = co64.dataOffset + 8;
      for (let index = 0; index < count && at + 8 <= co64.end; index += 1, at += 8) {
        chunkOffsets.push(Number(moov.readBigUInt64BE(at)));
      }
    }
    const offsets = sampleOffsets(moov, stsc, chunkOffsets, sizes);

    /** @type {Mp4SubtitleSample[]} */
    const samples = [];
    let ticks = 0;
    for (let index = 0; index < sizes.length; index += 1) {
      const start = ticks / timescale;
      ticks += durations[index];
      // An empty sample is a gap between cues, which the format uses to say
      // "nothing on screen"; it is not a cue and would show as a blank line.
      if (sizes[index] > 2) {
        samples.push({
          startSeconds: start,
          endSeconds: ticks / timescale,
          offset: offsets[index],
          size: sizes[index]
        });
      }
    }
    tracks.push({ trackId, declaredIndex, format, language, samples });
  }
  return { tracks };
}

/**
 * The text of one sample.
 *
 * `tx3g` is a two-byte length followed by UTF-8; anything after that is styling
 * boxes, which this deliberately drops. `wvtt` is a sequence of boxes, and the
 * text lives in the `payl` inside a `vttc`.
 *
 * @param {Buffer} bytes
 * @param {string} format
 * @returns {string}
 */
export function decodeSubtitleSample(bytes, format) {
  if (format === "wvtt") {
    let at = 0;
    const parts = [];
    while (at + HEADER_BYTES <= bytes.length) {
      const box = readBox(bytes, at);
      if (!box) {
        break;
      }
      if (box.type === "vttc") {
        const payl = childOf(bytes, box.dataOffset, Math.min(bytes.length, box.end), "payl");
        if (payl) {
          parts.push(bytes.toString("utf8", payl.dataOffset, Math.min(bytes.length, payl.end)));
        }
      }
      at = box.end;
    }
    return parts.join("\n").trim();
  }
  if (bytes.length < 2) {
    return "";
  }
  const length = bytes.readUInt16BE(0);
  return bytes.toString("utf8", 2, Math.min(bytes.length, 2 + length)).trim();
}
