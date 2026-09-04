/**
 * @file A transcode session, seen as one running encoder.
 *
 * The orchestrator plans runs: what stretch each is making, which has been
 * overtaken, where another is needed. It knows nothing about sessions, routes
 * or ffmpeg, and it should not — its whole content is arithmetic over coverage,
 * demand and the host's budget.
 *
 * A session in this proxy IS a run: one process, one stretch, one position. So
 * this is the seam between the two, and it exists so that the plan can be
 * written once and asked of the sessions that already exist rather than of a
 * second world built beside them.
 *
 * The run this presents is not tied to a viewer in any way. Which viewer asked
 * for the session, and how many are watching it, never reach the plan.
 */

/**
 * @param {object} params
 * @param {object} params.session - The live session this run is.
 * @param {() => number} params.headOf - The next number it will produce.
 * @param {() => number} params.speedOf - How fast it is encoding, as a multiple
 *   of realtime, or 0 when nothing has been measured.
 * @param {() => boolean} params.aliveOf - Whether its process can still be
 *   signalled.
 * @param {(because: string) => void} params.stop
 * @returns {{ id: string, from: number, to: number, head: number, speedX: number, isAlive: boolean, start: (because: string) => void, stop: (because: string) => void }}
 */
export function sessionAsRun({ session, headOf, speedOf, aliveOf, stop }) {
  return {
    id: session.id,
    get from() {
      return Number.isInteger(session.encodeStartIndex) ? session.encodeStartIndex : 0;
    },
    get to() {
      // A run with no end reaches the end of the film. The plan reads that as
      // "this one is making everything in front of it", which is only true
      // while nothing else is; the plan is what decides otherwise.
      return Number.isInteger(session.runEndIndex) ? session.runEndIndex : -1;
    },
    get head() {
      return headOf();
    },
    get speedX() {
      return speedOf();
    },
    get isAlive() {
      return aliveOf();
    },
    // A session-backed run is already going by the time the plan sees it: the
    // browser asked for a stream and one began. Starting is what the session
    // creation did, and there is nothing left here to do.
    start() {},
    stop(because) {
      stop(because);
    }
  };
}
