import { readTrackEdits, walkBoxes } from "./mp4-boxes.js";

/**
 * A closed piece as it is served.
 *
 * THE PICTURE STAYS CUT WHERE THE MUXER CUT IT: from its keyframe to the next,
 * in decode order. In an open GOP the pictures decoded right after a keyframe
 * can be shown before it — its leading pictures — and they reference the
 * group before; they belong to the piece of their keyframe and are shown a
 * little before its cut. Moving them into the previous piece with a copy of
 * the keyframe (torrent-tv/meta#154) left a hole on every such cut: appending
 * the next piece replaces that copy, and Media Source coded frame processing
 * then removes every frame decoded after it up to the next random access point
 * — the leading pictures. Measured in Chrome Canary 2026-10-11 on the pieces
 * of a 1036p HEVC film: a hole of 0.292 s at 74.283 s; with the muxer's cut the
 * buffer is continuous (torrent-tv/meta#178).
 *
 * A SOUNDTRACK carried in the same piece is cut by presentation time at the
 * published grid, taking from the following piece what belongs before the cut.
 *
 * THE FIRST PIECE OF A RUN that started at its keyframe has leading pictures
 * the run could not make: their references lie before the start, and FFmpeg,
 * having no earlier packets, gives them presentation times at its own decode
 * clock (74.2000 s for pictures shown at 73.991-74.241 s). They are removed,
 * and where `leading` — the same keyframe's leading pictures from the run that
 * made the piece before, which FFmpeg closes past that run's last cut — is
 * given, those are put in their place on that run's decode clock.
 *
 * @param {Buffer} current - The closed piece, with its own init.
 * @param {Buffer | null} following - The piece the muxer closed after it.
 * @param {{ from: number, to: number }} interval - The piece's published stretch.
 * @param {{ firstOfRun?: boolean, leading?: Buffer | null }} [options]
 * @returns {Buffer}
 */
export function presentationSegment(current, following, { from, to }, { firstOfRun = false, leading = null } = {}) {
  const own = packetsOf(current);
  const next = following ? packetsOf(following) : null;
  const before = leading ? packetsOf(leading) : null;
  // A piece given the leading pictures of the run before is written on that
  // run's clock, under its init: that run decoded the group before the
  // keyframe, so its decode times lie earlier than this run's, and a decode
  // time cannot lie before the clock's origin. Every track moves by the
  // difference of the two inits' positions.
  const spliced = firstOfRun && before ? splicedPicture(own, before) : null;
  const clock = spliced ? before : own;
  const tracks = [];
  for (const [id, track] of own.tracks) {
    const edit = own.edits.get(id);
    if (!edit) throw new Error("A segment track has no declared clock.");
    const move = spliced ? edit.offset - clock.edits.get(id).offset : 0n;
    if (track.kind === "vide") {
      const samples = spliced?.id === id ? spliced.samples : firstOfRun ? withoutLeading(track.samples, edit) : track.samples;
      tracks.push({ id, samples: spliced?.id === id ? samples : samples.map(sample => ({ ...sample, dts: sample.dts + move })),
        timedByDecode: firstOfRun });
      continue;
    }
    const samples = [...track.samples].map(sample => ({ ...sample, dts: sample.dts + move }));
    if (next?.tracks.has(id)) {
      const nextEdit = next.edits.get(id);
      if (!nextEdit || nextEdit.timescale !== edit.timescale) throw new Error("Adjacent segment clocks differ.");
      for (const sample of next.tracks.get(id).samples) {
        samples.push({ ...sample, dts: sample.dts + nextEdit.offset - edit.offset + move });
      }
    }
    const start = BigInt(Math.round(from * Number(edit.timescale)));
    const end = BigInt(Math.round(to * Number(edit.timescale)));
    const offset = clock.edits.get(id).offset;
    const selected = samples.filter(sample => {
      const pts = sample.dts + sample.composition + offset;
      return pts < end && pts + sample.duration > start;
    });
    if (!selected.length) throw new Error("A presentation segment lacks required media.");
    selected.sort((left, right) => left.dts < right.dts ? -1 : left.dts > right.dts ? 1 : 0);
    tracks.push({ id, samples: selected });
  }
  return writePiece(clock.init, tracks);
}

/**
 * The leading pictures of a piece's keyframe, as a piece of their own (the
 * keyframe and the pictures decoded right after it that are shown before it),
 * or null when the keyframe has none. Kept from a run's flushed file past its
 * last cut for the run that starts at that keyframe.
 *
 * @param {Buffer} piece - A closed file, with its own init.
 * @returns {Buffer | null}
 */
