/**
 * @file Fit the cost of decoding from measured clips — and say which terms the
 * measurements actually determine.
 *
 * The model is `cost = pixelTerm × Mpixel/s + bitrateTerm × Mbit/s +
 * constantTerm`, in seconds of work per second of content.
 *
 * What went wrong with the fit this replaces, measured 2026-08-17: three clips
 * for three unknowns is an EXACT system, and two of those clips shared a pixel
 * rate and differed only in bitrate. A system that near-singular does not fail
 * loudly — it returns whatever satisfies the three equations, and on that boot
 * it returned `0.007542 × Mpx/s + 0.000000 × Mbit/s + 0.0000 s/s`. The bitrate
 * term and the constant were zero, so a film's own bitrate never entered its
 * price, and the whole prediction was 1.8-2.2x optimistic against what the same
 * file measured while playing.
 *
 * Two things are different here, and both are about honesty rather than
 * accuracy:
 *
 *   - the system is OVER-determined (six clips, three unknowns) and solved by
 *     least squares, so no single noisy reading decides a term;
 *   - a term is published only if the measurements determine it. The test is
 *     the coefficient against its OWN standard error: a term smaller than the
 *     uncertainty in it has not been measured, and stating it as a number —
 *     zero or otherwise — claims knowledge that is not there. It is dropped,
 *     the remaining terms are fitted again, and the caller is told which shape
 *     survived.
 *
 * There is no threshold to tune in that rule and no coefficient anywhere in
 * this file. "Smaller than its own uncertainty" is a statement about the data,
 * not a setting.
 */

/**
 * One measured clip.
 *
 * @typedef {object} DecodeSample
 * @property {number} megapixelsPerSecond - Width × height × frame rate ÷ 1e6.
 * @property {number} megabitsPerSecond - The clip's own measured bitrate.
 * @property {number} costSecondsPerSecond - Seconds of work per second of
 *   content, from ffmpeg's own progress.
 */

/**
 * The fitted model, with the shape the data supported.
 *
 * @typedef {object} DecodeCostModel
 * @property {number} pixelTerm
 * @property {number} bitrateTerm
 * @property {number} constantTerm
 * @property {string} shape - Which terms were determined.
 * @property {string[]} dropped - Terms the measurements could not determine.
 * @property {number} samples
 * @property {number} residualRms - Typical disagreement between the fit and a
 *   measurement, in the same units as the cost.
 */

/** Every term the model can carry, in column order. */
const TERMS = ["pixels", "bitrate", "constant"];

/**
 * Fit the model, dropping any term the measurements do not determine.
 *
 * @param {DecodeSample[]} samples
 * @returns {DecodeCostModel | null} Null when nothing at all can be said: fewer
 *   measurements than terms, or no measurable dependence on the source.
 */
export function fitDecodeCost(samples) {
  const usable = (Array.isArray(samples) ? samples : []).filter(
    (sample) =>
      Number.isFinite(sample?.megapixelsPerSecond) &&
      sample.megapixelsPerSecond > 0 &&
      Number.isFinite(sample?.megabitsPerSecond) &&
      sample.megabitsPerSecond >= 0 &&
      Number.isFinite(sample?.costSecondsPerSecond) &&
      sample.costSecondsPerSecond > 0
  );
  // Fitting three terms to three points is what produced the degenerate answer
  // this file exists to prevent: it has no residual and therefore no way to
  // notice that two of the points said the same thing.
  if (usable.length < TERMS.length + 1) {
    return null;
  }

  let columns = [...TERMS];
  let dropped = [];
  for (let attempt = 0; attempt < TERMS.length; attempt += 1) {
    const fit = leastSquares(usable, columns);
    if (!fit) {
      return null;
    }
    // Which terms the data did not determine: a coefficient no larger than the
    // uncertainty in it. Only one is dropped per pass — removing a column
    // changes the uncertainty in the others, so the question has to be asked
    // again of the smaller model.
    const undetermined = columns
      .map((name, index) => ({
        name,
        coefficient: fit.coefficients[index],
        ratio: determination(usable, columns, name, fit.coefficients[index], fit.standardErrors[index], fit.residualRms)
      }))
      // The pixel term is the one relationship every measurement agrees on, and
      // a model without it says nothing at all. If IT is undetermined the
      // answer is no model, which the caller handles by pricing the encoder
      // alone and refusing nothing.
      // A NEGATIVE coefficient is undetermined whatever its ratio says. Every
      // term here is physically non-negative — more pixels cannot cost less
      // work, and neither can more bits — so a negative fit is noise winning
      // over an effect, not a discovery about the host. Clamping it to zero
      // instead, which the first version of this file did, publishes a zero
      // that looks measured: exactly the dishonesty the module exists to
      // remove.
      .filter((term) => term.ratio < 1 || term.coefficient < 0)
      .sort((left, right) => {
        const negative = (term) => (term.coefficient < 0 ? 0 : 1);
        return negative(left) - negative(right) || left.ratio - right.ratio;
      });

    if (undetermined.length === 0) {
      return published(columns, fit, dropped, usable.length);
    }
    const weakest = undetermined[0].name;
    if (weakest === "pixels") {
      return null;
    }
    columns = columns.filter((name) => name !== weakest);
    dropped = [...dropped, weakest];
    if (columns.length === 0) {
      return null;
    }
  }
  return null;
}


