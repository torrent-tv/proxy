/**
 * @file Which output a viewer has on screen.
 *
 * Every request that names the picture's session — a seek, a progress poll, a
 * link report, a release — means the stream the viewer is actually watching,
 * and after a quality change that is another session. The browser is never told
 * about the swap: it holds one session id for the whole file, which is what
 * keeps the switch out of the state machine on that side.
 *
 * KEPT PER VIEWER, because one picture is shared by everyone watching it and a
 * quality step is a session of its own. With one answer for the session, a step
 * taken by one viewer moved the other one's stream, and that viewer's next seek
 * was forwarded to a rung they never chose. The session's own field remains the
 * answer for a viewer who cannot name themselves, and is the last rung anybody
 * moved to.
 *
 * It is handed the picture, a name, the live sessions and the registry of
 * viewers, and it HOLDS none of them — but it is not read-only: finding a rung
 * that has been disposed, it puts both remembers back on the picture, or the
 * next question gets the same dead answer. It lives in the VIEWER layer because
 * the question is about a person — which of several equally live outputs is
 * theirs — and it knows nothing of encoders, files or heights.
 */

/**
 * @param {object} params
 * @param {object} params.base - The picture's own session.
 * @param {string} [params.consumerId] - Whose screen. Empty asks about the
 *   session's own last answer, which is what an unnamed browser gets.
 * @param {{ get: (id: string) => object | undefined }} params.sessions - Every live session, by id.
 * @param {{ of: (session: object, consumerId: string) => { activeVariantId: string | null } }} params.viewers
 * @returns {object} A live session, never a disposed one.
 */
export function activeOutputFor({ base, consumerId = "", sessions, viewers }) {
  const named = consumerId ? base.viewers?.get(consumerId)?.activeVariantId ?? null : null;
  const activeId = named ?? base.activeVariantId;
  if (!activeId || activeId === base.id) {
    return base;
  }
  const active = sessions.get(activeId);
  if (!active || active.state === "disposed") {
    // The rung is gone, so the viewer is watching the picture again. Said in
    // both places that remember it, or the next question gets the same dead
    // answer.
    if (named) {
      viewers.of(base, consumerId).activeVariantId = null;
    }
    if (base.activeVariantId === activeId) {
      base.activeVariantId = base.id;
    }
    return base;
  }
  return active;
}
