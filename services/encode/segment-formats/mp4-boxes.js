/**
 * @file Minimal ISO Base Media File Format (ISO/IEC 14496-12) box reader/writer.
 *
 * Only what the fMP4 segment format needs: read the per-track media timescale
 * out of an init segment, and rewrite each fragment's
 * `tfdt` (TrackFragmentBaseMediaDecodeTime) so a segment states where it sits
 * on the media timeline. Deliberately tiny and dependency-free — it never
 * descends into `mdat` (the payload), so cost is proportional to the header,
 * not to the segment size.
 */

/**
 * Container boxes whose payload is a sequence of child boxes. Anything else is
 * treated as a leaf, so `mdat` (the media payload) is never walked into.
 *
 * @type {ReadonlySet<string>}
 */
const CONTAINER_BOXES = new Set(["moov", "mvex", "trak", "mdia", "minf", "stbl", "edts", "moof", "traf"]);

/**
 * Walk the box tree, invoking `visit` for every box encountered.
 *
 * @param {Buffer} buffer
 * @param {(type: string, bodyStart: number, bodyEnd: number) => void} visit
 *   `bodyStart`/`bodyEnd` delimit the box payload (header excluded).
 * @param {number} [start=0]
 * @param {number} [end=buffer.length]
 * @param {(type: string) => boolean} [descend] - Whether to walk into a box's
 *   payload. The default is the container list above, which is what every
 *   reader of a whole tree wants. A caller that needs to know WHOSE child a box
 *   is passes `() => false` and recurses itself, because a walk that descends
 *   for you cannot say which parent it descended from.
 * @returns {void}
 */
export function walkBoxes(buffer, visit, start = 0, end = buffer.length, descend = (type) => CONTAINER_BOXES.has(type)) {
  let offset = start;
  while (offset + 8 <= end) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      // 64-bit `largesize` follows the type.
      if (offset + 16 > end) {
        return;
      }
      size = Number(buffer.readBigUInt64BE(offset + 8));
      headerSize = 16;
    } else if (size === 0) {
      // "to end of file"
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) {
      return; // truncated or malformed — stop rather than read out of bounds
    }
    visit(type, offset + headerSize, offset + size);
    if (descend(type)) {
      walkBoxes(buffer, visit, offset + headerSize, offset + size, descend);
    }
    offset += size;
  }
}

/**
 * Media timescale (ticks per second) of every track in an init segment, keyed
 * by track id. `tfdt` values are expressed in this unit, so it is required to
 * convert a wall-clock position into a `baseMediaDecodeTime`.
 *
 * Read from each track's `tkhd` (track id) + `mdia/mdhd` (timescale) pair;
 * within a `trak` the `tkhd` always precedes the `mdhd`, so a single ordered
 * pass pairs them correctly.
 *
 * @param {Buffer} initSegment
 * @returns {Map<number, number>} trackId → timescale
 */
export function readTrackTimescales(initSegment) {
  const timescales = new Map();
  let currentTrackId = null;
  walkBoxes(initSegment, (type, bodyStart) => {
    if (type === "tkhd") {
      const version = initSegment[bodyStart];
      // v1 widens creation/modification time to 64 bit, moving track_id by 8.
      const trackIdOffset = version === 1 ? bodyStart + 20 : bodyStart + 12;
      if (trackIdOffset + 4 <= initSegment.length) {
        currentTrackId = initSegment.readUInt32BE(trackIdOffset);
      }
    } else if (type === "mdhd" && currentTrackId !== null) {
      const version = initSegment[bodyStart];
      const timescaleOffset = version === 1 ? bodyStart + 20 : bodyStart + 12;
      if (timescaleOffset + 4 <= initSegment.length) {
        timescales.set(currentTrackId, initSegment.readUInt32BE(timescaleOffset));
      }
      currentTrackId = null;
    }
  });
  return timescales;
}

/**
 * `numerator / denominator` rounded half up, for non-negative operands.
 *
 * An edit list states a track's position in the MOVIE timescale and `tfdt` is
 * an integer in the TRACK timescale, so writing a position into a fragment
 * rounds once. This is that rounding, stated in one place so the writer of a
 * position ({@link rebaseSegmentDecodeTimes}) and every reader of it
 * ({@link readPresentationRanges}) agree to the tick.
 *
 * @param {bigint} numerator
 * @param {bigint} denominator
 * @returns {bigint}
 */
