/**
 * @file What this proxy tells the server about itself, sent when it changes.
 *
 * The server chooses a proxy for every viewer from a table of proxies it keeps
 * (torrent-tv/meta#36): their load, their room for one more encode, and the
 * films they hold. It used to ask every proxy for all of it on every choice and
 * wait up to two seconds for the answers; now each proxy says it when it
 * changes, and the server answers a choice from what it already knows.
 *
 * `changed()` is the one entry: called on every event that may change the
 * state (a torrent added or closed, a file kept whole, an encoder started or
 * ended, a viewer coming or going) and on the cadence of the load average,
 * which has no event of its own. Calls that arrive while one description is
 * being made are joined into one more after it, and a description identical
 * to the last one sent is not sent again.
 */

/**
 * How often the load average is looked at. Linux recomputes it every five
 * seconds (`LOAD_FREQ` in `kernel/sched/loadavg.c`); reading it more often
 * finds the same number, less often lets the server's copy lag behind it.
 */
export const LOAD_REFRESH_MS = 5_000;

export class ProxyStateReporter {
  /** @type {() => Promise<object> | object} */
  #describe;

  /** @type {(state: object) => void} */
  #send;

  /** @type {Promise<void> | null} */
  #running = null;

  #again = false;

  /** What was sent last, as text, so an unchanged state is not sent again. */
  #lastSent = "";

  /**
   * @param {object} params
   * @param {() => Promise<object> | object} params.describe - This proxy's state now.
   * @param {(state: object) => void} params.send - Deliver it to the server.
   */
  constructor({ describe, send }) {
    this.#describe = describe;
    this.#send = send;
  }

  /**
   * Something that may change the state happened: describe it and send what
   * differs. Never throws; never waits for the caller.
   *
   * @returns {Promise<void>}
   */
  changed() {
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    this.#running = this.#run().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  /**
   * Send the state even when it is unchanged: a new connection to the server
   * (a reconnect, or a move to another server instance) has not heard it.
   *
   * @returns {Promise<void>}
   */
  resend() {
    this.#lastSent = "";
    return this.changed();
  }

  async #run() {
    do {
      this.#again = false;
      let state;
      try {
        state = await this.#describe();
      } catch {
        // silent-ok: a state that cannot be described now is described at the
        // next change or load reading; the server keeps the last one it heard.
        continue;
      }
      const text = JSON.stringify(state);
      if (text === this.#lastSent) continue;
      this.#lastSent = text;
      this.#send(state);
    } while (this.#again);
  }
}
