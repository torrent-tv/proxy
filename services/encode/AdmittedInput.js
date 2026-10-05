import { createHash } from "node:crypto";
import { matroskaInput, matroskaTrackIdentity } from "./MatroskaInput.js";
import { pcmNormalization, normalizePcmSlices } from "./pcm-normalization.js";

/** Acquire complete source ranges before any process can consume the input. */
export async function admitInput({ sources, reserve, readRanges }) {
  if (!Array.isArray(sources) || sources.length === 0 || typeof reserve !== "function" || typeof readRanges !== "function") {
    throw new TypeError("Admission requires resolved source inputs, memory reservation and an available-only reader.");
  }
  const bytes = sources.reduce((total, source) => total + source.input.ranges.reduce((sum, [start, end]) => sum + end - start + 1, 0) +
    source.input.tracks.reduce((sum, input) => sum + (pcmNormalization(input.track)
      ? input.packets.reduce((size, packet) => size + packet.ranges.reduce((n, [start, end]) => n + end - start + 1, 0), 0) : 0), 0), 0);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new TypeError("Input byte count must be a positive safe integer.");
  const release = await reserve(bytes);
  if (typeof release !== "function") return release?.kind === "terminal" ? release : { kind: "needs-memory", bytes };
  let retained = false;
  try {
    const hash = createHash("sha256");
    const tracks = [];
    const held = new Map();
    const normalized = new Map();
    for (const source of sources) {
      const buffers = await readRanges(source, source.input.ranges, bytes);
      if (buffers === null) return { kind: "needs-bytes", sourceKey: source.sourceKey, fileIndex: source.fileIndex, ranges: source.input.ranges };
      if (!Array.isArray(buffers) || buffers.length !== source.input.ranges.length || buffers.some((buffer, index) =>
        !Buffer.isBuffer(buffer) || buffer.length !== source.input.ranges[index][1] - source.input.ranges[index][0] + 1)) {
        throw new Error("Available-only input reader returned incomplete ranges.");
      }
      hash.update(JSON.stringify(source.input.ranges));
      for (const buffer of buffers) {
        hash.update(String(buffer.length));
        hash.update(":");
        hash.update(buffer);
      }
      for (const input of source.input.tracks) {
        const shifted = { ...input,
          ...(Number.isFinite(input.sourceEndSeconds) ? { sourceEndSeconds: input.sourceEndSeconds - (source.timeShiftSeconds ?? 0) } : {}),
          packets: input.packets.map(packet => ({ ...packet,
          pts: packet.pts - (source.timeShiftSeconds ?? 0),
          ...(packet.dts === undefined ? {} : { dts: packet.dts - (source.timeShiftSeconds ?? 0) }) })) };
        tracks.push(shifted);
        hash.update(matroskaTrackIdentity(input.track));
        hash.update(JSON.stringify(shifted.packets.map(packet => [packet.pts, packet.dts ?? null,
          packet.duration, packet.keyframe === true, packet.ranges, packet.discardPaddingSeconds ?? 0,
          packet.bitOffset ?? null, packet.bitLength ?? null])));
        held.set(shifted, { ranges: source.input.ranges, buffers });
      }
    }
    let released = false;
    const originSeconds = tracks.reduce((origin, input) => input.packets.reduce((value, packet) => Math.min(value, packet.pts), origin), Infinity);
    if (!Number.isFinite(originSeconds)) throw new Error("Admitted input contains no packets.");
    const packetSlices = (input, packet) => {
      if (released) throw new Error("Admitted input has been released.");
      const source = held.get(input);
      if (!source) throw new Error("Packet does not belong to this admitted input.");
      return packet.ranges.map(([start, end]) => {
        const position = source.ranges.findIndex(([from, to]) => from <= start && end <= to);
        if (position < 0) throw new Error("Packet is outside its admitted ranges.");
        return source.buffers[position].subarray(start - source.ranges[position][0], end - source.ranges[position][0] + 1);
      });
    };
    const readPacket = (input, packet) => {
      const slices = packetSlices(input, packet);
      return slices.length === 1 ? slices[0] : Buffer.concat(slices);
    };
    for (const input of tracks) {
      for (const packet of input.packets) {
        const slices = packetSlices(input, packet);
        if (packet.expectedHash !== undefined) {
          const payloadHash = createHash("sha256");
          for (const slice of slices) payloadHash.update(slice);
          if (payloadHash.digest("hex") !== packet.expectedHash) {
            return { kind: "terminal", reason: "packet-address-does-not-match-payload", trackId: input.track.trackNumber,
              ranges: packet.ranges };
          }
        }
        const format = pcmNormalization(input.track);
        if (format) normalized.set(packet, normalizePcmSlices(slices, format));
      }
    }
    retained = true;
    return {
      kind: "result", bytes, fingerprint: hash.digest("hex"), originSeconds, tracks, readPacket,
      stream: options => matroskaInput({ tracks,
        readPacket: (input, packet) => normalized.has(packet) ? [normalized.get(packet)] : packetSlices(input, packet),
        originSeconds, ...options }),
      release: () => {
        if (released) return;
        released = true;
        held.clear();
        normalized.clear();
        release();
      }
    };
  } finally {
    if (!retained) release();
  }
}

/** Respect stdin backpressure and release input on every completion path. */
export async function writeAdmittedInput(input, stdin, { next = null } = {}) {
  if (input?.kind !== "result") throw new TypeError("Only complete input may be written to an encoder.");
  const originSeconds = input.originSeconds;
  const declarations = JSON.stringify(input.tracks.map(input => matroskaTrackIdentity(input.track)));
  const seen = new Map();
  let current = input, includeHeader = true;
  try {
    while (current) {
    if (JSON.stringify(current.tracks.map(input => matroskaTrackIdentity(input.track))) !== declarations) {
      throw new Error("Consecutive encoder input changed its declared tracks.");
    }
    for (let index = 0; index < current.tracks.length; index++) {
      const end = current.tracks[index].sourceEndSeconds;
      if (Number.isFinite(end)) input.tracks[index].sourceEndSeconds = end;
    }
    for await (const chunk of current.stream({ originSeconds, includeHeader, seen })) {
      await new Promise((resolve, reject) => {
        const failed = error => { stdin.off("error", failed); reject(error); };
        stdin.once("error", failed);
        stdin.write(chunk, error => {
          stdin.off("error", failed);
          if (error) reject(error);
          else resolve();
        });
      });
    }
    current.release();
    current = next ? await next() : null;
    includeHeader = false;
    }
    stdin.end();
  } finally {
    current?.release();
    input.release();
  }
}
