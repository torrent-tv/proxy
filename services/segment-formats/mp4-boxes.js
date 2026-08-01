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
    const value = Math.round(startSeconds * timescale);
    if (version === 1) {
      if (bodyStart + 12 <= bodyEnd) {
        stamped.writeBigUInt64BE(BigInt(value), bodyStart + 4);
      }
    } else if (bodyStart + 8 <= bodyEnd) {
      // A 32-bit field cannot express beyond ~2^32 ticks; leave it rather than
      // write a wrapped value (the player would land somewhere arbitrary).
      if (value <= 0xffffffff) {
        stamped.writeUInt32BE(value, bodyStart + 4);
      }
    }
  });
  return stamped;
}
