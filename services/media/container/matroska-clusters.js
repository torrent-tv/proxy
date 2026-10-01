/**
 * @file Where a Matroska file's clusters are, found from the bytes already
 * downloaded, and the subtitle blocks inside them — RFC 9559 §5.1.3.
 *
 * **Why the Cues table is not enough.** It used to be the only way in: the walk
 * read the clusters the Cues table names for a subtitle track and nothing else.
 * RFC 9559 §22.1 says each subtitle frame SHOULD be referenced there — a
 * recommendation, not a guarantee — and a file may have no Cues at all. Such a
 * file showed no subtitles, ever, while a comment promised the walk would read
 * "the clusters the viewer's own playback brings in" instead. Nothing did.
 *
 * **Where a cluster begins is established three ways, and only the first two
 * are proof:**
 *
 * 1. the file says so — the first cluster after the head, and every
 *    `CueClusterPosition` of every track (the video's name nearly every
 *    cluster, because §22.1 has each keyframe referenced);
 * 2. a chain from a position already established: a level-1 element begins
 *    exactly where the one before it ends, so from a cluster whose header is
 *    downloaded the next one is known without reading anything else;
 * 3. a search of downloaded bytes for the Cluster id, used only where the file
 *    has no Cues. What it finds is a CANDIDATE, checked against the structure a
 *    cluster must have before anything is read out of it, and taken back —
 *    together with every cue it gave — if a position established by the first
 *    two ways later lands inside it.
 *
 * **What is kept between passes, and what is not.** A cluster read whole is
 * DONE and never read again. One whose bytes are not all downloaded is left as
 * it is: nothing about it is recorded, because "not here yet" is not a fact
 * about the cluster (`unavailable.js`). One whose downloaded, hash-verified
 * bytes do not parse is UNREADABLE, with its reason, and not tried again —
 * reading the same bytes again gives the same answer.
 *
 * **Order, and when a pass ends.** The cluster a viewer is standing in is read
 * first, then the one before it — a line on screen now may have started there.
 * A pass that had such clusters to read ends with them, so what is on screen is
 * pushed after two clusters rather than after the whole file; it says `more`,
 * and the caller runs the next pass at once. A pass with nothing of that kind
 * reads onward from the viewers, one viewer's next cluster after another's, and
 * then the rest — and stops, saying `more`, the moment a viewer is somewhere
 * else, so a seek is answered by the next pass and not after the whole film.
 */

import { crc32 } from "node:zlib";
import { readUint, readVint } from "./ebml-reader.js";
import { ElementReader, MAX_HEADER_BYTES } from "./ebml-stream.js";
import { isUnavailable } from "./unavailable.js";

const ID_CLUSTER = 0x1f43b675;
const CLUSTER_ID_BYTES = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);

/** The top-level elements of a Segment (RFC 9559 §5.1), Void and CRC-32 aside. */
const LEVEL_ONE = new Set([
  ID_CLUSTER,
  0x1c53bb6b, // Cues
  0x114d9b74, // SeekHead
  0x1549a966, // Info
  0x1654ae6b, // Tracks
  0x1043a770, // Chapters
  0x1941a469, // Attachments
  0x1254c367 // Tags
]);

const ID_CRC32 = 0xbf;
const ID_VOID = 0xec;
const ID_TIMESTAMP = 0xe7;
const ID_SILENT_TRACKS = 0x5854;
const ID_POSITION = 0xa7;
const ID_PREV_SIZE = 0xab;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK_GROUP = 0xa0;
const ID_ENCRYPTED_BLOCK = 0xaf;
const ID_BLOCK = 0xa1;
const ID_BLOCK_DURATION = 0x9b;

/** The children RFC 9559 §5.1.3 allows inside a Cluster, the global two included. */
const CLUSTER_CHILDREN = new Set([
  ID_CRC32,
  ID_VOID,
  ID_TIMESTAMP,
  ID_SILENT_TRACKS,
  ID_POSITION,
  ID_PREV_SIZE,
  ID_SIMPLE_BLOCK,
  ID_BLOCK_GROUP,
  ID_ENCRYPTED_BLOCK
]);

/**
 * Enough of a cluster's start to hold its header, a CRC-32 and the Timestamp
 * that follows it (§5.1.3.1: first, or second after a CRC-32).
 */
const CLUSTER_START_PROBE = 64;

/**
 * The bytes one read of a cluster's structure takes: an element header and the
 * start of a block's data, which names the block's track — a track number is a
 * vint of at most 8 bytes (RFC 9559 §10.1). Reading a cluster this way moves
 * the headers of its video and audio blocks across the thread boundary and
 * none of their frames.
 */
const STRUCTURE_READ_BYTES = MAX_HEADER_BYTES + 8;

/** Bits 1-2 of a block's flags byte say how it is laced, or that it is not. */
const LACING_MASK = 0x06;
const LACING_NONE = 0x00;
const LACING_XIPH = 0x02;
const LACING_FIXED = 0x04;
const LACING_EBML = 0x06;

