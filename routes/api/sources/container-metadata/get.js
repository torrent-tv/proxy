/**
 * What one file of a registered source states about the work it carries.
 *
 * GET /api/sources/:sourceKey/files/:fileIndex/container-metadata
 *
 * Answers `200` with the file's statements (`services/media/container/work-tags.js`)
 * once they are read, `202 { status: "pending" }` while the bytes at the edges of
 * the file have not arrived (the page asks again), and `404` where the format
 * states nothing this proxy reads or the file cannot be read. The reading never
 * asks the swarm for anything beyond the first and the last piece of the file,
 * which opening a file fetches anyway.
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{
 *   sourceRegistry: { get: (key: string) => unknown },
 *   inspectWorkTags: (address: { sourceKey: string, fileIndex: number, requestId?: string }) => Promise<{ kind: string, value?: object, reason?: string }>
 * }} deps
 * @returns {Promise<void>}
 */
export async function handleApiSourceContainerMetadataGet(req, reply, { sourceRegistry, inspectWorkTags }) {
  const sourceKey = typeof req.params?.sourceKey === "string" ? req.params.sourceKey.trim() : "";
  const fileIndex = Number(req.params?.fileIndex);
  if (!sourceKey || !Number.isInteger(fileIndex) || fileIndex < 0) {
    return reply.code(400).send({ error: "sourceKey and a file index are required." });
  }
  if (!sourceRegistry.get(sourceKey)) return reply.code(404).send({ error: "Source key was not found." });
  const result = await inspectWorkTags({ sourceKey, fileIndex, requestId: req.id });
  if (result.kind === "result" && result.value) return reply.send(result.value);
  if (result.kind === "terminal") return reply.code(404).send({ error: `This file states nothing about the work (${result.reason ?? "unavailable"}).` });
  return reply.code(202).send({ status: "pending" });
}
