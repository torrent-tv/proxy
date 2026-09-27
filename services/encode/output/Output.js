/**
 * @file One output's format in the terms the encoder is given, and how its
 * pieces land.
 *
 * The format is the output's identity (`OutputSpec`) and is decided before the
 * output is named: the size, the frame rate, the speed setting, whether HDR is
 * tone mapped. This states the same values the way the command builder reads
 * them. It used to be decided once per output and cached by the output's key,
 * because the key named what was asked for while the budget chose the format
 * afterwards; the cache was dropped sooner than the pieces it described, so one
 * key could come to name two formats. The key is the format now, and there is
 * nothing left to cache.
 *
 * The bitrate limit is not here: it is part of the output's identity
 * (`OutputSpec`), so two limits are two outputs and nothing moves a limit under
 * one that exists.
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
