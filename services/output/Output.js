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
 *
 * **It also holds how well its own pieces land on its own grid.** Where a piece
 * of THIS output truly began, against where its playlist says it begins, is a
 * fact of this output: a step that was told to put a keyframe at that instant
 * and did not will not splice into the stream it accompanies, and a soundtrack
 * whose grid was corrected under a run already going is that far from the
 * picture. Neither says anything about the file. Until 2026-09-15 both were
 * added to a tally held on the CUT TABLE — which is one per (file, grid), so a
 * picture and the soundtrack inside the same file shared it, the second reading
 * of one piece number was dropped as a repeat whichever output it came from,
 * and the summary could not say which of three facts it was summarising.
 */

export class Output {
  /** @type {{ checked: number, disagreed: number, maxDeviationSec: number, firstDisagreementIndex: number, deviations: number[], seen: Set<number> }} */
  #tally;

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
    /**
     * How far this output's produced pieces fell from its own published grid.
     * Private, because `landing` below is the only honest way to read it: a
     * caller holding the raw counters would have to know which of them are a
     * summary and which are working state.
     *
     * @type {{ checked: number, disagreed: number, maxDeviationSec: number, firstDisagreementIndex: number, deviations: number[], seen: Set<number> }}
     */
    this.#tally = {
      checked: 0,
      disagreed: 0,
      maxDeviationSec: 0,
      firstDisagreementIndex: -1,
      deviations: [],
      // A piece can be produced and served again; a repeat is the same piece,
      // not new evidence. Per OUTPUT, so one output's reading of piece #7 can
      // no longer silence another output's reading of its own #7.
      seen: new Set()
    };
  }

  /**
   * A produced piece of this output states where it truly began.
   *
   * @param {object} reading
   * @param {number} reading.index
   * @param {number} reading.deviationSec - From where this output's playlist
   *   says that piece begins.
   * @param {number} reading.toleranceSec - Above which the two are held to
   *   disagree rather than to have rounded.
   * @returns {void}
   */
  noteLanding({ index, deviationSec, toleranceSec }) {
    if (!Number.isInteger(index) || !Number.isFinite(deviationSec) || this.#tally.seen.has(index)) {
      return;
    }
    this.#tally.seen.add(index);
    this.#tally.checked += 1;
    this.#tally.deviations.push(deviationSec);
    if (deviationSec > toleranceSec) {
      this.#tally.disagreed += 1;
      if (this.#tally.firstDisagreementIndex < 0) {
        this.#tally.firstDisagreementIndex = index;
      }
    }
    if (deviationSec > this.#tally.maxDeviationSec) {
      this.#tally.maxDeviationSec = deviationSec;
    }
  }

  /**
   * How many distinct pieces of this output have stated where they began.
   *
   * Separate from `landing` because it is read on every produced piece, to
   * decide whether the summary is due, while `landing` sorts what it summarises
   * — which on a two-hour film is a sort per segment on the path that serves
   * one. A count and a summary are two different costs.
   *
   * @returns {number}
   */
  get piecesLanded() {
    return this.#tally.checked;
  }

  /**
   * Where this output's pieces have been landing, or null while none has.
   *
   * @returns {{ checked: number, disagreed: number, maxDeviationSec: number, medianDeviationSec: number, firstDisagreementIndex: number } | null}
   */
  get landing() {
    if (this.#tally.checked === 0) {
      return null;
    }
    const sorted = [...this.#tally.deviations].sort((left, right) => left - right);
    return {
      checked: this.#tally.checked,
      disagreed: this.#tally.disagreed,
      maxDeviationSec: this.#tally.maxDeviationSec,
      medianDeviationSec: sorted[Math.floor(sorted.length / 2)],
      firstDisagreementIndex: this.#tally.firstDisagreementIndex
    };
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
