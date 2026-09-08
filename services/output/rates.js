/**
 * @file How many bits of film there are per second of playback.
 *
 * A fact about the OUTPUT, and the two figures the HLS specification asks for:
 * the average over the whole variant, and the peak one segment reaches. Both
 * are measured — the average from the file's own length and duration, the peak
 * from the biggest piece actually produced and the span it covers.
 *
 * It used to be `height * height * 3.2`, a rule of thumb, justified by a comment
 * saying the measurement was not available before encoding starts. It is: the
 * length and the duration are known when the session is created, and the peak
 * refines itself as pieces appear. Field 2026-09-08: 3.73 Mbit/s declared for a
 * file carrying 18.4, and the browser's cushion is sized in BYTES from that
 * figure — 120 s asked bought 26 s of film.
 *
 * Pure: plain numbers in, plain numbers out. Nothing here knows what a session,
 * a store or a torrent is.
 */

/**
 * The two rates to declare, from what has been measured of this file.
 *
 * @param {object} params
 * @param {number} params.fileLength - Bytes of the source file, 0 until the
 *   torrent has said. Counts every track and every byte of container, so it is
 *   the better figure of the two.
 * @param {number} params.durationSeconds
 * @param {number} [params.streamBitsPerSecond] - What a probe read off the
 *   video stream, known from session creation. Lower than the whole file's rate
 *   because it is one track of it, and used while the length is not known.
 * @param {{ index: number, size: number }} [params.largest] - The biggest piece
 *   produced so far, with its number. An index of `-1` means none yet.
 * @param {number[]} [params.boundaries] - Where the file is cut, so the biggest
 *   piece's own span is known. Bytes alone cannot give a rate.
 * @returns {{ averageBitsPerSecond: number, peakOverAverage: number }}
 */
export function declaredRates({
  fileLength,
  durationSeconds,
  streamBitsPerSecond = 0,
  largest = null,
  boundaries = null
}) {
  const length = Number(fileLength);
  const duration = Number(durationSeconds);
  // TWO SOURCES, AND THE LARGER OF THEM, because each is measured and each can
  // be absent — and absent is 0, so the larger is whichever was measured.
  //
  //  - the whole file's length over its duration: the best figure, since it
  //    counts every track and every byte of container. Known only once the
  //    torrent has reported the file's size;
  //  - what the probe read off the video stream: known when the session is
  //    created, and lower, because it is one track of several.
  //
  // The first alone was what shipped in 2.80.14, read from a field that does
  // not exist on a source file. It came back 0 on every session, so every
  // variant was declared at the 400 kbit/s floor — nine times WORSE than the
  // rule of thumb it replaced — and the browser, which sizes its cushion in
  // bytes from this figure, held 0.1 s of film against 120 s asked. The picture
  // stood still for 116.7 s of one viewing. Assuming a field instead of
  // checking it is the whole of that fault.
  const fromLength = length > 0 && duration > 0 ? (length * 8) / duration : 0;
  const averageBitsPerSecond = Math.max(fromLength, Number(streamBitsPerSecond) || 0);
  if (!(averageBitsPerSecond > 0)) {
    return { averageBitsPerSecond: 0, peakOverAverage: 1 };
  }
  const index = Number(largest?.index);
  const size = Number(largest?.size);
  if (!Number.isInteger(index) || index < 0 || !(size > 0) || !Array.isArray(boundaries)) {
    // Nothing has been produced, so the peak is not yet a measured quantity and
    // is declared equal to the average. It rises as soon as one piece exists,
    // and a ratio invented meanwhile would be exactly the fabrication this file
    // replaced.
    return { averageBitsPerSecond, peakOverAverage: 1 };
  }
  const span = Number(boundaries[index + 1]) - Number(boundaries[index]);
  if (!(span > 0)) {
    return { averageBitsPerSecond, peakOverAverage: 1 };
  }
  // Never below one: the peak cannot be under the average, and a piece that
  // happens to be the smallest in a short session must not lower the figure the
  // player sizes its cushion from.
  return {
    averageBitsPerSecond,
    peakOverAverage: Math.max(1, ((size * 8) / span) / averageBitsPerSecond)
  };
}

/**
 * The three arguments the master playlist needs to declare its rates.
 *
 * Assembled here rather than at the call site, because all three are facts
 * about the OUTPUT and none of them is a fact about a session: the file's own
 * length and duration, the biggest piece made of it, and the cap imposed on the
 * one height being produced. The caller holds them and passes them as numbers.
 *
 * Only the height being produced has a cap — the other heights do not exist
 * yet, and stating one for them would be a guess about a session nobody has
 * made.
 *
 * @param {object} params
 * @param {number} params.fileLength
 * @param {number} params.durationSeconds
 * @param {number} [params.streamBitsPerSecond]
 * @param {{ index: number, size: number } | null} [params.largest]
 * @param {number[] | null} [params.boundaries]
 * @param {number} [params.producedHeight] - The height this output encodes at.
 * @param {number} [params.capKbps] - What that height is capped at, if it is.
 * @returns {{ averageBitsPerSecond: number, peakOverAverage: number,
 *   capKbpsFor: (height: number) => number }}
 */
export function masterRateArgs({
  fileLength,
  durationSeconds,
  streamBitsPerSecond = 0,
  largest = null,
  boundaries = null,
  producedHeight = 0,
  capKbps = 0
}) {
  return {
    ...declaredRates({ fileLength, durationSeconds, streamBitsPerSecond, largest, boundaries }),
    capKbpsFor: (height) => (height === producedHeight ? capKbps : 0)
  };
}
