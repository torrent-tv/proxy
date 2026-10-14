/**
 * @file The speed readings of each output's runs, in the order the runs
 * measured them, over the start forecast's horizon (torrent-tv/meta#178).
 *
 * A run announces a reading at each closed piece; the forecast summarizes the
 * whole window on each poll. Two runs of one output can announce out of order —
 * each reading carries the time of its own run's last progress report — so the
 * window is kept in the order the readings were TAKEN, and two taken in the
 * same millisecond are two readings. The forecast used to take only the newest
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
    let place = readings.length;
    while (place > 0 && readings[place - 1].at > reading.at) place -= 1;
    readings.splice(place, 0, { speed: reading.speed, at: reading.at });
    const cutoff = readings.at(-1).at - this.#keepMs;
    // As the forecast's own trend keeps them: the newest one before the horizon stays.
    while (readings.length > 1 && readings[1].at <= cutoff) readings.shift();
  }

  /**
   * @param {object} output
   * @returns {Array<{ speed: number, at: number }>} The window, in the order the readings were taken.
   */
  windowOf(output) {
    return [...(this.#byOutput.get(output) ?? [])];
  }
}