/**
 * How well one term is determined, as a ratio against 1.
 *
 * Two ways a term can fail to be measured, and both have to be asked, because
 * each is blind where the other sees:
 *
 *   - **against the noise.** The term's effect across the range the clips
 *     actually cover — its coefficient times the spread of its own column — has
 *     to be larger than the typical disagreement between the fit and the
 *     measurements. A term whose whole contribution is smaller than the scatter
 *     was not measured; it was fitted to the scatter.
 *   - **against the arithmetic.** When a fit happens to be exact the scatter is
 *     zero, every standard error vanishes, and a coefficient of 7e-18 — which
 *     is how double-precision writes "nothing" — passes any test framed as a
 *     ratio. So the effect must also be larger than what the arithmetic itself
 *     can represent at this scale. That floor is a property of the numbers, not
 *     a setting: it moves with the size of the measurements.
 *
 * @param {DecodeSample[]} samples
 * @param {string[]} columns
 * @param {string} name
 * @param {number} coefficient
 * @param {number} standardError
 * @param {number} residualRms
 * @returns {number} Below 1 means the measurements do not determine this term.
 */
function determination(samples, columns, name, coefficient, standardError, residualRms) {
  const values = samples.map((sample) => {
    if (name === "pixels") {
      return sample.megapixelsPerSecond;
    }
    if (name === "bitrate") {
      return sample.megabitsPerSecond;
    }
    return 1;
  });
  const spread = name === "constant" ? 1 : Math.max(...values) - Math.min(...values);
  const effect = Math.abs(coefficient) * spread;
  const meanCost = samples.reduce((sum, sample) => sum + sample.costSecondsPerSecond, 0) / samples.length;
  const arithmeticFloor = Math.abs(meanCost) * Number.EPSILON * samples.length * columns.length;
  const noiseFloor = Math.max(residualRms, arithmeticFloor);
  const againstNoise = noiseFloor > 0 ? effect / noiseFloor : Number.POSITIVE_INFINITY;
  const againstError = standardError > 0 ? Math.abs(coefficient) / standardError : Number.POSITIVE_INFINITY;
  return Math.min(againstNoise, againstError);
}

/**
 * Assemble the answer, with absent terms as zero — and `dropped` saying that
 * the zero means "not measured" rather than "measured to be nothing".
 *
 * @param {string[]} columns
 * @param {{ coefficients: number[], residualRms: number }} fit
 * @param {string[]} dropped
 * @param {number} samples
 * @returns {DecodeCostModel | null}
 */
