/**
 * Shared HTTP responses used by more than one route.
 */
/**
 * The answer given when no output suits this viewer: nothing this proxy holds
 * or could produce is admitted by their link. Machine-readable, because the
 * page has to explain it to the viewer and offer what they can do; the
 * figures are the ones the decision was made on.
 *
 * 409 and not a 5xx: nothing is wrong with the proxy, and repeating the same
 * request against the same link gives the same answer.
 *
 * @param {import("fastify").FastifyReply} reply
 * @param {{ reason: string, figures: object | null, wantedKey?: string }} details
 * @returns {import("fastify").FastifyReply}
 */
export function replyOutputUnavailable(reply, details) {
  return reply.code(409).send({
    error: `No output suits this viewer: ${details?.reason ?? "unknown"}.`,
    outcome: "output-unavailable",
    reason: details?.reason ?? "",
    figures: details?.figures ?? null
  });
}

/**
 * The answer given when this machine cannot take the output asked for: nothing
 * it has shown it can encode fits, or it has no place for one more encoder.
 * The page answers it by asking the rest of the pool before anything plays.
 *
 * @param {import("fastify").FastifyReply} reply
 * @param {{ reason: string, figures?: object | null }} details
 * @returns {import("fastify").FastifyReply}
 */
export function replyNoCapacity(reply, details) {
  return reply.code(409).send({
    error: `This proxy cannot take this video now: ${details?.reason ?? "unknown"}.`,
    outcome: "no-capacity",
    reason: details?.reason ?? "",
    figures: details?.figures ?? null
  });
}

/**
 * The answer given when an address this viewer was already given cannot be
 * given again without risking a piece under a header it may not match. The
 * page answers it by starting a new viewing where the picture is — which is
 * why it is not a "retry": the same request would be answered the same way.
 *
 * @param {import("fastify").FastifyReply} reply
 * @param {{ reason: string }} details
 * @returns {import("fastify").FastifyReply}
 */
export function replyAssignmentLost(reply, details) {
  return reply.code(409).send({
    error: `This part was answered by an output that has gone: ${details?.reason ?? "unknown"}.`,
    outcome: "assignment-lost",
    reason: details?.reason ?? ""
  });
}