function roundedQuotient(numerator, denominator) {
  return (2n * numerator + denominator) / (2n * denominator);
}

/**
 * Where each track's media time zero is presented, in that track's own ticks:
 * the leading empty edits of its `elst`, converted from the movie timescale,
 * minus the `media_time` of its first real edit. A track with no edit list is
 * presented as its media time.
 *
 * @param {Buffer} initSegment
 * @returns {Map<number, { timescale: bigint, offset: bigint }>}
 */
export function readTrackEdits(initSegment) {
  const edits = new Map([...readTrackTimescales(initSegment)].map(([id, timescale]) =>
    [id, { timescale: BigInt(timescale), offset: 0n }]));
  let movieTimescale = 0n;
  let trackId = null;
  walkBoxes(initSegment, (type, start, end) => {
    const version = initSegment[start];
    if (type === "mvhd") {
      const at = start + (version === 1 ? 20 : 12);
      if (at + 4 <= end) movieTimescale = BigInt(initSegment.readUInt32BE(at));
    } else if (type === "tkhd") {
      const at = start + (version === 1 ? 20 : 12);
      if (at + 4 <= end) trackId = initSegment.readUInt32BE(at);
    } else if (type === "elst" && edits.has(trackId) && movieTimescale > 0n && start + 8 <= end) {
      const edit = edits.get(trackId);
      const count = initSegment.readUInt32BE(start + 4);
      const width = version === 1 ? 20 : 12;
      let emptyTicks = 0n;
      // A list of empty edits alone still places the track: its media follows
      // them from media time zero, which is where `readSelfContainedStartSeconds`
      // reads a piece's start from.
      let mediaTime = 0n;
      for (let entry = 0, at = start + 8; entry < count && at + width <= end; entry++, at += width) {
        const duration = version === 1 ? initSegment.readBigUInt64BE(at) : BigInt(initSegment.readUInt32BE(at));
        const entryMediaTime = version === 1 ? initSegment.readBigInt64BE(at + 8) : BigInt(initSegment.readInt32BE(at + 4));
        if (entryMediaTime === -1n) {
          emptyTicks += duration;
        } else {
          mediaTime = entryMediaTime;
          break;
        }
      }
      edit.offset = roundedQuotient(emptyTicks * edit.timescale, movieTimescale) - mediaTime;
      // movenc writes a positive empty edit with AV_ROUND_DOWN. Keep the
      // uncertainty of that position separate from the served timestamps.
      if (emptyTicks > 0n) {
        edit.positionErrorTicks = (edit.timescale + movieTimescale - 1n) / movieTimescale;
      }
    }
  });
  return edits;
}

/** An init shared across seeks has no segment-specific empty edit. */
export function neutralizeEmptyEdits(initSegment, { audioEncoderDelay = 0 } = {}) {
  const neutral = Buffer.from(initSegment);
  const audioTracks = new Set();
  let trackId = null;
  if (audioEncoderDelay > 0) walkBoxes(neutral, (type, start, end) => {
    if (type === "tkhd") {
      const at = start + (neutral[start] === 1 ? 20 : 12);
      if (at + 4 <= end) trackId = neutral.readUInt32BE(at);
    } else if (type === "hdlr" && start + 12 <= end && neutral.toString("latin1", start + 8, start + 12) === "soun") {
      audioTracks.add(trackId);
    }
  });
  trackId = null;
  walkBoxes(neutral, (type, start, end) => {
    if (type === "tkhd") {
      const at = start + (neutral[start] === 1 ? 20 : 12);
      if (at + 4 <= end) trackId = neutral.readUInt32BE(at);
    }
    if (type !== "elst" || start + 8 > end) return;
    const version = neutral[start];
    const width = version === 1 ? 20 : 12;
    const count = neutral.readUInt32BE(start + 4);
    for (let entry = 0, at = start + 8; entry < count && at + width <= end; entry++, at += width) {
      const mediaTime = version === 1 ? neutral.readBigInt64BE(at + 8) : BigInt(neutral.readInt32BE(at + 4));
      if (mediaTime !== -1n) {
        // Native AAC emits 1024 samples of encoder delay (aacenc.c).
        // A later run's positive start can hide that delay in an empty edit.
        // The shared origin must also represent the first run's negative DTS.
        if (audioTracks.has(trackId) && mediaTime < BigInt(audioEncoderDelay)) {
          if (version === 1) neutral.writeBigInt64BE(BigInt(audioEncoderDelay), at + 8);
          else neutral.writeInt32BE(audioEncoderDelay, at + 4);
        }
        continue;
      }
      if (version === 1) neutral.writeBigUInt64BE(0n, at);
      else neutral.writeUInt32BE(0, at);
    }
  });
  return neutral;
}