export function leadingPictures(piece) {
  const own = packetsOf(piece);
  const tracks = [];
  for (const [id, track] of own.tracks) {
    if (track.kind !== "vide") continue;
    const edit = own.edits.get(id);
    const count = leadingCount(track.samples, edit);
    if (count > 0) tracks.push({ id, samples: track.samples.slice(0, count + 1) });
  }
  return tracks.length ? writePiece(own.init, tracks) : null;
}

/** How many pictures decoded right after the first one are shown before it. */
function leadingCount(samples, edit) {
  const first = samples[0];
  if (!first || (first.flags & SAMPLE_IS_NON_SYNC) !== 0) return 0;
  const shown = first.dts + first.composition + edit.offset;
  let count = 0;
  while (count + 1 < samples.length) {
    const sample = samples[count + 1];
    if (sample.dts + sample.composition + edit.offset >= shown) break;
    count += 1;
  }
  return count;
}

/** A run's first picture samples without the leading pictures it could not make. */
function withoutLeading(samples, edit) {
  return [samples[0], ...samples.slice(1 + leadingCount(samples, edit))];
}

/**
 * The picture of a run's first piece with its own leading pictures replaced by
 * the run before's, on the run before's clock: its keyframe and leading
 * pictures as that run decoded them, then this run's pictures from the first
 * one after them. Null — and the leading pictures are only removed — where the
 * two do not begin with the same keyframe, the clocks differ, any track has no
 * position in the other init, or the decode order would not move forward.
 */
function splicedPicture(own, before) {
  for (const [id, track] of own.tracks) {
    if (track.kind !== "vide") continue;
    const edit = own.edits.get(id);
    const theirs = before.tracks.get(id)?.samples;
    const theirEdit = before.edits.get(id);
    if (!edit || !theirs || theirs.length < 2 || !theirEdit || theirEdit.timescale !== edit.timescale) return null;
    if ([...own.tracks.keys()].some(other => !before.edits.has(other))) return null;
    const keyframe = track.samples[0];
    if (keyframe.dts + keyframe.composition + edit.offset !== theirs[0].dts + theirs[0].composition + theirEdit.offset ||
      !keyframe.bytes.equals(theirs[0].bytes)) return null;
    const move = edit.offset - theirEdit.offset;
    const rest = track.samples.slice(1 + leadingCount(track.samples, edit)).map(sample => ({ ...sample, dts: sample.dts + move }));
    if (rest.length && theirs.at(-1).dts >= rest[0].dts) return null;
    return { id, samples: [...theirs, ...rest] };
  }
  return null;
}

/** `sample_is_non_sync_sample` in the sample flags of ISO/IEC 14496-12. */
const SAMPLE_IS_NON_SYNC = 0x10000;

function writePiece(init, tracks) {
  const makeMoof = offset => box("moof", full("mfhd", 0, 0, u32(1)), ...tracks.map(track => {
    let decodeTime = track.samples[0].dts;
    const entries = track.samples.map((sample, index) => {
      // A picture taken from another run's decode clock keeps that clock, so
      // its duration in decode order is the step to the next decode time. Any
      // other sample keeps its own duration, and its presentation time is kept
      // relative to the decode clock actually written here.
      const following = track.samples[index + 1];
      const duration = track.timedByDecode && following ? following.dts - sample.dts : sample.duration;
      const composition = sample.dts + sample.composition - decodeTime;
      decodeTime += duration;
      return Buffer.concat([
        u32(Number(duration)), u32(sample.bytes.length), u32(sample.flags), i32(Number(composition))
      ]);
    });
    const payload = Buffer.concat([u32(track.samples.length), i32(offset), ...entries]);
    offset += track.samples.reduce((bytes, sample) => bytes + sample.bytes.length, 0);
    const clock = Buffer.alloc(8);
    clock.writeBigUInt64BE(track.samples[0].dts);
    return box("traf", full("tfhd", 0, 0x20000, u32(track.id)), full("tfdt", 1, 0, clock), full("trun", 1, 0xf01, payload));
  }));
  const size = makeMoof(0).length;
  return Buffer.concat([init, makeMoof(size + 8), box("mdat", ...tracks.flatMap(track => track.samples.map(sample => sample.bytes)))]);
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
