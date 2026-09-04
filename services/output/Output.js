/**
 * @file What one output is encoded AS, decided once.
 *
 * `OutputSpec` says what an output is — which tracks, in what form, cut how.
 * This is the other half: the shape the encoder is actually given for it. The
 * box in pixels, the frame rate, the speed setting, whether the picture is tone
 * mapped down from HDR.
 *
 * **Why it is not a fact of a session.** It is decided by the realtime budget
 * at the moment a session is created — what this machine could hold just then —
 * so two sessions of one output, made minutes apart, could be given different
 * shapes while claiming the same identity. Everything downstream assumes
 * otherwise: a segment of one is supposed to be interchangeable with a segment
 * of the other, and the master playlist names one `RESOLUTION` for both.
 *
 * Decided once per output and held here, that cannot happen. What the budget
 * learns afterwards moves the RATE cap, which is deliberately not here: rate
 * control appears in neither the SPS nor the PPS, so it can move under a player
 * that has already cached the init. The size cannot, which is exactly why the
 * size belongs to the output and the cap belongs to the run.
 */

export class Output {
  /**
   * @param {object} params
   * @param {number} params.encodeWidth - 0 means the source's own width.
   * @param {number} params.encodeHeight - 0 means the source's own height.
   * @param {number} params.outputFps
   * @param {string | null} params.softwarePreset - The speed setting, where the
   *   encoder has a ladder and one was chosen from it.
   * @param {boolean} params.applyTonemap
   */
  constructor({ encodeWidth, encodeHeight, outputFps, softwarePreset, applyTonemap }) {
    this.encodeWidth = Number.isFinite(encodeWidth) ? encodeWidth : 0;
    this.encodeHeight = Number.isFinite(encodeHeight) ? encodeHeight : 0;
    this.outputFps = Number.isFinite(outputFps) && outputFps > 0 ? outputFps : 0;
    this.softwarePreset = typeof softwarePreset === "string" ? softwarePreset : null;
    this.applyTonemap = applyTonemap === true;
  }
}

/**
 * The shapes this proxy has decided, one per output.
 *
 * Keyed by `OutputSpec.toKey()` and by nothing else: the shape is a property of
 * what is being produced, and two requests that produce the same thing must be
 * given the same one however far apart they arrive.
 */
export class Outputs {
  /** @type {Map<string, Output>} */
  #byKey = new Map();

  /**
   * The shape for this output, decided by `decide` the first time it is asked
   * for and never again.
   *
   * @param {string} key
   * @param {() => Output} decide
   * @returns {Output}
   */
  get(key, decide) {
    let output = this.#byKey.get(key);
    if (!output) {
      output = decide();
      this.#byKey.set(key, output);
    }
    return output;
  }

  /**
   * Drop every shape nobody is holding.
   *
   * Same reason the timelines are swept: a map that only grows is the shape of
   * half the memory faults recorded in this project.
   *
   * @param {Set<Output>} inUse
   * @returns {number}
   */
  forgetUnused(inUse) {
    let dropped = 0;
    for (const [key, output] of [...this.#byKey]) {
      if (!inUse.has(output)) {
        this.#byKey.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  /** @returns {number} */
  get size() {
    return this.#byKey.size;
  }
}
