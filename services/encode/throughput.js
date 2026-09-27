/**
 * @file How fast a calibrated encoding mode runs at a given frame size, from
 * the readings the startup calibration took (`encode/calibration.js`).
 *
 * Pure arithmetic over measured figures, kept apart from the calibration so
 * that everything which prices an encode can read it without reaching the code
 * that runs ffmpeg.
 */

/**
 * @typedef {object} SizeReading
 * @property {number} width
 * @property {number} height
 * @property {number} pixelsPerSec
 */

/**
 * The rate of pictures this mode would encode at this frame, in pixels per
 * second, or null where this machine has not shown it can.
 *
 * An entry with no readings by size — built before sizes were read, or by a
 * check that states one figure — answers with its one figure, as it always did.
 *
 * @param {{ pixelsPerSec: number, bySize?: SizeReading[], interpolationError?: number | null }} entry
 * @param {{ width: number, height: number } | null | undefined} frame
 * @returns {number | null}
 */
export function throughputAt(entry, frame) {
  const bySize = Array.isArray(entry?.bySize) ? entry.bySize : [];
  const width = Number(frame?.width) || 0;
  const height = Number(frame?.height) || 0;
  if (bySize.length === 0 || width <= 0 || height <= 0) {
    const figure = Number(entry?.pixelsPerSec);
    return Number.isFinite(figure) && figure > 0 ? figure : null;
  }
  const area = width * height;
  const sorted = [...bySize].sort((left, right) => left.width * left.height - right.width * right.height);
  const smallest = sorted[0];
  const largest = sorted[sorted.length - 1];
  if (area < smallest.width * smallest.height || area > largest.width * largest.height) {
    return null;
  }
  for (let index = 0; index < sorted.length; index += 1) {
    const reading = sorted[index];
    const readArea = reading.width * reading.height;
    if (readArea === area) {
      return reading.pixelsPerSec;
    }
    if (readArea > area) {
      const error = entry.interpolationError;
      if (!(Number.isFinite(error) && error >= 0 && error < 1)) {
        return null;
      }
      const below = sorted[index - 1];
      return interpolate(below, reading, area) * (1 - error);
    }
  }
  return null;
}

/**
 * Pixels per second at an area between two readings, straight in logarithms
 * of both: throughput against frame area is a power law over any short
 * stretch, and a straight line between two points of it is the least that
 * can be said without inventing a shape.
 *
 * @param {SizeReading} below
 * @param {SizeReading} above
 * @param {number} area
 * @returns {number}
 */
function interpolate(below, above, area) {
  const lowArea = below.width * below.height;
  const highArea = above.width * above.height;
  const share = Math.log(area / lowArea) / Math.log(highArea / lowArea);
  return Math.exp(Math.log(below.pixelsPerSec) + share * (Math.log(above.pixelsPerSec) - Math.log(below.pixelsPerSec)));
}

/**
 * How far an interpolation between readings of this mode was measured to be
 * wrong: the largest relative error of a middle reading predicted from the two
 * outside it.
 *
 * @param {SizeReading[]} bySize - Smallest first.
 * @returns {number | null} Null with fewer than three readings.
 */
export function interpolationErrorOf(bySize) {
  let largest = null;
  for (let index = 1; index + 1 < bySize.length; index += 1) {
    const middle = bySize[index];
    const predicted = interpolate(bySize[index - 1], bySize[index + 1], middle.width * middle.height);
    const error = Math.abs(predicted - middle.pixelsPerSec) / middle.pixelsPerSec;
    largest = largest === null ? error : Math.max(largest, error);
  }
  return largest;
}

