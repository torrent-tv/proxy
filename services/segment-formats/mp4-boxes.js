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
const CONTAINER_BOXES = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "moof", "traf"]);

/**
 * Walk the box tree, invoking `visit` for every box encountered.
 *
 * @param {Buffer} buffer
 * @param {(type: string, bodyStart: number, bodyEnd: number) => void} visit
 *   `bodyStart`/`bodyEnd` delimit the box payload (header excluded).
 * @param {number} [start=0]
 * @param {number} [end=buffer.length]
 * @returns {void}
 */
export function walkBoxes(buffer, visit, start = 0, end = buffer.length) {
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
    if (CONTAINER_BOXES.has(type)) {
      walkBoxes(buffer, visit, offset + headerSize, offset + size);
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