/**
 * Place a piece made with its own init on the timeline of the session's init:
 * every `tfdt` moves by the difference of the two inits' track positions
 * ({@link readTrackEdits}), in integer ticks.
 *
 * @param {Buffer} segment - The piece's fragments, its own `moov` removed.
 * @param {Buffer} ownInit
 * @param {Buffer} sessionInit
 * @returns {Buffer}
 */
export function rebaseSegmentDecodeTimes(segment, ownInit, sessionInit) {
  const own = readTrackEdits(ownInit);
  const session = readTrackEdits(sessionInit);
  const stamped = Buffer.from(segment);
  let trackId = null;
  walkBoxes(stamped, (type, start, end) => {
    if (type === "tfhd" && start + 8 <= end) {
      trackId = stamped.readUInt32BE(start + 4);
    } else if (type === "tfdt" && own.has(trackId) && session.has(trackId)) {
      const version = stamped[start];
      if (start + (version === 1 ? 12 : 8) > end) return;
      if (own.get(trackId).timescale !== session.get(trackId).timescale) {
        throw new Error(`Track ${trackId} counts ${own.get(trackId).timescale} ticks a second in its piece ` +
          `and ${session.get(trackId).timescale} in the session's init.`);
      }
      const existing = version === 1 ? stamped.readBigUInt64BE(start + 4) : BigInt(stamped.readUInt32BE(start + 4));
      const value = existing + own.get(trackId).offset - session.get(trackId).offset;
      if (value < 0n) throw new Error("A fragment cannot be placed before its shared init's decode origin.");
      if (version === 1) stamped.writeBigUInt64BE(value, start + 4);
      else if (value <= 0xffffffffn) stamped.writeUInt32BE(Number(value), start + 4);
      else throw new Error("Fragment decode time exceeds its 32-bit field.");
    }
  });
  return stamped;
}

/** `sample_is_non_sync_sample` in the sample flags of ISO/IEC 14496-12. */
const SAMPLE_IS_NON_SYNC = 0x10000;

/**
 * What a piece's samples say about the media it holds, per track, in integer
 * ticks of that track's timescale: presentation intervals (decode time plus
 * composition offset, plus the track's position) joined only where they touch
 * or overlap, as they are written. Nothing is joined across a gap here: whether
 * a browser closes a gap is a fact about the browser, and it is decided in the
 * viewer component, which models the viewer's browser.
 *
 * Each range carries `frame`, the duration Gecko gives an inserted interval as
 * twice its fuzz: the longest frame since the last keyframe
 * (`TrackBuffersManager::ProcessFrames` keeps it, `InsertFrames` applies it to
 * a batch of frames). The engine does not state whether a batch is one fragment
 * or the whole appended piece, so the smaller of the two values is taken; a
 * merged range keeps the larger of its parts, as `Interval::Span` does.
 *
 * @param {Buffer} raw - An init followed by fragments, or a self-contained piece.
 * @returns {{ tracks: Array<{ id: number, kind: string | undefined, timescale: bigint,
 *   ranges: Array<{ start: bigint, end: bigint, frame: bigint }> }> }}
 */
