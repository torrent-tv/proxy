/**
 * Docker / Kubernetes readiness probe endpoint.
 *
 * GET /healthz
 *
 * @param {import("fastify").FastifyRequest} _req
 * @param {import("fastify").FastifyReply} reply
 * @returns {Promise<void>}
 */
export async function handleHealthzGet(_req, reply) {
  return reply.send({ ok: true });
}