/**
 * A block's own header: its track, its time relative to the cluster, its flags.
 *
 * @param {Buffer} buffer
 * @param {number} start - First byte of the block's data.
 * @param {number} end - One past its last byte.
 * @returns {{ trackNumber: number, relativeTicks: number, flags: number, dataOffset: number } | null}
 */
export function readBlockHeader(buffer, start, end) {
  const track = readVint(buffer, start, false);
  if (!track || track.value === null) {
    return null;
  }
  const timestampAt = start + track.length;
  // Signed, and it can be negative: a block may belong slightly before the
  // cluster it is stored in.
  if (timestampAt + 3 > end) {
    return null;
  }
  return {
    trackNumber: Number(track.value),
    relativeTicks: buffer.readInt16BE(timestampAt),
    flags: buffer[timestampAt + 2],
    dataOffset: timestampAt + 3
  };
}

/**
 * Where a laced block's first frame begins.
 *
 * @param {Buffer} buffer
 * @param {number} dataOffset - First byte after the block header.
 * @param {number} end
 * @param {number} flags
 * @returns {number | null}
 */
export function firstFrameOffset(buffer, dataOffset, end, flags) {
  const lacing = flags & LACING_MASK;
  if (lacing === LACING_NONE) {
    return dataOffset;
  }
  if (dataOffset >= end) {
    return null;
  }
  const frames = buffer[dataOffset] + 1;
  let at = dataOffset + 1;
  if (lacing === LACING_FIXED) {
    return at;
  }
  if (lacing === LACING_XIPH) {
    for (let frame = 0; frame < frames - 1; frame += 1) {
      while (at < end && buffer[at] === 0xff) {
        at += 1;
      }
      at += 1;
    }
    return at <= end ? at : null;
  }
  if (lacing === LACING_EBML) {
    for (let frame = 0; frame < frames - 1; frame += 1) {
      const size = readVint(buffer, at, false);
      if (!size) {
        return null;
      }
      at += size.length;
    }
    return at <= end ? at : null;
  }
  return null;
}

/**
 * The walk's own record of one file, kept by the caller between passes.
 *
 * @typedef {object} ClusterStart
 * @property {"first" | "cues" | "chain" | "search"} source
 * @property {number | null} parent - The start this one was chained from.
 * @property {number | null} seconds - The cluster's Timestamp, once read.
 * @property {"cluster" | "other" | null} kind - Null until its header is read.
 * @property {number | null} end - One past its last byte, null while unknown.
 * @property {boolean} stepped - Whether the next start has been taken from it.
 */

/**
 * @param {object} progress
 * @returns {object}
 */
function stateOf(progress) {
  if (!progress.matroska) {
    progress.matroska = {
      seeded: false,
      /** @type {Map<number, ClusterStart>} */
      starts: new Map(),
      done: new Set(),
      /** @type {Map<number, string>} */
      unreadable: new Map(),
      /** Candidates whose bytes are not all here yet. @type {Set<number>} */
      candidates: new Set(),
      /** Candidates the structure check refused. @type {Set<number>} */
      rejected: new Set(),
      /** Inclusive intervals the search has finished with. @type {Array<[number, number]>} */
      scanned: [],
      stats: { refusedElements: 0, rejectedCandidates: 0, contradictions: 0, bytesWalked: 0, fromSearch: 0 }
    };
  }
  return progress.matroska;
}

/**
 * The start a chain of starts began from.
 *
 * @param {Map<number, ClusterStart>} starts
 * @param {number} at
 * @returns {ClusterStart | undefined}
 */
function rootOf(starts, at) {
  let current = starts.get(at);
  const seen = new Set();
  while (current && current.parent !== null && !seen.has(current.parent)) {
    seen.add(current.parent);
    const parent = starts.get(current.parent);
    if (!parent) {
      break;
    }
    current = parent;
  }
  return current;
}

/**
 * Whether every byte of an inclusive range lies in one downloaded run.
 *
 * @param {Array<[number, number]>} ranges
 * @param {number} start
 * @returns {number} One past the end of the run holding `start`, or `start`.
 */
function runEndFrom(ranges, start) {
  for (const [from, to] of ranges) {
    if (start >= from && start <= to) {
      return to + 1;
    }
  }
  return start;
}

/**
 * The Timestamp of a cluster, read from its first children.
 *
 * Only the children inside the probe are looked at: the Timestamp is the first
 * child or the second after a CRC-32, and a cluster that puts it later is read
 * whole when it is processed.
 *
 * @param {ElementReader} reader
 * @param {{ dataOffset: number, end: number | null }} header
 * @param {number} limit
 * @param {number} secondsPerTick
 * @returns {Promise<number | null>}
 */
async function leadingTimestamp(reader, header, limit, secondsPerTick) {
  let at = header.dataOffset;
  const stop = Math.min(limit, header.end ?? limit, header.dataOffset + CLUSTER_START_PROBE);
  while (at < stop) {
    const child = await reader.header(at, header.end ?? limit);
    if (!child || child.size === null) {
      return null;
    }
    if (child.id === ID_TIMESTAMP) {
      const bytes = await reader.bytes(child.dataOffset, child.size);
      return readUint(bytes, 0, child.size) * secondsPerTick;
    }
    if (child.id !== ID_CRC32 && child.id !== ID_VOID) {
      return null;
    }
    at = child.end;
  }
  return null;
}