export function readPresentationRanges(raw) {
  const edits = readTrackEdits(raw);
  const frames = new Map();
  const defaults = new Map();
  const kinds = new Map();
  let declaredTrack = null;
  let trackId = null;
  let fragment = 0;
  let decodeTime = 0n;
  let defaultDuration = 0n;
  let defaultFlags = 0;
  walkBoxes(raw, (type, start, end) => {
    if (type === "tkhd") {
      const at = start + (raw[start] === 1 ? 20 : 12);
      if (at + 4 <= end) declaredTrack = raw.readUInt32BE(at);
    } else if (type === "hdlr" && start + 12 <= end) {
      kinds.set(declaredTrack, raw.toString("latin1", start + 8, start + 12));
    } else if (type === "trex" && start + 24 <= end) {
      defaults.set(raw.readUInt32BE(start + 4), {
        duration: BigInt(raw.readUInt32BE(start + 12)), flags: raw.readUInt32BE(start + 20)
      });
    } else if (type === "tfhd" && start + 8 <= end) {
      const flags = raw.readUIntBE(start + 1, 3);
      trackId = raw.readUInt32BE(start + 4);
      fragment += 1;
      defaultDuration = defaults.get(trackId)?.duration ?? 0n;
      defaultFlags = defaults.get(trackId)?.flags ?? 0;
      let at = start + 8 + ((flags & 0x1) ? 8 : 0) + ((flags & 0x2) ? 4 : 0);
      if ((flags & 0x8) && at + 4 <= end) defaultDuration = BigInt(raw.readUInt32BE(at));
      at += (flags & 0x8) ? 4 : 0;
      at += (flags & 0x10) ? 4 : 0;
      if ((flags & 0x20) && at + 4 <= end) defaultFlags = raw.readUInt32BE(at);
    } else if (type === "tfdt" && start + (raw[start] === 1 ? 12 : 8) <= end) {
      decodeTime = raw[start] === 1 ? raw.readBigUInt64BE(start + 4) : BigInt(raw.readUInt32BE(start + 4));
    } else if (type === "trun" && edits.has(trackId) && start + 8 <= end) {
      const offset = edits.get(trackId).offset;
      const flags = raw.readUIntBE(start + 1, 3);
      const count = raw.readUInt32BE(start + 4);
      let at = start + 8 + ((flags & 0x1) ? 4 : 0);
      const firstFlags = (flags & 0x4) ? raw.readUInt32BE(at) : null;
      at += (flags & 0x4) ? 4 : 0;
      const width = Number(Boolean(flags & 0x100)) * 4 + Number(Boolean(flags & 0x200)) * 4 +
        Number(Boolean(flags & 0x400)) * 4 + Number(Boolean(flags & 0x800)) * 4;
      const samples = frames.get(trackId) ?? [];
      for (let sample = 0; sample < count && at + width <= end; sample++) {
        const duration = (flags & 0x100) ? BigInt(raw.readUInt32BE(at)) : defaultDuration;
        if (flags & 0x100) at += 4;
        if (flags & 0x200) at += 4;
        let sampleFlags = sample === 0 && firstFlags !== null ? firstFlags : defaultFlags;
        if (flags & 0x400) {
          sampleFlags = raw.readUInt32BE(at);
          at += 4;
        }
        const composition = (flags & 0x800)
          ? BigInt(raw[start] === 1 ? raw.readInt32BE(at) : raw.readUInt32BE(at))
          : 0n;
        if (flags & 0x800) at += 4;
        if (!(duration > 0n)) break;
        samples.push({
          start: decodeTime + composition + offset,
          duration,
          keyframe: (sampleFlags & SAMPLE_IS_NON_SYNC) === 0,
          fragment
        });
        decodeTime += duration;
      }
      frames.set(trackId, samples);
    }
  });
  const tracks = [];
  for (const [id, samples] of frames) {
    // Gecko's longest frame since the last keyframe, in decode order, at the
    // end of each fragment and at the end of the piece.
    let longest = 0n;
    const longestAtFragmentEnd = new Map();
    for (const sample of samples) {
      longest = sample.keyframe || sample.duration > longest ? sample.duration : longest;
      longestAtFragmentEnd.set(sample.fragment, longest);
    }
    const ranges = [];
    const inPresentationOrder = [...samples].sort((left, right) =>
      (left.start < right.start ? -1 : left.start > right.start ? 1 : 0));
    for (const sample of inPresentationOrder) {
      const atFragmentEnd = longestAtFragmentEnd.get(sample.fragment);
      const frame = atFragmentEnd < longest ? atFragmentEnd : longest;
      const end = sample.start + sample.duration;
      const previous = ranges.at(-1);
      if (previous && sample.start <= previous.end) {
        previous.end = end > previous.end ? end : previous.end;
        previous.frame = frame > previous.frame ? frame : previous.frame;
      } else {
        ranges.push({ start: sample.start, end, frame });
      }
    }
    const edit = edits.get(id);
    const productionFrame = samples.reduce((maximum, sample) => sample.duration > maximum ? sample.duration : maximum, 0n);
    tracks.push({ id, kind: kinds.get(id), timescale: edit.timescale, productionFrame, ranges,
      firstSampleStart: samples[0].start, positionErrorTicks: edit.positionErrorTicks ?? 0n });

  }
  return { tracks };
}

