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
const presentationTracks = new WeakMap();

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

/** Movie presentation time minus track media time, in seconds per track. */
export function readTrackEditOffsets(initSegment) {
  const scales = readTrackTimescales(initSegment);
  const offsets = new Map([...scales.keys()].map((id) => [id, 0]));
  let movieScale = 0;
  let trackId = null;
  walkBoxes(initSegment, (type, start, end) => {
    const version = initSegment[start];
    if (type === "mvhd") {
      const at = start + (version === 1 ? 20 : 12);
      if (at + 4 <= end) movieScale = initSegment.readUInt32BE(at);
    } else if (type === "tkhd") {
      const at = start + (version === 1 ? 20 : 12);
      if (at + 4 <= end) trackId = initSegment.readUInt32BE(at);
    } else if (type === "elst" && scales.has(trackId) && movieScale > 0 && start + 8 <= end) {
      const count = initSegment.readUInt32BE(start + 4);
      const width = version === 1 ? 20 : 12;
      let movieStart = 0;
      for (let entry = 0, at = start + 8; entry < count && at + width <= end; entry++, at += width) {
        const duration = version === 1 ? Number(initSegment.readBigUInt64BE(at)) : initSegment.readUInt32BE(at);
        const mediaTime = version === 1 ? Number(initSegment.readBigInt64BE(at + 8)) : initSegment.readInt32BE(at + 4);
        if (mediaTime === -1) {
          movieStart += duration / movieScale;
        } else {
          offsets.set(trackId, movieStart - mediaTime / scales.get(trackId));
          break;
        }
      }
    }
  });
  return offsets;
}

/** An init shared across seeks has no segment-specific empty edit. */
export function neutralizeEmptyEdits(initSegment) {
  const neutral = Buffer.from(initSegment);
  walkBoxes(neutral, (type, start, end) => {
    if (type !== "elst" || start + 8 > end) return;
    const version = neutral[start];
    const width = version === 1 ? 20 : 12;
    const count = neutral.readUInt32BE(start + 4);
    for (let entry = 0, at = start + 8; entry < count && at + width <= end; entry++, at += width) {
      const mediaTime = version === 1 ? neutral.readBigInt64BE(at + 8) : BigInt(neutral.readInt32BE(at + 4));
      if (mediaTime !== -1n) continue;
      if (version === 1) neutral.writeBigUInt64BE(0n, at);
      else neutral.writeUInt32BE(0, at);
    }
  });
  return neutral;
}

/** Preserve sample presentation times when replacing a piece's own init. */
export function rebaseSegmentDecodeTimes(segment, ownInit, sessionInit) {
  const scales = readTrackTimescales(sessionInit);
  const ownOffsets = readTrackEditOffsets(ownInit);
  const sessionOffsets = readTrackEditOffsets(sessionInit);
  const stamped = Buffer.from(segment);
  let trackId = null;
  walkBoxes(stamped, (type, start, end) => {
    if (type === "tfhd" && start + 8 <= end) {
      trackId = stamped.readUInt32BE(start + 4);
    } else if (type === "tfdt" && scales.has(trackId) && ownOffsets.has(trackId)) {
      const version = stamped[start];
      if (start + (version === 1 ? 12 : 8) > end) return;
      const existing = version === 1 ? Number(stamped.readBigUInt64BE(start + 4)) : stamped.readUInt32BE(start + 4);
      const value = existing + Math.round((ownOffsets.get(trackId) - sessionOffsets.get(trackId)) * scales.get(trackId));
      if (value < 0) throw new Error("A fragment cannot be placed before its shared init's decode origin.");
      if (version === 1) stamped.writeBigUInt64BE(BigInt(value), start + 4);
      else if (value <= 0xffffffff) stamped.writeUInt32BE(value, start + 4);
      else throw new Error("Fragment decode time exceeds its 32-bit field.");
    }
  });
  return stamped;
}