/**
 * Take the next start from every start whose header is downloaded.
 *
 * @param {object} state
 * @param {object} plan
 * @param {import("./Container.js").HeldReader} held
 * @param {ElementReader} reader
 * @returns {Promise<void>}
 */
async function extendChains(state, plan, held, reader) {
  const queue = [...state.starts.entries()].filter(([, start]) => !start.stepped).map(([at]) => at);
  while (queue.length > 0) {
    const at = queue.shift();
    const start = state.starts.get(at);
    if (!start || start.stepped || state.unreadable.has(at)) {
      continue;
    }
    const probeEnd = Math.min(plan.fileSize, at + CLUSTER_START_PROBE) - 1;
    if (!held.isHeld(at, Math.min(probeEnd, at + MAX_HEADER_BYTES - 1))) {
      continue;
    }
    let header;
    try {
      header = await reader.header(at, plan.segmentEnd);
    } catch (error) {
      if (isUnavailable(error)) {
        continue;
      }
      throw error;
    }
    start.stepped = true;
    if (!header || !(LEVEL_ONE.has(header.id) || header.id === ID_VOID || header.id === ID_CRC32)) {
      // A position the file itself names (or one a chain led to) that holds no
      // top-level element: the file is damaged here, and reading it again gives
      // the same bytes.
      state.unreadable.set(at, "no top-level element at a position established as a cluster start");
      continue;
    }
    start.kind = header.id === ID_CLUSTER ? "cluster" : "other";
    start.end = header.end;
    if (start.kind === "cluster" && start.seconds === null && held.isHeld(at, probeEnd)) {
      try {
        start.seconds = await leadingTimestamp(reader, header, plan.segmentEnd, plan.secondsPerTick);
      } catch (error) {
        if (!isUnavailable(error)) {
          throw error;
        }
      }
    }
    if (header.end === null) {
      // An unknown size is legal for a cluster (RFC 9559 §5.1.3); where it ends
      // is learned when it is read.
      continue;
    }
    addStart(state, header.end, plan, { source: "chain", parent: at }, queue);
  }
}

/**
 * @param {object} state
 * @param {number} at
 * @param {object} plan
 * @param {{ source: ClusterStart["source"], parent: number | null, seconds?: number | null }} origin
 * @param {number[]} [queue]
 * @returns {void}
 */
function addStart(state, at, plan, origin, queue) {
  if (!(at < plan.segmentEnd) || at < plan.firstClusterAt) {
    return;
  }
  const known = state.starts.get(at);
  if (known) {
    // The same position reached a second way. A start the file established
    // outranks one the search found, and keeps nothing of its doubt.
    if (known.source === "search" && origin.source !== "search") {
      known.source = origin.source;
      known.parent = origin.parent;
    }
    if (known.seconds === null && Number.isFinite(origin.seconds)) {
      known.seconds = origin.seconds;
    }
    return;
  }
  state.starts.set(at, {
    source: origin.source,
    parent: origin.parent,
    seconds: Number.isFinite(origin.seconds) ? origin.seconds : null,
    kind: null,
    end: null,
    stepped: false
  });
  state.candidates.delete(at);
  queue?.push(at);
}

/**
 * The spans of the clusters already known, as inclusive intervals.
 *
 * @param {object} state
 * @returns {Array<[number, number]>}
 */
function knownSpans(state) {
  const spans = [];
  for (const [at, start] of state.starts) {
    if (start.kind !== null && start.end !== null) {
      spans.push([at, start.end - 1]);
    }
  }
  return spans.sort((left, right) => left[0] - right[0]);
}

/**
 * `[from, to]` with every interval in `taken` removed.
 *
 * @param {number} from
 * @param {number} to
 * @param {Array<[number, number]>} taken - Sorted.
 * @returns {Array<[number, number]>}
 */
function subtract(from, to, taken) {
  const left = [];
  let cursor = from;
  for (const [start, end] of taken) {
    if (end < cursor || start > to) {
      continue;
    }
    if (start > cursor) {
      left.push([cursor, start - 1]);
    }
    cursor = Math.max(cursor, end + 1);
    if (cursor > to) {
      break;
    }
  }
  if (cursor <= to) {
    left.push([cursor, to]);
  }
  return left;
}

/**
 * Search downloaded bytes the search has not finished with for the Cluster id.
 *
 * The last `MAX_HEADER_BYTES - 1` bytes of every downloaded run are left
 * unfinished: an id and a size cut by the end of the run are found when the run
 * grows, by searching those bytes again.
 *
 * Each position found is decided at once ({@link settleCandidate}); one that is
 * accepted is followed by its chain, and the search goes on after the chain
 * ends. A file whose clusters follow one another is therefore searched only up
 * to its first cluster after each gap, and the rest is known by its headers.
 *
 * @param {object} state
 * @param {object} plan
 * @param {import("./Container.js").HeldReader} held
 * @param {{ whole: ElementReader, structure: ElementReader }} readers
 * @returns {Promise<void>}
 */
