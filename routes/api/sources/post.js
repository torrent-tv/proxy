/**
 * Register a torrent source with the proxy and receive a stable source key.
 *
 * POST /api/sources
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ sourceRegistry: ReturnType<import("../../../store/source-registry.js").createSourceRegistry> }} deps
 * @returns {Promise<void>}
 */

/**
 * Extract a plain object from the request body, guarding against
 * non-object payloads (arrays, primitives, null).
 *
 * @param {unknown} body
 * @returns {Record<string, unknown>}
 */
function getPayload(body) {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body;
  }
  return {};
}

export async function handleApiSourcesPost(req, reply, { sourceRegistry, viewers }) {
  const payload = getPayload(req.body);
  const sourceType = typeof payload.sourceType === "string" ? payload.sourceType : "";
  const source = typeof payload.source === "string" ? payload.source : "";
  if (!sourceType || !source) {
    return reply.code(400).send({ error: "sourceType and source are required." });
  }

  const sourceKey = await sourceRegistry.upsert(sourceType, source);
  const consumerId = typeof payload.consumerId === "string" ? payload.consumerId.trim() : "";
  if (consumerId) viewers?.selectsSource(consumerId, sourceKey);
  return reply.send({ sourceKey, playbackMapVersion: 1 });
}
