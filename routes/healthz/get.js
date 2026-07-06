/**
 * Docker / Kubernetes readiness probe endpoint.
 *
 * GET /healthz
 *
 * @param {import("fastify").FastifyRequest} _req
 * @param {import("fastify").FastifyReply} reply
 * @param {{ version: string }} deps
 * @returns {Promise<void>}
 */
export async function handleHealthzGet(_req, reply, { version } = {}) {
  return reply.send({ ok: true, version });
}