async function searchForClusters(state, plan, held, readers) {
  const portion = Number.isFinite(held.portionBytes) && held.portionBytes > 0 ? held.portionBytes : plan.fileSize;
  const idLength = CLUSTER_ID_BYTES.length;
  for (const [runFrom, runTo] of held.ranges) {
    const from = Math.max(runFrom, plan.firstClusterAt);
    const to = Math.min(runTo, plan.segmentEnd - 1);
    let at = from;
    while (at + idLength - 1 <= to) {
      // What is left to look at is worked out afresh at every step: a cluster
      // accepted below starts a chain, and the bytes the chain covers are
      // stepped over rather than searched. They are not marked as searched, so
      // if the chain is ever taken back they are searched then.
      const taken = [...state.scanned, ...knownSpans(state)].sort((left, right) => left[0] - right[0]);
      const next = subtract(at, to, taken)[0];
      if (!next || next[1] - next[0] + 1 < idLength) {
        break;
      }
      const [start, end] = next;
      const last = Math.min(end, start + portion - 1);
      const bytes = await held.read(start, last);
      state.stats.bytesWalked += bytes.length;
      let accepted = null;
      let found = bytes.indexOf(CLUSTER_ID_BYTES);
      while (found >= 0) {
        const position = start + found;
        if (!state.starts.has(position) && !state.rejected.has(position)) {
          const outcome = await settleCandidate(state, plan, held, readers, position);
          if (outcome === "accepted") {
            accepted = position;
            break;
          }
        }
        found = bytes.indexOf(CLUSTER_ID_BYTES, found + 1);
      }
      if (accepted !== null) {
        if (accepted - 1 >= start) {
          state.scanned = mergeIntervals([...state.scanned, [start, accepted - 1]]);
        }
        at = accepted;
        continue;
      }
      if (last < end) {
        // Every position whose whole id lies in this portion has been looked
        // at; the next portion overlaps by the id's length less one, so an id
        // cut by the boundary is found there.
        state.scanned = mergeIntervals([...state.scanned, [start, last - idLength + 1]]);
        at = last - idLength + 2;
        continue;
      }
      // Held back only where the RUN ends here: a span that ends at a known
      // element's boundary has nothing after it that could complete an id.
      const runEndsHere = end === to && runTo < plan.segmentEnd - 1;
      const finished = runEndsHere ? end - (MAX_HEADER_BYTES - 1) : end;
      if (finished >= start) {
        state.scanned = mergeIntervals([...state.scanned, [start, finished]]);
      }
      at = end + 1;
    }
  }
}

/**
 * Decide one position the search found the Cluster ID at.
 *
 * Accepted, it becomes a start and its chain is followed at once, so the
 * clusters after it are known by their headers and never searched for.
 *
 * @param {object} state
 * @param {object} plan
 * @param {import("./Container.js").HeldReader} held
 * @param {{ whole: ElementReader, structure: ElementReader }} readers
 * @param {number} at
 * @returns {Promise<"accepted" | "rejected" | "pending">}
 */
async function settleCandidate(state, plan, held, readers, at) {
  if (knownSpans(state).some(([from, to]) => at > from && at <= to)) {
    // Inside an element whose bounds are known: not a cluster start.
    state.candidates.delete(at);
    state.rejected.add(at);
    return "rejected";
  }
  const verdict = await verifyCandidate(readers.whole, at, plan, state, held);
  if (verdict.status === "pending") {
    state.candidates.add(at);
    return "pending";
  }
  state.candidates.delete(at);
  if (verdict.status === "rejected") {
    state.rejected.add(at);
    state.stats.rejectedCandidates += 1;
    return "rejected";
  }
  addStart(state, at, plan, { source: "search", parent: null, seconds: verdict.seconds });
  const start = state.starts.get(at);
  if (start) {
    start.kind = "cluster";
    start.end = verdict.end;
  }
  await extendChains(state, plan, held, readers.structure);
  return "accepted";
}

/**
 * @param {Array<[number, number]>} intervals
 * @returns {Array<[number, number]>}
 */
function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((left, right) => left[0] - right[0]);
  const merged = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

/**
 * The confirmed starts nearest a position on either side, with their times.
 *
 * @param {object} state
 * @param {number} at
 * @returns {{ before: { at: number, start: ClusterStart } | null, after: { at: number, start: ClusterStart } | null }}
 */
function neighboursOf(state, at) {
  let before = null;
  let after = null;
  for (const [position, start] of state.starts) {
    if (start.kind !== "cluster") {
      continue;
    }
    if (position < at && (!before || position > before.at)) {
      before = { at: position, start };
    } else if (position > at && (!after || position < after.at)) {
      after = { at: position, start };
    }
  }
  return { before, after };
}