/**
 * How far a closed piece holds media on every track, in seconds of the piece's
 * own timeline, or null when a track holds none. Compared with the cut the
 * piece was asked to reach, it says whether the encoder finished the piece.
 * That is a fact of production, so no browser behaviour enters it.
 *
 * @param {{ tracks: Array<{ timescale: bigint, ranges: Array<{ end: bigint }> }> }} coverage
 * @returns {number | null}
 */
export function producedThroughSeconds(coverage) {
  const tracks = coverage?.tracks ?? [];
  if (tracks.length === 0 || tracks.some(({ ranges }) => ranges.length === 0)) {
    return null;
  }
  return Math.min(...tracks.map(({ timescale, ranges }) => Number(ranges.at(-1).end) / Number(timescale)));
}

/**
 * The media a piece holds on the timeline its served bytes declare, in exact
 * ticks. Given the session's init, every track moves by that init's position
 * ({@link readTrackEdits}), which is what the bytes the browser receives state;
 * without one, the piece's own presentation timeline is returned. A
 * multiplexed piece is playable only where every track holds media, so tracks
 * are intersected in the least common multiple of their timescales; an
 * intersected range keeps the smaller `frame`.
 *
 * @param {{ tracks: Array<{ id: number, timescale: bigint,
 *   ranges: Array<{ start: bigint, end: bigint, frame: bigint }> }> }} coverage
 * @param {Buffer | null} sessionInit
 * @returns {{ timescale: bigint | null, ranges: Array<{ start: bigint, end: bigint, frame: bigint }> }}
 */
export function servedPresentationRanges(coverage, sessionInit) {
  const tracks = coverage?.tracks ?? [];
  if (tracks.length === 0) {
    return { timescale: null, ranges: [] };
  }
  const session = sessionInit?.length ? readTrackEdits(sessionInit) : new Map();
  const gcd = (left, right) => (right === 0n ? left : gcd(right, left % right));
  const common = tracks.reduce((scale, { timescale }) => scale / gcd(scale, timescale) * timescale, 1n);
  const placed = tracks.map(({ id, timescale, ranges }) => {
    const shift = -(session.get(id)?.offset ?? 0n);
    const factor = common / timescale;
    return ranges.map(({ start, end, frame }) => ({
      start: (start + shift) * factor, end: (end + shift) * factor, frame: frame * factor
    }));
  });
  const ranges = placed.slice(1).reduce((held, other) => held.flatMap((left) => other.map((right) => ({
    start: left.start > right.start ? left.start : right.start,
    end: left.end < right.end ? left.end : right.end,
    frame: left.frame < right.frame ? left.frame : right.frame
  })).filter(({ start, end }) => end > start)), placed[0]);
  return { timescale: common, ranges };
}

