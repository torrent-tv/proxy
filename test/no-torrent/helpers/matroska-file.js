/**
 * @file Synthetic Matroska files for the checks — built element by element,
 * so every check states exactly what the file says and where.
 *
 * Positions inside the Segment are known only after the elements before them
 * are built, so a file is described as a list of top-level elements, and the
 * SeekHead and Cues that point at others are built from the lengths of the
 * rest (all positions are fixed-width, so they do not change the lengths they
 * are computed from).
 */

import { crc32 } from "node:zlib";

export const ID = {
  EBML: 0x1a45dfa3,
  SEGMENT: 0x18538067,
  SEEK_HEAD: 0x114d9b74,
  SEEK: 0x4dbb,
  SEEK_ID: 0x53ab,
  SEEK_POSITION: 0x53ac,
  INFO: 0x1549a966,
  TIMESTAMP_SCALE: 0x2ad7b1,
  TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae,
  TRACK_NUMBER: 0xd7,
  TRACK_TYPE: 0x83,
  CODEC_ID: 0x86,
  LANGUAGE: 0x22b59c,
  LANGUAGE_BCP47: 0x22b59d,
  NAME: 0x536e,
  CUES: 0x1c53bb6b,
  CUE_POINT: 0xbb,
  CUE_TIME: 0xb3,
  CUE_TRACK_POSITIONS: 0xb7,
  CUE_TRACK: 0xf7,
  CUE_CLUSTER_POSITION: 0xf1,
  CLUSTER: 0x1f43b675,
  TIMESTAMP: 0xe7,
  CRC32: 0xbf,
  SIMPLE_BLOCK: 0xa3,
  BLOCK_GROUP: 0xa0,
  BLOCK: 0xa1,
  BLOCK_DURATION: 0x9b,
  VOID: 0xec
};

/** @param {number} id @returns {Buffer} */
export function idBytes(id) {
  const bytes = [];
  let rest = id;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  }
  return Buffer.from(bytes);
}

/** A four-byte size: a valid vint whatever the payload. @param {number} size */
function sizeBytes(size) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(size, 0);
  buffer[0] |= 0x10;
  return buffer;
}

/** @param {number} id @param {Buffer} payload @returns {Buffer} */
export function element(id, payload) {
  return Buffer.concat([idBytes(id), sizeBytes(payload.length), payload]);
}

/** An element whose size field says "unknown" (one byte, all value bits set). */
export function unknownSizeElement(id, payload) {
  return Buffer.concat([idBytes(id), Buffer.from([0xff]), payload]);
}

/** @param {number} id @param {number} value */
export function uintElement(id, value) {
  const bytes = [];
  let rest = value;
  do {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  } while (rest > 0);
  return element(id, Buffer.from(bytes));
}

/** A fixed-width unsigned integer, so a position computed twice keeps its length. */
export function uint32Element(id, value) {
  const payload = Buffer.alloc(4);
  payload.writeUInt32BE(value, 0);
  return element(id, payload);
}

/** @param {number} id @param {string} value */
export function stringElement(id, value) {
  return element(id, Buffer.from(value, "utf8"));
}

/**
 * @param {{ number: number, type: number, codecId: string, language?: string | null, languageBcp47?: string, name?: string }} track
 * @returns {Buffer}
 */
export function trackEntry({ number, type, codecId, language = null, languageBcp47 = "", name = "" }) {
  const parts = [uintElement(ID.TRACK_NUMBER, number), uintElement(ID.TRACK_TYPE, type), stringElement(ID.CODEC_ID, codecId)];
  if (language !== null) {
    parts.push(stringElement(ID.LANGUAGE, language));
  }
  if (languageBcp47) {
    parts.push(stringElement(ID.LANGUAGE_BCP47, languageBcp47));
  }
  if (name) {
    parts.push(stringElement(ID.NAME, name));
  }
  return element(ID.TRACK_ENTRY, Buffer.concat(parts));
}

/**
 * One cue, as a BlockGroup carrying its own duration.
 *
 * @param {{ track: number, relativeTicks: number, durationTicks: number, text: string }} params
 */
export function cueBlock({ track, relativeTicks, durationTicks, text }) {
  const header = Buffer.alloc(4);
  header[0] = 0x80 | track;
  header.writeInt16BE(relativeTicks, 1);
  header[3] = 0;
  const block = element(ID.BLOCK, Buffer.concat([header, Buffer.from(text, "utf8")]));
  return element(ID.BLOCK_GROUP, Buffer.concat([block, uintElement(ID.BLOCK_DURATION, durationTicks)]));
}

/**
 * A picture block: a SimpleBlock of `payload` bytes on `track`.
 *
 * @param {{ track: number, payload: Buffer }} params
 */
export function pictureBlock({ track, payload }) {
  const header = Buffer.alloc(4);
  header[0] = 0x80 | track;
  header.writeInt16BE(0, 1);
  header[3] = 0x80;
  return element(ID.SIMPLE_BLOCK, Buffer.concat([header, payload]));
}

/**
 * A cluster's DATA: its Timestamp (optionally after a CRC-32) and its blocks.
 *
 * @param {{ ticks: number, blocks: Buffer[], crc?: boolean | "wrong" }} params
 * @returns {Buffer}
 */
export function clusterData({ ticks, blocks, crc = false }) {
  const rest = Buffer.concat([uintElement(ID.TIMESTAMP, ticks), ...blocks]);
  if (!crc) {
    return rest;
  }
  const value = Buffer.alloc(4);
  value.writeUInt32LE(crc === "wrong" ? (crc32(rest) ^ 0xffffffff) >>> 0 : crc32(rest), 0);
  return Buffer.concat([Buffer.concat([idBytes(ID.CRC32), Buffer.from([0x84]), value]), rest]);
}