/**
 * Check a candidate against everything a cluster must be.
 *
 * Every child is one RFC 9559 §5.1.3 allows; there is exactly one Timestamp,
 * wherever it stands; the children fill the cluster exactly; every block names a
 * track the file declares; a CRC-32, where there is one, matches; a PrevSize,
 * where there is one and the cluster before is known, matches; and the time
 * lies between the times of the known clusters either side.
 *
 * @param {ElementReader} reader
 * @param {number} at
 * @param {object} plan
 * @param {object} state
 * @param {import("./Container.js").HeldReader} held
 * @returns {Promise<{ status: "pending" } | { status: "rejected", reason: string } | { status: "confirmed", end: number, seconds: number }>}
 */
async function verifyCandidate(reader, at, plan, state, held) {
  try {
    const header = await reader.header(at, plan.segmentEnd);
    if (!header || header.id !== ID_CLUSTER) {
      return { status: "rejected", reason: "no cluster header" };
    }
    if (header.end !== null && header.end > plan.segmentEnd) {
      return { status: "rejected", reason: "runs past the segment" };
    }
    if (header.end !== null && !held.isHeld(at, header.end - 1)) {
      return { status: "pending" };
    }
    const limit = header.end ?? plan.segmentEnd;
    let cursor = header.dataOffset;
    let timestamps = 0;
    let ticks = null;
    let crc = null;
    let crcEnd = null;
    let prevSize = null;
    let end = header.end;
    let first = true;
    while (cursor < limit) {
      if (!held.isHeld(cursor, Math.min(plan.fileSize, cursor + MAX_HEADER_BYTES) - 1)) {
        return { status: "pending" };
      }
      const child = await reader.header(cursor, limit);
      if (!child) {
        return { status: "rejected", reason: "a child header does not parse" };
      }
      if (header.end === null && LEVEL_ONE.has(child.id)) {
        end = cursor;
        break;
      }
      if (!CLUSTER_CHILDREN.has(child.id)) {
        return { status: "rejected", reason: `0x${child.id.toString(16)} is not a cluster child` };
      }
      if (child.size === null || child.end > limit) {
        return { status: "rejected", reason: "a child runs past the cluster" };
      }
      if (child.id === ID_CRC32) {
        if (!first || child.size !== 4) {
          return { status: "rejected", reason: "a CRC-32 that is not the first child" };
        }
        crc = (await reader.bytes(child.dataOffset, 4)).readUInt32LE(0);
        crcEnd = child.end;
      } else if (child.id === ID_TIMESTAMP) {
        timestamps += 1;
        ticks = readUint(await reader.bytes(child.dataOffset, child.size), 0, child.size);
      } else if (child.id === ID_PREV_SIZE) {
        prevSize = readUint(await reader.bytes(child.dataOffset, child.size), 0, child.size);
      } else if (child.id === ID_SIMPLE_BLOCK || child.id === ID_BLOCK_GROUP) {
        const track = await blockTrackOf(reader, child);
        if (track === null || !plan.allTrackNumbers.includes(track)) {
          return { status: "rejected", reason: "a block names no declared track" };
        }
      }
      first = false;
      cursor = child.end;
    }
    if (end === null) {
      end = limit;
    }
    if (cursor !== end) {
      return { status: "rejected", reason: "the children do not fill the cluster" };
    }
    if (timestamps !== 1) {
      return { status: "rejected", reason: `${timestamps} Timestamp elements` };
    }
    if (crc !== null) {
      // RFC 8794 §11.3.1: the CRC covers every byte of the parent's data after
      // the CRC-32 element itself, stored little-endian.
      const computed = await crcOf(reader, crcEnd, end, held.portionBytes);
      if (computed !== crc) {
        return { status: "rejected", reason: "CRC-32 does not match" };
      }
    }
    const seconds = ticks * plan.secondsPerTick;
    const { before, after } = neighboursOf(state, at);
    if (prevSize !== null && before && before.start.end === at && prevSize !== at - before.at) {
      return { status: "rejected", reason: "PrevSize does not match the cluster before" };
    }
    if (before && before.start.seconds !== null && seconds < before.start.seconds) {
      return { status: "rejected", reason: "earlier than the cluster before it" };
    }
    if (after && after.start.seconds !== null && seconds > after.start.seconds) {
      return { status: "rejected", reason: "later than the cluster after it" };
    }
    return { status: "confirmed", end, seconds };
  } catch (error) {
    if (isUnavailable(error)) {
      return { status: "pending" };
    }
    throw error;
  }
}

/**
 * CRC-32 (IEEE 802.3, RFC 8794 §11.3.1) of a span, a portion at a time.
 *
 * @param {ElementReader} reader
 * @param {number} from
 * @param {number} to - One past the last byte.
 * @param {number} portionBytes
 * @returns {Promise<number>}
 */
async function crcOf(reader, from, to, portionBytes) {
  const step = Number.isFinite(portionBytes) && portionBytes > 0 ? portionBytes : to - from;
  let value = 0;
  for (let at = from; at < to; at += step) {
    value = crc32(await reader.bytes(at, Math.min(step, to - at)), value);
  }
  return value >>> 0;
}

/**
 * The track a SimpleBlock or a BlockGroup's Block belongs to, read from its
 * first bytes only.
 *
 * @param {ElementReader} reader
 * @param {import("./ebml-stream.js").ElementHeader} child
 * @returns {Promise<number | null>}
 */
