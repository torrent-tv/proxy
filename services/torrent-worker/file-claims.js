/**
 * @file Who is holding which file open.
 *
 * A claim keeps a file's data from being removed while something is reading it.
 * Until 2.9.77 claims were keyed by `sourceKey:fileIndex`, which quietly made
 * them **shared**: a second reader of the same file found the key taken and
 * added nothing, so the first reader to finish released the claim out from
 * under the second. The proxy reads one file from several places at once —
 * ffmpeg's input, the keyframe index, the codec probe, a second viewer — so
 * this was the normal case, not an edge one.
 *
 * The fix is not a counter. A counter restores the arithmetic but keeps the
 * ambiguity: a release names a file, not a claim, so a duplicate or late
 * release still decrements someone else's hold and nothing can detect it. Here
 * every claim gets its own identity and a release names exactly that claim —
 * so a stray release matches nothing, is reported, and harms no one.
 */

/**
 * @typedef {object} FileClaims
 * @property {(sourceKey: string, fileIndex: number, release: () => void) => string} open
 * @property {(claimId: string) => boolean} close
 * @property {() => void} closeAll
 * @property {number} size
 */

/**
 * Track file claims by identity.
 *
 * @returns {FileClaims}
 */
export function createFileClaims() {
  /** Claim id → the function that releases that one claim. */
  const claims = new Map();
  let counter = 0;

  return {
    /**
     * Record a new claim and return its identity.
     *
     * Each call is a distinct claim even for the same file — that is the whole
     * point.
     *
     * @param {string} sourceKey
     * @param {number} fileIndex
     * @param {() => void} release
     * @returns {string}
     */
    open(sourceKey, fileIndex, release) {
      counter += 1;
      // The file is in the id purely so a log line reads usefully; matching is
      // on the whole string.
      const claimId = `${sourceKey}:${fileIndex}:${counter}`;
      claims.set(claimId, release);
      return claimId;
    },

    /**
     * Release one claim. Returns false when there was no such claim, which is
     * worth logging: it means a release arrived twice, or after teardown.
     *
     * @param {string} claimId
     * @returns {boolean}
     */
    close(claimId) {
      const release = claims.get(claimId);
      if (!release) {
        return false;
      }
      claims.delete(claimId);
      release();
      return true;
    },

    /**
     * Release everything — the worker is shutting down.
     *
     * @returns {void}
     */
    closeAll() {
      for (const [, release] of claims) {
        release();
      }
      claims.clear();
    },

    get size() {
      return claims.size;
    }
  };
}