/** Presentation intervals from the durations and composition times of samples. */
export function readPresentationRanges(raw) {
  const scales = readTrackTimescales(raw);
  const edits = readTrackEditOffsets(raw);
  const byTrack = new Map();
  const decodeRanges = new Map();
  const defaultDurations = new Map();
  let trackId = null;
  let decodeTime = 0;
  let defaultDuration = 0;
  let movieScale = 0;
  let declaredTrack = null;
  const kinds = new Map();
  walkBoxes(raw, (type, start, end) => {
    if (type === "mvhd") {
      const at = start + (raw[start] === 1 ? 20 : 12);
      if (at + 4 <= end) movieScale = raw.readUInt32BE(at);
    } else if (type === "tkhd") {
      const at = start + (raw[start] === 1 ? 20 : 12);
      if (at + 4 <= end) declaredTrack = raw.readUInt32BE(at);
    } else if (type === "hdlr" && start + 12 <= end) {
      kinds.set(declaredTrack, raw.toString("latin1", start + 8, start + 12));
    } else if (type === "trex" && start + 20 <= end) {
      defaultDurations.set(raw.readUInt32BE(start + 4), raw.readUInt32BE(start + 12));
    } else if (type === "tfhd" && start + 8 <= end) {
      const flags = raw.readUIntBE(start + 1, 3);
      trackId = raw.readUInt32BE(start + 4);
      const at = start + 8 + ((flags & 1) ? 8 : 0) + ((flags & 2) ? 4 : 0);
      defaultDuration = (flags & 8) && at + 4 <= end ? raw.readUInt32BE(at) :
        defaultDurations.get(trackId) ?? 0;
    } else if (type === "tfdt" && start + (raw[start] === 1 ? 12 : 8) <= end) {
      decodeTime = raw[start] === 1 ? Number(raw.readBigUInt64BE(start + 4)) : raw.readUInt32BE(start + 4);
    } else if (type === "trun" && scales.has(trackId) && start + 8 <= end) {
      const scale = scales.get(trackId);
      const flags = raw.readUIntBE(start + 1, 3);
      const count = raw.readUInt32BE(start + 4);
      let at = start + 8 + ((flags & 1) ? 4 : 0) + ((flags & 4) ? 4 : 0);
      const width = Number(Boolean(flags & 0x100)) * 4 + Number(Boolean(flags & 0x200)) * 4 +
        Number(Boolean(flags & 0x400)) * 4 + Number(Boolean(flags & 0x800)) * 4;
      const ranges = byTrack.get(trackId) ?? [];
      for (let sample = 0; sample < count && at + width <= end; sample++) {
        const duration = flags & 0x100 ? raw.readUInt32BE(at) : defaultDuration;
        if (flags & 0x100) at += 4;
        if (flags & 0x200) at += 4;
        if (flags & 0x400) at += 4;
        const composition = flags & 0x800 ?
          (raw[start] === 1 ? raw.readInt32BE(at) : raw.readUInt32BE(at)) : 0;
        if (flags & 0x800) at += 4;
        if (!(duration > 0)) return;
        const position = (decodeTime + composition) / scale + (edits.get(trackId) ?? 0);
        ranges.push({ start: position, end: position + duration / scale });
        const decode = decodeRanges.get(trackId) ?? [];
        decode.push({ start: decodeTime / scale + (edits.get(trackId) ?? 0),
          end: (decodeTime + duration) / scale + (edits.get(trackId) ?? 0) });
        decodeRanges.set(trackId, decode);
        decodeTime += duration;
      }
      byTrack.set(trackId, ranges);
    }
  });
  // Merge in presentation order: B frames arrive in decode order.
  const mergedTracks = [...byTrack].map(([id, samples]) => {
    const merged = [];
    // Sample durations are decode durations. A displayed video frame remains
    // present until the next presentation sample, including variable-rate holds.
    const ordered = samples.sort((left, right) => left.start - right.start);
    const precision = 1 / (movieScale || scales.get(id));
    for (const sample of ordered) {
      const previous = merged.at(-1);
      if (previous && (kinds.get(id) === "vide" ||
        sample.start - previous.end <= precision + Number.EPSILON * Math.max(1, sample.end) * 8)) {
        previous.end = Math.max(previous.end, sample.end);
      } else merged.push({ ...sample });
    }
    // Movie edits quantize independent pieces to movie ticks. Preserve that
    // declared resolution at joins; it is not a playback buffer threshold.
    for (const range of merged) range.end += precision;
    const decoded = decodeRanges.get(id);
    return { id, ranges: merged, kind: kinds.get(id), precision,
      decodeStart: Math.min(...decoded.map(({ start }) => start)),
      decodeEnd: Math.max(...decoded.map(({ end }) => end)) };
  });
  // A multiplexed segment is playable only where every declared track exists.
  const result = intersectPresentationTracks(mergedTracks);
  presentationTracks.set(result, mergedTracks);
  return result;
}

/** A video frame can cross a file boundary when decoding remains continuous. */
export function continuePresentationRanges(ranges, nextRanges) {
  const tracks = presentationTracks.get(ranges);
  const next = presentationTracks.get(nextRanges);
  if (!tracks || !next) return ranges;
  const continued = tracks.map((track) => {
    const following = next.find(({ id }) => id === track.id);
    const held = track.ranges.map((range) => ({ ...range }));
    if (track.kind === "vide" && following && held.length > 0 && following.ranges.length > 0 &&
      Math.abs(track.decodeEnd - following.decodeStart) <= track.precision + following.precision +
        Number.EPSILON * Math.max(1, following.decodeStart) * 8) {
      held.at(-1).end = Math.max(held.at(-1).end, following.ranges[0].start);
    }
    return { ...track, ranges: held };
  });
  const result = intersectPresentationTracks(continued);
  presentationTracks.set(result, continued);
  return result;
}

function intersectPresentationTracks(tracks) {
  return tracks.map(({ ranges }) => ranges).reduce((common, ranges) => common.flatMap((left) => ranges
    .map((right) => ({ start: Math.max(left.start, right.start), end: Math.min(left.end, right.end) }))
    .filter(({ start, end }) => end > start)), tracks[0]?.ranges ?? []);
}

/** Project the same parsed samples onto the media player's reported clock. */
export function translatePresentationRanges(ranges, initBytes, timestampOffsetSeconds) {
  const tracks = presentationTracks.get(ranges);
  if (!tracks || !initBytes?.length || !Number.isFinite(timestampOffsetSeconds)) return ranges;
  const edits = readTrackEditOffsets(initBytes);
  return intersectPresentationTracks(tracks.map(({ id, ranges: held }) => ({
    id,
    ranges: held.map(({ start, end }) => ({
      start: Math.max(0, start + timestampOffsetSeconds - (edits.get(id) ?? 0)),
      end: end + timestampOffsetSeconds - (edits.get(id) ?? 0)
    })).filter(({ start, end }) => end > start)
  })));
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