async function blockTrackOf(reader, child) {
  if (child.id === ID_SIMPLE_BLOCK) {
    const head = await reader.peek(child, 8);
    const track = readVint(head, 0, false);
    return track ? track.value : null;
  }
  let at = child.dataOffset;
  while (at < child.end) {
    const inner = await reader.header(at, child.end);
    if (!inner || inner.size === null) {
      return null;
    }
    if (inner.id === ID_BLOCK) {
      const head = await reader.peek(inner, 8);
      const track = readVint(head, 0, false);
      return track ? track.value : null;
    }
    at = inner.end;
  }
  return null;
}

/**
 * Take back a start the search found, and everything chained from it, when a
 * start the file established lands inside it — or it inside one.
 *
 * @param {object} state
 * @returns {number[]} The cluster starts withdrawn, whose cues must be taken back.
 */
function withdrawContradicted(state) {
  const established = [];
  const searched = [];
  for (const [at, start] of state.starts) {
    if (start.kind !== "cluster") {
      continue;
    }
    const root = rootOf(state.starts, at);
    (root?.source === "search" ? searched : established).push([at, start]);
  }
  const contradicted = new Set();
  for (const [at, start] of searched) {
    for (const [other, otherStart] of established) {
      const insideIt = start.end !== null && other > at && other < start.end;
      const itInside = otherStart.end !== null && at > other && at < otherStart.end;
      if (insideIt || itInside) {
        contradicted.add(at);
        break;
      }
    }
  }
  if (contradicted.size === 0) {
    return [];
  }
  // Everything chained from a withdrawn start goes with it.
  let grew = true;
  while (grew) {
    grew = false;
    for (const [at, start] of state.starts) {
      if (!contradicted.has(at) && start.parent !== null && contradicted.has(start.parent)) {
        contradicted.add(at);
        grew = true;
      }
    }
  }
  const withdrawn = [];
  for (const at of contradicted) {
    const start = state.starts.get(at);
    state.starts.delete(at);
    state.rejected.add(at);
    if (state.done.delete(at) && start?.kind === "cluster") {
      withdrawn.push(at);
    }
  }
  state.stats.contradictions += contradicted.size;
  return withdrawn;
}

/**
 * The order to read pending clusters in: the ones viewers stand in now, and the
 * rest.
 *
 * Which cluster a viewer stands in is decided over EVERY cluster whose time is
 * known, read or not: deciding it over the pending ones only would name an
 * earlier cluster whenever the viewer's own one had already been read.
 *
 * @param {Array<[number, ClusterStart]>} pending
 * @param {Array<[number, ClusterStart]>} clusters - Every known cluster start.
 * @param {number[]} wantedSeconds
 * @returns {{ urgent: number[], rest: number[] }}
 */
function readingOrder(pending, clusters, wantedSeconds) {
  const isPending = new Set(pending.map(([at]) => at));
  const timed = clusters.filter(([, start]) => start.seconds !== null).sort((left, right) => left[1].seconds - right[1].seconds);
  const lists = [];
  const urgent = [];
  for (const seconds of wantedSeconds ?? []) {
    if (!Number.isFinite(seconds)) {
      continue;
    }
    let containing = -1;
    for (let index = 0; index < timed.length; index += 1) {
      if (timed[index][1].seconds <= seconds) {
        containing = index;
      } else {
        break;
      }
    }
    if (containing >= 0) {
      urgent.push(timed[containing][0]);
      if (containing > 0) {
        urgent.push(timed[containing - 1][0]);
      }
    }
    const list = [];
    for (let index = containing + 1; index < timed.length; index += 1) {
      list.push(timed[index][0]);
    }
    lists.push(list.filter((at) => isPending.has(at)));
  }
  const now = [...new Set(urgent.filter((at) => isPending.has(at)))];
  const order = [];
  const seen = new Set(now);
  // One viewer's next cluster after another's, so nobody waits for another
  // viewer's whole film.
  for (let step = 0; lists.some((list) => step < list.length); step += 1) {
    for (const list of lists) {
      const at = list[step];
      if (at !== undefined && !seen.has(at)) {
        seen.add(at);
        order.push(at);
      }
    }
  }
  for (const [at] of [...pending].sort((left, right) => left[0] - right[0])) {
    if (!seen.has(at)) {
      order.push(at);
    }
  }
  return { urgent: now, rest: order };
}

/**
 * Where the viewers stand right now, however the reader states it.
 *
 * @param {import("./Container.js").HeldReader} held
 * @returns {number[]}
 */
function wantedNow(held) {
  const stated = typeof held.wantedSeconds === "function" ? held.wantedSeconds() : held.wantedSeconds;
  return Array.isArray(stated) ? stated.filter((value) => Number.isFinite(value)) : [];
}

/**
 * Whether a cluster's bytes are all here to be read now — known only for a
 * cluster whose size is known.
 *
 * @param {Map<number, ClusterStart>} starts
 * @param {number} at
 * @param {import("./Container.js").HeldReader} held
 * @returns {boolean}
 */
