/**
 * @file What an ffmpeg exit MEANS — as a pure classification, so the four
 * possibilities can be exercised without spawning anything.
 *
 * The exit handler is where two of this project's most expensive failures
 * lived, and both were classification faults rather than logic faults:
 *
 *   - 2.9.104: ffmpeg exits 0 when it reaches the end of the file AND when its
 *     input simply stops delivering bytes — over HTTP the two look identical to
 *     it. A run that had made 188 segments of 624 reported itself complete, the
 *     player consumed what was on disk and froze on the first segment nobody
 *     was making. The difference is not in the exit code; it is in how far the
 *     run got against the playlist we published.
 *   - The predecessor a seek kills exits with a signal and used to be handled
 *     as the session's own run dying. Which is why "was this process already
 *     replaced" is the FIRST question here rather than a check somewhere in the
 *     caller: an exit that belongs to a superseded run means nothing at all,
 *     and reading it as a failure downgraded a hardware encoder for good.
 *
 * Nothing here touches a session, a process or a clock. The caller decides what
 * to DO about each answer.
 */

/**
 * What this exit says about the run.
 *
 * @readonly
 */
export const ENCODE_EXIT = Object.freeze({
  /** The process was already replaced or the session is gone: it says nothing. */
  IGNORED: "ignored",
  /**
   * We stopped it on purpose — moved off covered material, no longer wanted,
   * the output was dropped.
   *
   * Abnormal by the rule this vocabulary exists to serve: exactly one ending is
   * normal, and our own kill is not it. Hiding it among the normal endings is
   * what would make the count of abnormal endings useless.
   */
  STOPPED: "stopped",
  /**
   * It was found to be over without having said so.
   *
   * Only a run handed over from elsewhere can end this way; one that owns its
   * own process reports its own ending. Counted apart precisely because it
   * means nobody watched it end.
   */
  GONE: "gone",
  /** Reached the end of the file. */
  COMPLETE: "complete",
  /** Claimed success, stopped short of the last segment — the input dried up. */
  SHORT: "short",
  /** The input was not there. Recoverable: the data can come back. */
  INPUT_LOST: "input-lost",
  /** Anything else. Terminal for this target until something restarts it. */
  FAILED: "failed"
});

/**
 * Classify one exit.
 *
 * `inputUnavailable` is decided by the caller from ffmpeg's own message, and it
 * is asked BEFORE the hardware-encoder question deliberately: a run that died
 * because its torrent data went away says nothing whatever about the encoder,
 * and treating it as an encoder failure is how a host with NVENC came to
 * downgrade itself to software over a missing piece.
 *
 * @param {object} facts
 * @param {boolean} [facts.superseded] - This process was replaced or the
 *   session disposed before the exit arrived.
 * @param {number | null} [facts.code] - Exit code, null when killed by a signal.
 * @param {number | null} [facts.producedThrough] - Highest segment index this
 *   session has on disk, or null when that could not be read.
 * @param {number | null} [facts.lastSegmentIndex] - Index of the file's last
 *   segment according to the published playlist, or null when unknown.
 * @param {number | null} [facts.producedCount] - How many segments THIS run
 *   made. Zero and "could not be read" are different facts and were both `null`
 *   until 2026-09-11: a run that made nothing exited zero and was recorded as
 *   having finished, which is how a segment that does not exist came to be
 *   believed present for forty-six minutes.
 * @param {boolean} [facts.inputUnavailable] - The error names a missing input.
 * @returns {string} One of {@link ENCODE_EXIT}.
 */
export function classifyEncodeExit({
  superseded = false,
  code = null,
  producedThrough = null,
  lastSegmentIndex = null,
  producedCount = null,
  inputUnavailable = false
} = {}) {
  if (superseded) {
    return ENCODE_EXIT.IGNORED;
  }
  if (code === 0) {
    // PRODUCING NOTHING IS THE CLEAREST CASE OF NOT FINISHING, and it used to be
    // the one case that read as success: `producedThrough` is null when the run
    // made no segment at all, null is "unknown", and unknown fell through to
    // complete. Field 2026-09-11: a run given #541..#541 was handed a start
    // later than its own end, wrote 190 bytes that are not a fragment, exited
    // zero — and was recorded as having reached the end of what it was given.
    // Nothing asked for that segment again for forty-six minutes, until the
    // viewer arrived at it and waited 23 s for a 404.
    if (producedCount === 0 && lastSegmentIndex !== null) {
      return ENCODE_EXIT.SHORT;
    }
    const stoppedShort =
      lastSegmentIndex !== null &&
      producedThrough !== null &&
      producedThrough < lastSegmentIndex;
    return stoppedShort ? ENCODE_EXIT.SHORT : ENCODE_EXIT.COMPLETE;
  }
  return inputUnavailable ? ENCODE_EXIT.INPUT_LOST : ENCODE_EXIT.FAILED;
}
