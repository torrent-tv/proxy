/**
 * @file How fast a run makes film over its whole life, its open included
 * (torrent-tv/meta#178).
 *
 * A run first opens its input and then encodes the stretch it was given. Over
 * the run, film comes out at
 *
 *     effectiveSpeed = filmSeconds / (openSeconds + filmSeconds / processingSpeed)
 *
 * where `processingSpeed` is what the encoding alone does, `openSeconds` the
 * time to its first output less that output's encoding, and `filmSeconds` the
 * stretch it is given. A run of one piece pays the whole open for that piece:
 * on Home Assistant (r41) runs of one 4 s piece took 5.9-7.5 s each at a
 * processing speed priced above realtime, and the picture stood 22 times.
 */

/**
 * @param {{ processingSpeed: number | null, openSeconds: number | null, filmSeconds: number | null }} run
 * @returns {number | null} Null when the processing speed is not known; the
 *   processing speed itself when the run's open or stretch is not.
 */
export function effectiveSpeed({ processingSpeed, openSeconds, filmSeconds }) {
  if (!(processingSpeed > 0)) return null;
  if (!(filmSeconds > 0) || !Number.isFinite(openSeconds) || openSeconds < 0) return processingSpeed;
  return filmSeconds / (openSeconds + filmSeconds / processingSpeed);
}

/**
 * The film a run is given, as the inputs size it (`EncodeInputs.stretchFor`):
 * the copy rate times the open, within the memory inputs may hold, and one
 * piece while no copy rate has been measured.
 *
 * @param {{ copyBytesPerMs: number | null, openSeconds: number, capacityBytes: number | null,
 *   sourceBytesPerSecond: number | null, segmentSeconds: number }} params
 * @returns {number} Seconds of film; never less than one piece.
 */
export function runFilmSeconds({ copyBytesPerMs, openSeconds, capacityBytes, sourceBytesPerSecond, segmentSeconds }) {
  const piece = segmentSeconds > 0 ? segmentSeconds : 0;
  if (!(copyBytesPerMs > 0) || !(openSeconds > 0) || !(sourceBytesPerSecond > 0)) return piece;
  const stretch = copyBytesPerMs * openSeconds * 1000;
  const bytes = Number.isFinite(capacityBytes) && capacityBytes >= 0 ? Math.min(stretch, capacityBytes) : stretch;
  return Math.max(piece, bytes / sourceBytesPerSecond);
}