function readableNow(starts, at, held) {
  const start = starts.get(at);
  return Boolean(start && start.end !== null && held.isHeld(at, start.end - 1));
}

/**
 * Read one cluster's subtitle blocks.
 *
 * @param {{ structure: ElementReader, exact: ElementReader }} readers - Headers
 *   and track numbers through `structure`; a subtitle block's data through
 *   `exact`, which reads that element and nothing more.
 * @param {number} at
 * @param {ClusterStart} start
 * @param {object} plan
 * @param {object} state
 * @param {import("./Container.js").HeldReader} held
 * @returns {Promise<{ status: "pending" } | { status: "unreadable", reason: string } | { status: "done", blocks: object[], end: number }>}
 */
async function readCluster({ structure: reader, exact }, at, start, plan, state, held) {
  try {
    if (start.end !== null && !held.isHeld(at, start.end - 1)) {
      return { status: "pending" };
    }
    const header = await reader.header(at, plan.segmentEnd);
    if (!header || header.id !== ID_CLUSTER) {
      return { status: "unreadable", reason: "no cluster header" };
    }
    const limit = header.end ?? plan.segmentEnd;
    const wanted = new Set(plan.subtitleTrackNumbers);
    const raw = [];
    let ticks = null;
    let cursor = header.dataOffset;
    let end = header.end;
    while (cursor < limit) {
      if (!held.isHeld(cursor, Math.min(plan.fileSize, cursor + MAX_HEADER_BYTES) - 1)) {
        return { status: "pending" };
      }
      const child = await reader.header(cursor, limit);
      if (!child) {
        return { status: "unreadable", reason: "a child header does not parse" };
      }
      if (header.end === null && LEVEL_ONE.has(child.id)) {
        end = cursor;
        break;
      }
      if (child.size === null || child.end > limit) {
        return { status: "unreadable", reason: "a child runs past the cluster" };
      }
      if (header.end === null && !held.isHeld(child.at, child.end - 1)) {
        return { status: "pending" };
      }
      if (child.id === ID_TIMESTAMP) {
        ticks = readUint(await reader.bytes(child.dataOffset, child.size), 0, child.size);
      } else if (child.id === ID_SIMPLE_BLOCK || child.id === ID_BLOCK_GROUP) {
        const track = await blockTrackOf(reader, child);
        if (track !== null && wanted.has(track)) {
          const data = await exact.data(child);
          if (data === null) {
            state.stats.refusedElements += 1;
          } else {
            const block = child.id === ID_SIMPLE_BLOCK ? simpleBlockOf(data) : blockGroupOf(data);
            if (block) {
              raw.push(block);
            }
          }
        }
      }
      cursor = child.end;
    }
    if (end === null) {
      end = limit;
    }
    if (ticks === null) {
      return { status: "unreadable", reason: "a cluster with no Timestamp" };
    }
    state.stats.bytesWalked += end - at;
    const blocks = raw.map((block) => {
      const startSeconds = (ticks + block.relativeTicks) * plan.secondsPerTick;
      return {
        trackNumber: block.trackNumber,
        startSeconds,
        endSeconds: block.durationTicks === null ? null : startSeconds + block.durationTicks * plan.secondsPerTick,
        payload: block.payload,
        source: at
      };
    });
    return { status: "done", blocks, end, seconds: ticks * plan.secondsPerTick };
  } catch (error) {
    if (isUnavailable(error)) {
      return { status: "pending" };
    }
    throw error;
  }
}

/**
 * @param {Buffer} data - A SimpleBlock's data.
 * @returns {{ trackNumber: number, relativeTicks: number, durationTicks: null, payload: Buffer } | null}
 */
function simpleBlockOf(data) {
  const header = readBlockHeader(data, 0, data.length);
  if (!header) {
    return null;
  }
  const payloadAt = firstFrameOffset(data, header.dataOffset, data.length, header.flags);
  if (payloadAt === null || payloadAt >= data.length) {
    return null;
  }
  return { trackNumber: header.trackNumber, relativeTicks: header.relativeTicks, durationTicks: null, payload: data.subarray(payloadAt) };
}

/**
 * @param {Buffer} data - A BlockGroup's data.
 * @returns {{ trackNumber: number, relativeTicks: number, durationTicks: number | null, payload: Buffer } | null}
 */
function blockGroupOf(data) {
  let block = null;
  let durationTicks = null;
  let at = 0;
  while (at < data.length) {
    const id = readVint(data, at, true);
    const size = id && readVint(data, at + id.length, false);
    if (!id || !size) {
      return null;
    }
    const dataOffset = at + id.length + size.length;
    const end = dataOffset + size.value;
    if (end > data.length) {
      return null;
    }
    if (id.value === ID_BLOCK) {
      block = { start: dataOffset, end };
    } else if (id.value === ID_BLOCK_DURATION) {
      durationTicks = readUint(data, dataOffset, size.value);
    }
    at = end;
  }
  if (!block) {
    return null;
  }
  const header = readBlockHeader(data, block.start, block.end);
  if (!header) {
    return null;
  }
  const payloadAt = firstFrameOffset(data, header.dataOffset, block.end, header.flags);
  if (payloadAt === null || payloadAt >= block.end) {
    return null;
  }
  return { trackNumber: header.trackNumber, relativeTicks: header.relativeTicks, durationTicks, payload: data.subarray(payloadAt, block.end) };
}