/**
 * Rewrite every fragment's `tfdt` so the segment declares that it starts at
 * `startSeconds` on the media timeline.
 *
 * WHY THIS IS NEEDED — ffmpeg's HLS/fMP4 output writes `tfdt = 0` in every
 * seek-restart run and records the run's start offset in an `elst` (edit list)
 * inside that run's init segment instead. That is self-consistent only while
 * the init and the segments come from the SAME run. We serve one init for the
 * whole session (the player fetches `#EXT-X-MAP` once and never re-fetches it),
 * so a post-seek segment read against the cached init loses its offset entirely
 * and appears to start at ~0 — the player finds nothing at the position it
 * seeked to, discards the segment and re-requests it, forever. Verified in the
 * field 2026-08-01: segments 402/403 re-fetched in a loop for over two minutes
 * at full link speed with the buffer stuck at 0 s, while the transcode itself
 * was healthy. No ffmpeg muxer/flag combination avoids this — HLS and DASH
 * muxers, `-copyts`, `-output_ts_offset`, `-itsoffset`, `-avoid_negative_ts`,
 * `-movflags -use_edts/+dash/+frag_discont/+global_sidx` were all measured and
 * all produce `tfdt = 0`.
 *
 * Stamping the true value restores what CMAF (ISO/IEC 23000-19) requires of an
 * independently-addressable segment anyway: it carries its own position, so it
 * is valid against any init for the same tracks.
 *
 * A SEGMENT MAY HOLD SEVERAL FRAGMENTS PER TRACK, so the segment's start is
 * applied as a SHIFT, not as a value written into every `tfdt`. The muxer that
 * takes explicit cut times uses `frag_keyframe`, which opens a fragment at each
 * keyframe, while a cut point is only every few keyframes — measured on the
 * field host: a 6 s piece carried three fragments per track, at 0, 2 and 4 s of
 * its own clock. Writing the segment's start into all three made them claim the
 * same decode time; the player rejected the segment and re-fetched it forever
 * (field 2026-08-04: segments 1 and 2 alternating for minutes, each served in
 * tens of milliseconds, transcode healthy at 12x). Each track's first fragment
 * therefore defines the base and the rest keep their distance from it. With one
 * fragment per track — what the `hls` muxer produces — a shift and a write are
 * the same thing, so both paths are served by this.
 *
 * Mutates a copy; the caller's buffer is untouched.
 *
 * @param {Buffer} segment
 * @param {number} startSeconds - Position of this segment on the 0-based output timeline.
 * @param {Map<number, number>} trackTimescales - From {@link readTrackTimescales}.
 * @returns {Buffer} The segment with corrected `tfdt` values.
 */
export function stampSegmentStartTime(segment, startSeconds, trackTimescales) {
  if (!Number.isFinite(startSeconds) || startSeconds < 0 || trackTimescales.size === 0) {
    return segment;
  }
  const stamped = Buffer.from(segment);
  // `tfhd` carries the track id and always precedes the `tfdt` inside the same
  // `traf`, so an ordered pass pairs each `tfdt` with its track's timescale.
  let currentTrackId = null;
  /** @type {Map<number, number>} trackId → decode time of that track's first fragment. */
  const fragmentBase = new Map();
  walkBoxes(stamped, (type, bodyStart, bodyEnd) => {
    if (type === "tfhd") {
      if (bodyStart + 8 <= bodyEnd) {
        currentTrackId = stamped.readUInt32BE(bodyStart + 4);
      }
      return;
    }
    if (type !== "tfdt" || currentTrackId === null) {
      return;
    }
    const timescale = trackTimescales.get(currentTrackId);
    if (!timescale) {
      return;
    }
    const version = stamped[bodyStart];
    if (version === 1 ? bodyStart + 12 > bodyEnd : bodyStart + 8 > bodyEnd) {
      return;
    }
    const existing =
      version === 1
        ? Number(stamped.readBigUInt64BE(bodyStart + 4))
        : stamped.readUInt32BE(bodyStart + 4);
    if (!fragmentBase.has(currentTrackId)) {
      fragmentBase.set(currentTrackId, existing);
    }
    // Distance from the track's first fragment in this segment. Never negative:
    // decode times only move forward, and a malformed one must not drag a later
    // fragment behind the segment's start.
    const withinSegment = Math.max(0, existing - (fragmentBase.get(currentTrackId) ?? 0));
    const value = Math.round(startSeconds * timescale) + withinSegment;
    if (version === 1) {
      stamped.writeBigUInt64BE(BigInt(value), bodyStart + 4);
    } else if (value <= 0xffffffff) {
      // A 32-bit field cannot express beyond ~2^32 ticks; leave it rather than
      // write a wrapped value (the player would land somewhere arbitrary).
      stamped.writeUInt32BE(value, bodyStart + 4);
    }
  });
  return stamped;
}

/**
 * Where a self-contained piece really begins, in seconds, or null.
 *
 * The `segment` muxer writes each piece with its own `moov`, and puts the
 * piece's position on the source timeline into an EMPTY EDIT at the head of the
 * track's edit list: an entry whose `media_time` is -1 and whose duration, in
 * the movie timescale, is the offset. That is the piece's own account of where
 * it sits, and it is the only honest one available.
 *
 * It matters because the alternative — the time the playlist ASSIGNED to that
 * segment — can be wrong. The playlist is built from the container's keyframe
 * index, and an index can list times that are not keyframes: measured
 * 2026-08-06 on a Matroska file whose index claimed one at 157.99 s while the
 * real keyframes were at 153.82 and 164.247. The cut therefore produced a piece
 * starting at 153.82, and stamping it with the playlist's 157.99 told the
 * player that picture belonged four seconds later than it did — while the
 * subtitles, extracted straight from the source, kept the true times. The
 * result was a steady 4.17 s desync between speech and text.
 *
 * @param {Buffer} piece
 * @returns {number | null} Seconds, or null when the piece carries no edit list.
 */
