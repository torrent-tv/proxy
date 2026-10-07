import { readTrackEdits, walkBoxes } from "./mp4-boxes.js";

/** Repartition closed muxer output by presentation interval, preserving decode order. */
export function presentationSegment(current, following, { from, to }) {
  const own = packetsOf(current);
  const next = following ? packetsOf(following) : null;
  const tracks = [];
  for (const [id, track] of own.tracks) {
    const edit = own.edits.get(id);
    if (!edit) throw new Error("A segment track has no declared clock.");
    const samples = [...track.samples];
    if (next?.tracks.has(id)) {
      const nextEdit = next.edits.get(id);
      if (!nextEdit || nextEdit.timescale !== edit.timescale) throw new Error("Adjacent segment clocks differ.");
      for (const sample of next.tracks.get(id).samples) {
        samples.push({ ...sample, dts: sample.dts + nextEdit.offset - edit.offset });
      }
    }
    const start = BigInt(Math.round(from * Number(edit.timescale)));
    const end = BigInt(Math.round(to * Number(edit.timescale)));
    const wanted = samples.filter(sample => {
      const pts = sample.dts + sample.composition + edit.offset;
      return pts < end && (track.kind === "vide" ? pts >= start : pts + sample.duration > start);
    });
    if (!wanted.length) throw new Error("A presentation segment lacks required media.");
    // An open-GOP picture before the cut can follow the next CRA in decode
    // order. Retain the reference pictures through its last required DTS;
    // dropping the CRA would make the recovered leading pictures undecodable.
    const lastDecode = wanted.reduce((last, sample) => sample.dts > last ? sample.dts : last, -1n);
    const firstDecode = wanted.reduce((first, sample) => first === null || sample.dts < first ? sample.dts : first, null);
    const selected = track.kind === "vide" ? samples.filter(sample =>
      sample.dts >= firstDecode && sample.dts <= lastDecode && sample.dts + sample.composition + edit.offset >= start) : wanted;
    selected.sort((left, right) => left.dts < right.dts ? -1 : left.dts > right.dts ? 1 : 0);
    tracks.push({ id, samples: selected });
  }
  const makeMoof = offset => box("moof", full("mfhd", 0, 0, u32(1)), ...tracks.map(track => {
    let decodeTime = track.samples[0].dts;
    const entries = track.samples.map(sample => {
      // Removing leading pictures can leave a gap in decode timestamps.
      // trun advances by durations only; retain each original presentation
      // timestamp relative to the decode clock actually written here.
      const composition = sample.dts + sample.composition - decodeTime;
      decodeTime += sample.duration;
      return Buffer.concat([
        u32(Number(sample.duration)), u32(sample.bytes.length), u32(sample.flags), i32(Number(composition))
      ]);
    });
    const payload = Buffer.concat([u32(track.samples.length), i32(offset), ...entries]);
    offset += track.samples.reduce((bytes, sample) => bytes + sample.bytes.length, 0);
    const clock = Buffer.alloc(8);
    clock.writeBigUInt64BE(track.samples[0].dts);
    return box("traf", full("tfhd", 0, 0x20000, u32(track.id)), full("tfdt", 1, 0, clock), full("trun", 1, 0xf01, payload));
  }));
  const size = makeMoof(0).length;
  return Buffer.concat([own.init, makeMoof(size + 8), box("mdat", ...tracks.flatMap(track => track.samples.map(sample => sample.bytes)))]);
}