/**
 * A whole file.
 *
 * `clusters` are each `{ data, unknownSize? }`. `cues` says which tracks the
 * Cues table names for every cluster: an array of track numbers, or null for
 * no Cues element at all. `cuesBeforeClusters` puts the Cues element ahead of
 * the clusters with no SeekHead entry for it.
 *
 * @param {object} params
 * @param {Buffer[]} params.tracks - TrackEntry elements.
 * @param {Array<{ data: Buffer, unknownSize?: boolean, ticks: number }>} params.clusters
 * @param {number[] | null} [params.cues]
 * @param {boolean} [params.cuesBeforeClusters]
 * @returns {{ file: Buffer, clusterAt: number[], cuesAt: number | null, segmentDataOffset: number }}
 */
export function buildMatroska({ tracks, clusters, cues = [], cuesBeforeClusters = false }) {
  const info = element(ID.INFO, uintElement(ID.TIMESTAMP_SCALE, 1_000_000));
  const tracksElement = element(ID.TRACKS, Buffer.concat(tracks));
  const clusterElements = clusters.map((cluster) =>
    cluster.unknownSize ? unknownSizeElement(ID.CLUSTER, cluster.data) : element(ID.CLUSTER, cluster.data)
  );

  const cuesWith = (positions) =>
    cues === null
      ? Buffer.alloc(0)
      : element(
          ID.CUES,
          Buffer.concat(
            clusters.map((cluster, index) =>
              element(
                ID.CUE_POINT,
                Buffer.concat([
                  uint32Element(ID.CUE_TIME, cluster.ticks),
                  ...cues.map((track) =>
                    element(
                      ID.CUE_TRACK_POSITIONS,
                      Buffer.concat([uintElement(ID.CUE_TRACK, track), uint32Element(ID.CUE_CLUSTER_POSITION, positions[index])])
                    )
                  )
                ])
              )
            )
          )
        );
  const seekEntry = (targetId, position) =>
    element(ID.SEEK, Buffer.concat([element(ID.SEEK_ID, idBytes(targetId)), uint32Element(ID.SEEK_POSITION, position)]));
  const seekHeadWith = (infoAt, tracksAt, cuesAt) =>
    element(
      ID.SEEK_HEAD,
      Buffer.concat([
        seekEntry(ID.INFO, infoAt),
        seekEntry(ID.TRACKS, tracksAt),
        ...(cues !== null && !cuesBeforeClusters ? [seekEntry(ID.CUES, cuesAt)] : [])
      ])
    );

  const zeros = clusters.map(() => 0);
  const headLength = seekHeadWith(0, 0, 0).length;
  const infoAt = headLength;
  const tracksAt = infoAt + info.length;
  const cuesLength = cuesWith(zeros).length;
  const firstClusterAt = tracksAt + tracksElement.length + (cuesBeforeClusters ? cuesLength : 0);
  const positions = [];
  let at = firstClusterAt;
  for (const cluster of clusterElements) {
    positions.push(at);
    at += cluster.length;
  }
  const cuesAt = cues === null ? null : cuesBeforeClusters ? tracksAt + tracksElement.length : at;
  const parts = [seekHeadWith(infoAt, tracksAt, cuesAt ?? 0), info, tracksElement];
  if (cuesBeforeClusters) {
    parts.push(cuesWith(positions));
  }
  parts.push(...clusterElements);
  if (!cuesBeforeClusters) {
    parts.push(cuesWith(positions));
  }
  const payload = Buffer.concat(parts);
  const ebml = element(ID.EBML, Buffer.from([0x42, 0x86, 0x81, 0x01]));
  const segment = element(ID.SEGMENT, payload);
  const segmentDataOffset = ebml.length + segment.length - payload.length;
  return {
    file: Buffer.concat([ebml, segment]),
    clusterAt: positions.map((position) => segmentDataOffset + position),
    cuesAt: cuesAt === null ? null : segmentDataOffset + cuesAt,
    segmentDataOffset
  };
}

/**
 * A reader over a buffer that answers null for the ranges a check says are
 * not here, and records every range asked for.
 *
 * @param {Buffer} bytes
 * @param {{ missing?: (start: number, end: number) => boolean, short?: boolean }} [options]
 */
export function readerOver(bytes, options = {}) {
  const reads = [];
  const read = async (start, end) => {
    reads.push({ start, end });
    if (options.missing?.(start, end)) {
      return null;
    }
    const slice = bytes.subarray(start, end + 1);
    return options.short ? slice.subarray(0, Math.max(0, slice.length - 1)) : Buffer.from(slice);
  };
  return { read, reads };
}

/**
 * What the cue walk may read: the held ranges, a strict read of them, a
 * portion and where viewers stand.
 *
 * @param {Buffer} bytes
 * @param {Array<[number, number]>} ranges
 * @param {{ portionBytes?: number, wantedSeconds?: number[], reads?: Array<{ start: number, end: number }> }} [options]
 * @returns {import("../../../services/media/container/Container.js").HeldReader}
 */
export function heldOver(bytes, ranges, options = {}) {
  const holds = (start, end) => ranges.some(([from, to]) => start >= from && end <= to);
  return {
    ranges,
    isHeld: (start, end) => holds(start, Math.min(end, bytes.length - 1)),
    read: async (start, end) => {
      options.reads?.push({ start, end });
      const last = Math.min(end, bytes.length - 1);
      if (!holds(start, last)) {
        const error = new Error(`bytes ${start}-${last} are not available yet`);
        error.name = "BytesUnavailable";
        throw error;
      }
      return Buffer.from(bytes.subarray(start, last + 1));
    },
    portionBytes: options.portionBytes ?? Number.POSITIVE_INFINITY,
    wantedSeconds: options.wantedSeconds ?? []
  };
}
