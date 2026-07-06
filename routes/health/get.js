/**
 * Basic liveness check for load balancers and container orchestrators.
 *
 * GET /health
 *
 * @param {import("fastify").FastifyRequest} _req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ version: string }} deps
 * @returns {Promise<void>}
 */
export async function handleHealthGet(_req, reply, { version } = {}) {
  return reply.send({ ok: true, version });
}
