import { PacketRecords } from "./PacketRecords.js";
import { IndexMemoryUnavailable } from "./memory-unavailable.js";
import { isMp3Codec, mp3PacketFacts } from "./mp3-packet-dependencies.js";

/** Exact packet addresses and decode order, owned by one immutable source file. */
export class PacketIndex {
  #tracks = new Map();
  #packetMemory;
  #deferMemory;
  #pending = [];
  #pendingAt = 0;

  constructor({ packetMemory, deferMemory = false } = {}) {
    this.#packetMemory = packetMemory;
    this.#deferMemory = deferMemory;
  }

  declareTrack(id, { type, codecId = "", codecRanges = [], prerollSeconds = 0, reorderDepth = 0 }) {
    if (this.#tracks.has(id)) throw new Error(`Packet track ${id} was already declared.`);
    if (!["video", "audio", "subtitle"].includes(type) ||
      !Number.isFinite(prerollSeconds) || prerollSeconds < 0 ||
      !Number.isSafeInteger(reorderDepth) || reorderDepth < 0) {
      throw new TypeError("Invalid packet track parameters.");
    }
    const prerollFrames = isMp3Codec(codecId) || ["aac", "aac_latm", "mp4a"].includes(codecId) || /^A_AAC(?:\/|$)/.test(codecId) ? 1 : 0;
    this.#tracks.set(id, { type, codecId, codecRanges: normalizeRanges(codecRanges), prerollSeconds, prerollFrames, reorderDepth, packets: new PacketRecords(this.#packetMemory), coveredThrough: 0, complete: false });
  }

  append(id, packet) {
    const track = this.#track(id);
    if (track.complete) throw new Error("Cannot append to a completed packet index.");
    const ranges = validatePacket(packet);
    if (packet.decodeFromIndex !== undefined && (!Number.isSafeInteger(packet.decodeFromIndex) || packet.decodeFromIndex < 0 ||
        packet.decodeFromIndex > track.packets.length + this.#pending.slice(this.#pendingAt).filter(one => one?.id === id).length)) {
      throw new TypeError("A packet decoder dependency must name an existing or current packet.");
    }
    const record = { pts: packet.pts, duration: packet.duration, keyframe: packet.keyframe === true, ranges,
      ...(packet.expectedHash === undefined ? {} : { expectedHash: packet.expectedHash }),
      ...(packet.discardPaddingSeconds === undefined ? {} : { discardPaddingSeconds: packet.discardPaddingSeconds }),
      ...(packet.bitOffset === undefined ? {} : { bitOffset: packet.bitOffset, bitLength: packet.bitLength }),
      ...(packet.dts === undefined ? {} : { dts: packet.dts }) };
    if (packet.decodeFromIndex !== undefined) record.decodeFromIndex = packet.decodeFromIndex;
    if (packet.decodeDependencyUnknown) record.decodeDependencyUnknown = true;
    if (track.type === "audio" && isMp3Codec(track.codecId) && record.decodeFromIndex === undefined) {
      record.decodeFromIndex = track.packets.length + this.#pending.slice(this.#pendingAt).filter(one => one?.id === id).length;
      record.decodeDependencyUnknown = true;
    }
    if (this.#pending.length) { this.#pending.push({ id, record }); return; }
    try { track.packets.push(record); }
    catch (error) {
      if (!this.#deferMemory || !(error instanceof IndexMemoryUnavailable)) throw error;
      this.#pending.push({ id, record });
    }
  }

  /** Drain facts from the last transport read before accepting another read. */
  flushPending() {
    if (!this.#pending.length) return;
    while (this.#pendingAt < this.#pending.length) {
      const { id, record } = this.#pending[this.#pendingAt];
      this.#track(id).packets.push(record);
      this.#pending[this.#pendingAt++] = null;
    }
    this.#pending = [];
    this.#pendingAt = 0;
  }

  /** The progressive parser and its interval views share one packet allocation. */
  async prepareAudioDependencies(interval, readRange) {
    this.flushPending();
    for (const [id, track] of this.#tracks) {
      if (track.type !== "audio" || !isMp3Codec(track.codecId) ||
          (interval?.trackIds && !interval.trackIds.includes(id)) || interval?.modes?.[id] === "copy") continue;
      const records = track.packets;
      // As in inputFor: records in time order are searched rather than read
      // in full; one that starts too early to reach the interval is skipped
      // below unless a record its preroll frames ahead does reach it.
      const ordered = interval && records.ptsAscending;
      const scanFrom = ordered ? Math.max(0, records.firstAtOrAfter(interval.from - records.longestDuration) - track.prerollFrames) : 0;
      const scanTo = ordered ? records.firstAtOrAfter(interval.to) : records.length;
      for (let position = scanFrom; position < scanTo; position++) {
        const packet = records.at(position);
        if (!packet.decodeDependencyUnknown || (interval &&
            (packet.pts >= interval.to || (packet.pts < interval.from && packet.pts + packet.duration <= interval.from &&
              (position + track.prerollFrames >= records.length || records.ptsAt(position + track.prerollFrames) + records.durationAt(position + track.prerollFrames) <= interval.from))))) continue;
        const facts = await mp3PacketFacts(packet, readRange);
        let required = facts.required, first = position;
        while (required > 0 && first > 0) {
          first--;
          required -= (await mp3PacketFacts(records.at(first), readRange)).capacity;
        }
        if (required > 0) throw new Error("MP3 bit reservoir refers to bytes before the indexed source.");
        records.setDecodeFromIndex(position, first);
      }
    }
  }

  /** The progressive parser and its interval views share one packet allocation. */
  sharePackets(id, records) {
    const track = this.#track(id);
    if (track.complete || track.packets.length || !(records instanceof PacketRecords)) {
      throw new TypeError("Only an empty unfinished track may adopt packet records.");
    }
    for (const packet of records) validatePacket(packet);
    track.packets.dispose();
    track.packets = records;
  }

  dispose() {
    for (const track of this.#tracks.values()) track.packets.dispose();
    this.#tracks.clear();
    this.#pending = [];
    this.#pendingAt = 0;
  }

  reservePackets(id, count) {
    const track = this.#track(id);
    track.packets.reserveCapacity(count, isMp3Codec(track.codecId) ? 76 : 72);
  }

  complete(id) {
    const track = this.#track(id);
    track.packets.releaseUnusedCapacity();
    track.complete = true;
  }
  extendLastPresentation(id, seconds) {
    const track = this.#track(id);
    if (track.complete || track.type !== "video" || !Number.isFinite(seconds) || seconds <= 0) throw new TypeError("Only an unfinished video packet may extend its presentation.");
    track.packets.extendLastPresentation(seconds);
  }
  refuse(id, reason) {
    if (typeof reason !== "string" || !reason) throw new TypeError("A packet refusal requires a reason.");
    const track = this.#track(id);
    track.refusal = reason;
    track.complete = true;
  }
  isComplete() { return [...this.#tracks.values()].every(track => track.complete); }

  allocatedBytes() { return [...this.#tracks.values()].reduce((bytes, track) => bytes + track.packets.allocatedBytes, 0); }

  boundsOf(id) {
    this.flushPending();
    const track = this.#track(id);
    if (track.bounds) return track.bounds;
    const packets = track.packets;
    if (!packets.length) return null;
    let start = Infinity, end = -Infinity;
    for (let index = 0; index < packets.length; index++) {
      const pts = packets.ptsAt(index);
      start = Math.min(start, pts);
      end = Math.max(end, pts + packets.durationAt(index));
    }
    const bounds = { start, end };
    if (track.complete) track.bounds = bounds;
    return bounds;
  }

  keyframesOf(id) {
    this.flushPending();
    const packets = this.#track(id).packets, times = [];
    for (let index = 0; index < packets.length; index++) if (packets.keyframeAt(index)) times.push(packets.ptsAt(index));
    return times.sort((a, b) => a - b);
  }

  coverThrough(id, seconds) {
    const track = this.#track(id);
    if (!Number.isFinite(seconds) || seconds < track.coveredThrough) throw new TypeError("Index coverage must advance.");
    track.coveredThrough = seconds;
  }

  /** The same calculation is used to order source bytes and admit an encode. */
  inputFor({ trackId, from, to, mode = "transcode" }) {
    this.flushPending();
    if (!["copy", "transcode"].includes(mode)) throw new TypeError("Unknown segment input mode.");
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from) {
      throw new TypeError("A segment requires a finite nonempty presentation interval.");
    }
    const track = this.#track(trackId);
    if (track.refusal) return { kind: "terminal", reason: track.refusal, trackId };
    const packets = track.packets;
    const startAt = from - (track.type === "audio" && mode === "transcode" ? track.prerollSeconds : 0);
    const selected = [];
    // Records in time order are searched: only one starting within the
    // longest duration before the interval can reach into it. Read in full,
    // a two-hour soundtrack is 340 thousand records per interval, and the
    // download map asked for two thousand intervals at once: the proxy's main
    // thread stopped for minutes (Home Assistant 2026-10-10, torrent-tv/meta#166).
    const ordered = packets.ptsAscending;
    const scanFrom = ordered ? packets.firstAtOrAfter(startAt - packets.longestDuration) : 0;
    const scanTo = ordered ? packets.firstAtOrAfter(to) : packets.length;
    for (let index = scanFrom; index < scanTo; index++) {
      const pts = packets.ptsAt(index);
      if (pts < to && (pts >= startAt ||
        ((mode === "transcode" || track.type === "audio") && pts + packets.durationAt(index) > startAt))) selected.push(index);
    }
    if (selected.length === 0) {
      if (track.type === "subtitle" && (track.complete || track.coveredThrough >= to)) {
        return { kind: "result", trackId, ranges: [], packets: [], from, to, decodeFrom: from };
      }
      return track.complete
        ? { kind: "terminal", reason: "track-has-no-packets-in-interval" }
        : { kind: "needs-index", trackId, from: startAt, to };
    }
    let first = selected[0];
    let last = selected[selected.length - 1];
    if (track.type === "audio" && mode === "transcode") {
      const firstPlayed = selected.find(index => packets.ptsAt(index) + packets.durationAt(index) > from);
      if (firstPlayed !== undefined) first = Math.min(first, Math.max(0, firstPlayed - track.prerollFrames));
      for (let index = first; index <= last; index++) first = Math.min(first, packets.at(index).decodeFromIndex ?? index);
    }
    if (track.type === "video") {
      while (first >= 0 && (!packets.keyframeAt(first) || packets.ptsAt(first) > from)) first--;
      if (first < 0) return track.complete
        ? { kind: "terminal", reason: "video-interval-has-no-decode-start" }
        : { kind: "needs-index", trackId, from: startAt, to };
      let endsAtKeyframe = false;
      if (mode === "copy") for (let index = 0; index < packets.length; index++) if (packets.ptsAt(index) === to && packets.keyframeAt(index)) { endsAtKeyframe = true; break; }
      if (mode === "copy" && (packets.ptsAt(first) !== from ||
        (!endsAtKeyframe && (!track.complete || to < this.boundsOf(trackId).end)))) {
        return { kind: "terminal", reason: "video-copy-cut-is-not-a-keyframe" };
      }
    }
    // Coverage is established by the parser after its codec-required lookahead;
    // packets outside the interval are inspected but are not appended to input.
    if (!track.complete && track.coveredThrough < to) {
      return { kind: "needs-index", trackId, from: startAt, to };
    }
    last = Math.min(last, packets.length - 1);
    const input = packets.slice(first, last + 1);
    return {
      kind: "result",
      trackId,
      ranges: normalizeRanges([...track.codecRanges, ...input.flatMap(packet => packet.ranges)]),
      decodeFrom: packets.ptsAt(first),
      from,
      to,
      ...(track.complete && to >= this.boundsOf(trackId).end ? { sourceEndSeconds: this.boundsOf(trackId).end } : {}),
      packets: input
    };
  }

  #track(id) {
    const track = this.#tracks.get(id);
    if (!track) throw new Error(`Packet track ${id} is not declared.`);
    return track;
  }
}

function validatePacket(packet) {
  if (!Number.isFinite(packet.pts) || !Number.isFinite(packet.duration) || packet.duration < 0) {
    throw new TypeError("Packet presentation time and duration are required.");
  }
  const ranges = normalizeRanges(packet.ranges);
  if (ranges.length === 0) throw new TypeError("Packet byte addresses are required.");
  if (packet.dts !== undefined && !Number.isFinite(packet.dts)) throw new TypeError("Packet decode time must be finite.");
  if (packet.discardPaddingSeconds !== undefined && !Number.isSafeInteger(Math.round(packet.discardPaddingSeconds * 1e9))) {
    throw new TypeError("Packet discard padding must have an exact finite duration.");
  }
  if (packet.expectedHash !== undefined && !/^[a-f0-9]{64}$/.test(packet.expectedHash)) throw new TypeError("Packet SHA-256 must be hexadecimal.");
  if ((packet.bitOffset === undefined) !== (packet.bitLength === undefined)) throw new TypeError("Packet bit addresses need both offset and length.");
  if (packet.bitOffset !== undefined && (!Number.isSafeInteger(packet.bitOffset) || packet.bitOffset < 0 ||
      !Number.isSafeInteger(packet.bitLength) || packet.bitLength <= 0 || packet.bitLength % 8 !== 0 ||
      packet.bitOffset + packet.bitLength > ranges.reduce((sum, [start, end]) => sum + end - start + 1, 0) * 8)) {
    throw new TypeError("Packet payload bit addresses are invalid.");
  }
  return ranges;
}

/** Inclusive byte ranges, merged without filling gaps between separate packets. */
function normalizeRanges(ranges) {
  const ordered = ranges.map(([start, end]) => {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      throw new TypeError("Invalid packet byte range.");
    }
    return [start, end];
  }).sort((left, right) => left[0] - right[0]);
  const result = [];
  for (const range of ordered) {
    const previous = result[result.length - 1];
    if (previous && range[0] <= previous[1] + 1) previous[1] = Math.max(previous[1], range[1]);
    else result.push(range);
  }
  return result;
}