/**
 * One pass over what a Matroska file holds now.
 *
 * @param {object} params
 * @param {object} params.plan - From `MatroskaContainer.readSubtitlePlan`.
 * @param {object} params.progress - Kept by the caller between passes.
 * @param {import("./Container.js").HeldReader} params.held
 * @returns {Promise<{ found: Map<number, object[]>, covered: number, indexed: number, withdrawn: number[], more: boolean, stats: object }>}
 *   `more` says clusters are readable now that this pass left for the next.
 */
export async function walkHeldClusters({ plan, progress, held }) {
  const state = stateOf(progress);
  const reader = new ElementReader({
    read: held.read,
    fileSize: plan.fileSize,
    portionBytes: held.portionBytes,
    prefetch: true,
    readableUntil: (start) => runEndFrom(held.ranges, start)
  });
  if (!state.seeded) {
    state.seeded = true;
    if (Number.isFinite(plan.firstClusterAt)) {
      addStart(state, plan.firstClusterAt, plan, { source: "first", parent: null });
    }
    for (const entry of plan.entryPoints ?? []) {
      addStart(state, entry.at, plan, { source: "cues", parent: null, seconds: entry.seconds });
    }
  }

  // The structure of clusters is read a header at a time, and a subtitle
  // block's data by its own size. The reader above takes a whole portion per
  // read and is for checking a candidate the search found, whose every byte is
  // needed; used for structure, it moved every frame of the film into this
  // thread — measured on the addon host 2026-10-01, the collector then spent
  // three times as long as the walk itself, and the loop's 99th-percentile
  // delay doubled.
  const structure = new ElementReader({
    read: held.read,
    fileSize: plan.fileSize,
    portionBytes: STRUCTURE_READ_BYTES,
    prefetch: true,
    readableUntil: (start) => runEndFrom(held.ranges, start)
  });
  const exact = new ElementReader({ read: held.read, fileSize: plan.fileSize, portionBytes: held.portionBytes });
  await extendChains(state, plan, held, structure);

  if (plan.cuesState === "absent") {
    const readers = { whole: reader, structure };
    // Candidates left waiting for bytes by an earlier pass, then the bytes not
    // yet looked at.
    for (const at of [...state.candidates].sort((left, right) => left - right)) {
      if (state.starts.has(at)) {
        state.candidates.delete(at);
        continue;
      }
      await settleCandidate(state, plan, held, readers, at);
    }
    await searchForClusters(state, plan, held, readers);
  }

  const withdrawn = withdrawContradicted(state);

  /** @type {Map<number, object[]>} */
  const found = new Map();
  const clusters = [...state.starts.entries()].filter(([, start]) => start.kind === "cluster");
  const pending = clusters.filter(([at]) => !state.done.has(at) && !state.unreadable.has(at));
  const wanted = wantedNow(held);
  const { urgent, rest } = readingOrder(pending, clusters, wanted);
  const urgentReadable = urgent.filter((at) => readableNow(state.starts, at, held));
  let more = false;
  /** @type {number[]} */
  let order;
  if (urgentReadable.length > 0) {
    order = urgentReadable;
    more = rest.some((at) => readableNow(state.starts, at, held));
  } else {
    order = [...urgent, ...rest];
  }
  const asked = JSON.stringify(wanted);
  for (const at of order) {
    if (urgentReadable.length === 0 && JSON.stringify(wantedNow(held)) !== asked) {
      // A viewer is somewhere else now: the next pass starts from there.
      more = true;
      break;
    }
    const start = state.starts.get(at);
    if (!start) {
      continue;
    }
    const result = await readCluster({ structure, exact }, at, start, plan, state, held);
    if (result.status === "pending") {
      continue;
    }
    if (result.status === "unreadable") {
      state.unreadable.set(at, result.reason);
      continue;
    }
    state.done.add(at);
    if (start.end === null) {
      start.end = result.end;
      addStart(state, result.end, plan, { source: "chain", parent: at });
    }
    if (start.seconds === null) {
      start.seconds = result.seconds;
    }
    if (rootOf(state.starts, at)?.source === "search") {
      state.stats.fromSearch += 1;
    }
    for (const block of result.blocks) {
      const into = found.get(block.trackNumber) ?? [];
      into.push(block);
      found.set(block.trackNumber, into);
    }
  }
  // A cluster read whole may have made the start after an unknown-sized one
  // known; its header is taken on the next pass, with everything else new.

  return {
    found,
    covered: state.done.size,
    indexed: [...state.starts.values()].filter((start) => start.kind === "cluster").length,
    withdrawn,
    more,
    stats: { ...state.stats, unreadable: state.unreadable.size, pendingCandidates: state.candidates.size }
  };
}
