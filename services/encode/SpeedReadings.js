/**
 * @file The speed readings of each output's runs, in the order the runs
 * measured them, over the start forecast's horizon (torrent-tv/meta#178).
 *
 * A run announces a reading at each closed piece; whoever forecasts takes every
 * reading after the last one it has. The forecast used to take only the newest
 * reading of a run alive when it asked: on a cold start on Home Assistant the
 * runs were three pieces long and ended between its polls, and of the readings
 * 0.78, 1.80, 2.25, 2.84 and 2.69x it got 0.78 and 2.69x, and held the picture
 * on 0.78x for 13 s (r37).
 */

export class SpeedReadings {
  /** @type {WeakMap<object, Array<{ speed: number, at: number }>>} */
  #byOutput = new WeakMap();
  #keepMs;

  /** @param {number} keepSeconds - How far back a reading is kept: the forecast's horizon. */
  constructor(keepSeconds) {
    this.#keepMs = Math.max(0, keepSeconds) * 1000;
  }

  /**
   * @param {object} output
   * @param {{ speed: number, at: number } | null} reading
   */
  note(output, reading) {
    if (!output || !(reading?.speed > 0) || !Number.isFinite(reading.at)) return;
    let readings = this.#byOutput.get(output);
    if (!readings) this.#byOutput.set(output, readings = []);
    readings.push({ speed: reading.speed, at: reading.at });
    const cutoff = reading.at - this.#keepMs;
    // As the forecast's own trend keeps them: the newest one before the horizon stays.
    while (readings.length > 1 && readings[1].at <= cutoff) readings.shift();
  }

  /**
   * @param {object} output
   * @param {number} [after] - The time of the last reading the asker has.
   * @returns {Array<{ speed: number, at: number }>} Oldest first.
   */
  after(output, after = Number.NEGATIVE_INFINITY) {
    return (this.#byOutput.get(output) ?? []).filter(reading => reading.at > after);
  }
}
