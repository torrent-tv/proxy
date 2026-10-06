/**
 * The cover image one file of a registered source carries inside it.
 *
 * GET /api/sources/:sourceKey/files/:fileIndex/cover
 *
 * Answers `200` with the image's bytes and its type, `202 { status: "pending" }`
 * while they have not arrived, and `404` where the file carries none. Nothing
 * keeps the image but the file itself: the page turns the bytes into a `blob:`
 * address for as long as it shows them.
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{
 *   sourceRegistry: { get: (key: string) => unknown },
 *   inspectCover: (address: { sourceKey: string, fileIndex: number, requestId?: string }) => Promise<{ kind: string, value?: { type: string, bytes: Buffer }, reason?: string }>
 * }} deps
 * @returns {Promise<void>}
 */
export async function handleApiSourceCoverGet(req, reply, { sourceRegistry, inspectCover }) {
  const sourceKey = typeof req.params?.sourceKey === "string" ? req.params.sourceKey.trim() : "";
  const fileIndex = Number(req.params?.fileIndex);
  if (!sourceKey || !Number.isInteger(fileIndex) || fileIndex < 0) {
    return reply.code(400).send({ error: "sourceKey and a file index are required." });
  }
  if (!sourceRegistry.get(sourceKey)) return reply.code(404).send({ error: "Source key was not found." });
  const result = await inspectCover({ sourceKey, fileIndex, requestId: req.id });
  if (result.kind === "result" && result.value) return reply.type(result.value.type).send(result.value.bytes);
  if (result.kind === "terminal") return reply.code(404).send({ error: `This file carries no cover (${result.reason ?? "unavailable"}).` });
  return reply.code(202).send({ status: "pending" });
}