export function readSelfContainedStartSeconds(piece) {
  let movieTimescale = 0;
  let startSeconds = null;
  walkBoxes(piece, (type, bodyStart, bodyEnd) => {
    if (type === "mvhd" && movieTimescale === 0) {
      const version = piece[bodyStart];
      const offset = version === 1 ? bodyStart + 20 : bodyStart + 12;
      if (offset + 4 <= piece.length) {
        movieTimescale = piece.readUInt32BE(offset);
      }
      return;
    }
    if (type !== "elst" || startSeconds !== null || movieTimescale === 0) {
      return;
    }
    const version = piece[bodyStart];
    const entryStart = bodyStart + 8;
    if (version === 1) {
      if (entryStart + 16 > bodyEnd) {
        return;
      }
      const duration = Number(piece.readBigUInt64BE(entryStart));
      const mediaTime = piece.readBigInt64BE(entryStart + 8);
      if (mediaTime === -1n) {
        startSeconds = duration / movieTimescale;
      }
      return;
    }
    if (entryStart + 8 > bodyEnd) {
      return;
    }
    const duration = piece.readUInt32BE(entryStart);
    const mediaTime = piece.readInt32BE(entryStart + 4);
    if (mediaTime === -1) {
      startSeconds = duration / movieTimescale;
    }
  });
  return startSeconds;
}

/**
 * Sample entry types that describe a picture. Anything else in an `stsd` is a
 * soundtrack or a text track, whose "size" means nothing here.
 *
 * @type {ReadonlySet<string>}
 */
const VISUAL_SAMPLE_ENTRIES = new Set(["avc1", "avc3", "hvc1", "hev1", "hvc2", "av01", "vp08", "vp09", "mp4v"]);

/**
 * The picture size an init segment describes, in pixels, or null when it
 * describes no picture.
 *
 * Read from the visual sample entry rather than taken from our own record of
 * what the encoder was told, because those two disagreeing IS the fault this
 * exists to name: the init segment is fetched once, by `#EXT-X-MAP`, and then
 * every fragment of the session is decoded against it. A run that encodes
 * another size produces fragments the decoder cannot read — measured
 * 2026-08-21, a browser went on reporting 1280x720 for three and a half
 * minutes after the encoder had left for 960x540, over a band of macroblock
 * garbage.
 *
 * The layout is ISO/IEC 14496-12 `SampleEntry` (6 reserved bytes + 2 bytes of
 * data_reference_index) followed by `VisualSampleEntry`'s 16 bytes of
 * pre_defined/reserved, then width and height as 16-bit integers.
 *
 * @param {Buffer} initSegment
 * @returns {{ width: number, height: number } | null}
 */
export function readVideoSampleSize(initSegment) {
  if (!initSegment || initSegment.length === 0) {
    return null;
  }
  /** @type {{ width: number, height: number } | null} */
  let found = null;
  walkBoxes(initSegment, (type, bodyStart, bodyEnd) => {
    if (type !== "stsd" || found !== null) {
      return;
    }
    // Full box: version + flags, then the entry count.
    let offset = bodyStart + 8;
    while (offset + 8 <= bodyEnd && found === null) {
      const size = initSegment.readUInt32BE(offset);
      const entryType = initSegment.toString("latin1", offset + 4, offset + 8);
      if (size < 8 || offset + size > bodyEnd) {
        return; // malformed — say nothing rather than read out of bounds
      }
      if (VISUAL_SAMPLE_ENTRIES.has(entryType) && offset + 36 <= bodyEnd) {
        const width = initSegment.readUInt16BE(offset + 32);
        const height = initSegment.readUInt16BE(offset + 34);
        if (width > 0 && height > 0) {
          found = { width, height };
        }
      }
      offset += size;
    }
  });
  return found;
}