function packetsOf(raw) {
  const edits = readTrackEdits(raw);
  const tracks = new Map();
  const defaults = new Map();
  const payloads = [];
  walkBoxes(raw, (type, start, end) => { if (type === "mdat") payloads.push([start, end]); }, 0, raw.length, () => false);
  let id = null, firstMoof = null;
  walkBoxes(raw, (type, start) => {
    if (type === "tkhd") id = raw.readUInt32BE(start + (raw[start] === 1 ? 20 : 12));
    if (type === "hdlr" && id !== null) tracks.set(id, { kind: raw.toString("latin1", start + 8, start + 12), samples: [] });
    if (type === "trex") defaults.set(raw.readUInt32BE(start + 4), {
      duration: raw.readUInt32BE(start + 12), size: raw.readUInt32BE(start + 16), flags: raw.readUInt32BE(start + 20)
    });
  });
  walkBoxes(raw, (type, start, end) => {
    if (type !== "moof") return;
    const moof = start - 8;
    firstMoof ??= moof;
    walkBoxes(raw, (type, trafStart, trafEnd) => {
      if (type !== "traf") return;
      let trackId, clock = 0n, base = moof, data = null, values;
      walkBoxes(raw, (type, at, boxEnd) => {
        if (type === "tfhd") {
          const flags = raw.readUIntBE(at + 1, 3);
          trackId = raw.readUInt32BE(at + 4);
          values = { ...defaults.get(trackId) };
          let cursor = at + 8;
          if (flags & 1) { base = Number(raw.readBigUInt64BE(cursor)); cursor += 8; }
          if (flags & 2) cursor += 4;
          for (const [flag, field] of [[8, "duration"], [16, "size"], [32, "flags"]]) {
            if (flags & flag) { values[field] = raw.readUInt32BE(cursor); cursor += 4; }
          }
        } else if (type === "tfdt") {
          clock = raw[at] === 1 ? raw.readBigUInt64BE(at + 4) : BigInt(raw.readUInt32BE(at + 4));
        } else if (type === "trun") {
          if (!tracks.has(trackId) || !values) throw new Error("Fragment refers to an undeclared track.");
          const flags = raw.readUIntBE(at + 1, 3), count = raw.readUInt32BE(at + 4);
          let cursor = at + 8, firstFlags = null;
          if (flags & 1) { data = base + raw.readInt32BE(cursor); cursor += 4; }
          if (flags & 4) { firstFlags = raw.readUInt32BE(cursor); cursor += 4; }
          if (data === null) throw new Error("Fragment has no explicit payload location.");
          for (let index = 0; index < count; index++) {
            const sample = { ...values, composition: 0n, dts: clock };
            if (index === 0 && firstFlags !== null) sample.flags = firstFlags;
            for (const [flag, field] of [[0x100, "duration"], [0x200, "size"], [0x400, "flags"], [0x800, "composition"]]) {
              if (flags & flag) {
                if (cursor + 4 > boxEnd) throw new Error("Fragment sample declaration is truncated.");
                sample[field] = field === "composition" ? BigInt(raw[at] === 1 ? raw.readInt32BE(cursor) : raw.readUInt32BE(cursor)) : raw.readUInt32BE(cursor);
                cursor += 4;
              }
            }
            if (!(sample.duration > 0) || !(sample.size > 0) || !Number.isSafeInteger(data) ||
              !payloads.some(([start, end]) => data >= start && data + sample.size <= end)) throw new Error("Fragment sample bytes are incomplete.");
            sample.duration = BigInt(sample.duration);
            sample.bytes = raw.subarray(data, data + sample.size);
            tracks.get(trackId).samples.push(sample);
            data += sample.size;
            clock += sample.duration;
          }
        }
      }, trafStart, trafEnd, () => false);
    }, start, end, () => false);
  }, 0, raw.length, () => false);
  if (firstMoof === null) throw new Error("A closed segment has no fragments.");
  if (tracks.size === 0 || [...tracks.values()].some(track => track.samples.length === 0)) throw new Error("A closed segment lacks declared track samples.");
  return { init: raw.subarray(0, firstMoof), edits, tracks };
}

function box(type, ...parts) { const payload = Buffer.concat(parts); return Buffer.concat([u32(payload.length + 8), Buffer.from(type), payload]); }
function full(type, version, flags, payload) { const header = Buffer.alloc(4); header[0] = version; header.writeUIntBE(flags, 1, 3); return box(type, header, payload); }
function u32(value) { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; }
function i32(value) { const bytes = Buffer.alloc(4); bytes.writeInt32BE(value); return bytes; }
