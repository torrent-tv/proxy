/**
 * @file Where one encoder run's time went: working, waiting for its input, or
 * stopped.
 *
 * A speed read as "film made per second of clock" measures the swarm as well
 * as the machine whenever the input runs dry: field 2026-10-01, a copy waited
 * 32.93 s and 43.91 s for two pieces and its speed read 0.21x, which the
 * forecast then carried over the whole remaining film while it charged the
 * same download separately. So the clock is split, from two facts that are
 * observed and not inferred:
 *
 * 1. the input read waited — the stream route says when it starts and stops
 *    waiting for bytes of this run's input;
 * 2. the process was stopped — the run says when it sends `SIGSTOP` and
 *    `SIGCONT`.
 *
 * Time during which either holds is idle; the rest is the run's own work. Two
 * inputs that wait at once, or a wait while the process is stopped, are idle
 * once. What is not separated is what the encoder does with bytes it already
 * holds while its read waits; that is bounded by its input buffer, which is
 * the one error this split has.
 */
export class RunClock {
  /** @type {() => number} */
  #now;
  #startedAt;
  /** Idle causes in force now: input reads waiting, plus one while stopped. */
  #idleCauses = 0;
  #idleSince = 0;
  #idleMs = 0;

  /**
   * @param {{ now?: () => number }} [options]
   */
  constructor({ now = Date.now } = {}) {
    this.#now = now;
    this.#startedAt = now();
  }

  #idleBegins() {
    if (this.#idleCauses === 0) {
      this.#idleSince = this.#now();
    }
    this.#idleCauses += 1;
  }

  #idleEnds() {
    if (this.#idleCauses === 0) {
      return;
    }
    this.#idleCauses -= 1;
    if (this.#idleCauses === 0) {
      this.#idleMs += this.#now() - this.#idleSince;
    }
  }

  /** An input read of this run starts waiting for bytes. */
  inputWaitBegins() {
    this.#idleBegins();
  }

  /** An input read of this run has its bytes. */
  inputWaitEnds() {
    this.#idleEnds();
  }

  /** The process is stopped. */
  stopped() {
    this.#idleBegins();
  }

  /** The process runs again. */
  continued() {
    this.#idleEnds();
  }

  /**
   * Milliseconds of the run's own work so far.
   *
   * @param {number} [at]
   * @returns {number}
   */
  workingMs(at = this.#now()) {
    const idleNow = this.#idleCauses > 0 ? at - this.#idleSince : 0;
    return Math.max(0, at - this.#startedAt - this.#idleMs - idleNow);
  }
}