function published(columns, fit, dropped, samples) {
  const value = (name) => {
    const index = columns.indexOf(name);
    return index < 0 ? 0 : fit.coefficients[index];
  };
  const pixelTerm = value("pixels");
  // A negative price for pixels is not a host being unusual — it is noise
  // larger than the effect, and carrying it would price a bigger picture as
  // cheaper than a smaller one.
  if (!(pixelTerm > 0)) {
    return null;
  }
  const constantTerm = value("constant");
  return {
    pixelTerm,
    bitrateTerm: Math.max(0, value("bitrate")),
    // A negative constant would make a small enough source free, which no
    // measurement here supports: it is the fitted line crossing below zero
    // outside the range that was measured.
    constantTerm: Math.max(0, constantTerm),
    shape: columns.join("+"),
    dropped,
    samples,
    residualRms: fit.residualRms
  };
}

/**
 * Least squares over the named columns, with the standard error of each
 * coefficient.
 *
 * Solved through the normal equations. The matrix is at most 3×3 and the
 * columns are of similar magnitude once a clip set varies them deliberately,
 * which is exactly what the set is designed for.
 *
 * @param {DecodeSample[]} samples
 * @param {string[]} columns
 * @returns {{ coefficients: number[], standardErrors: number[], residualRms: number } | null}
 */
function leastSquares(samples, columns) {
  const rowOf = (sample) =>
    columns.map((name) => {
      if (name === "pixels") {
        return sample.megapixelsPerSecond;
      }
      if (name === "bitrate") {
        return sample.megabitsPerSecond;
      }
      return 1;
    });
  const width = columns.length;
  const normal = Array.from({ length: width }, () => new Array(width).fill(0));
  const right = new Array(width).fill(0);
  for (const sample of samples) {
    const row = rowOf(sample);
    for (let i = 0; i < width; i += 1) {
      right[i] += row[i] * sample.costSecondsPerSecond;
      for (let j = 0; j < width; j += 1) {
        normal[i][j] += row[i] * row[j];
      }
    }
  }
  const inverse = invert(normal);
  if (!inverse) {
    return null;
  }
  const coefficients = inverse.map((row) => row.reduce((sum, value, index) => sum + value * right[index], 0));

  let residualSquares = 0;
  for (const sample of samples) {
    const row = rowOf(sample);
    const predicted = row.reduce((sum, value, index) => sum + value * coefficients[index], 0);
    residualSquares += (sample.costSecondsPerSecond - predicted) ** 2;
  }
  const degreesOfFreedom = samples.length - width;
  const variance = degreesOfFreedom > 0 ? residualSquares / degreesOfFreedom : 0;
  const standardErrors = inverse.map((row, index) => Math.sqrt(Math.max(0, variance * row[index])));
  return {
    coefficients,
    standardErrors,
    residualRms: Math.sqrt(residualSquares / samples.length)
  };
}

/**
 * Invert a small symmetric matrix by Gauss-Jordan, or null when it is singular.
 *
 * @param {number[][]} matrix
 * @returns {number[][] | null}
 */
function invert(matrix) {
  const size = matrix.length;
  const work = matrix.map((row, index) => [
    ...row,
    ...Array.from({ length: size }, (_unused, column) => (column === index ? 1 : 0))
  ]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(work[row][column]) > Math.abs(work[pivot][column])) {
        pivot = row;
      }
    }
    // Singular to the precision of the arithmetic: the columns are not
    // independent, which is a statement about the clip set, not about the host.
    if (Math.abs(work[pivot][column]) < 1e-12) {
      return null;
    }
    [work[column], work[pivot]] = [work[pivot], work[column]];
    const scale = work[column][column];
    for (let k = 0; k < 2 * size; k += 1) {
      work[column][k] /= scale;
    }
    for (let row = 0; row < size; row += 1) {
      if (row === column) {
        continue;
      }
      const factor = work[row][column];
      for (let k = 0; k < 2 * size; k += 1) {
        work[row][k] -= factor * work[column][k];
      }
    }
  }
  return work.map((row) => row.slice(size));
}

/**
 * What a model prices one source at.
 *
 * @param {DecodeCostModel} model
 * @param {{ megapixelsPerSecond: number, megabitsPerSecond: number }} source
 * @returns {number} Seconds of work per second of content.
 */
export function decodeCostOf(model, source) {
  return (
    model.pixelTerm * source.megapixelsPerSecond +
    model.bitrateTerm * source.megabitsPerSecond +
    model.constantTerm
  );
}
