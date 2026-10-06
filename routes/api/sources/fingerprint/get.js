/**
 * The OpenSubtitles hash of one file of a registered source.
 *
 * GET /api/sources/:sourceKey/files/:fileIndex/fingerprint
 *
 * Answers `200 { hash, size }` once both edges of the file are here,
 * `202 { status: "pending" }` while they are not (the demand for them is already
 * stated; the page asks again), and `404` for a file that has no hash because it
 * is shorter than 128 KiB. Computing it reads 128 KiB, so it costs nothing worth
 * a limit; it does not start a download of anything else.
 *
 * @param {import("fastify").FastifyRequest} req
 * @param {import("fastify").FastifyReply} reply
 * @param {{
 *   sourceRegistry: { get: (key: string) => unknown },
 *   inspectFingerprint: (address: { sourceKey: string, fileIndex: number, requestId?: string }) => Promise<{ kind: string, value?: { hash: string, size: number }, reason?: string }>
 * }} deps
 * @returns {Promise<void>}
 */
export async function handleApiSourceFingerprintGet(req, reply, { sourceRegistry, inspectFingerprint }) {
  const sourceKey = typeof req.params?.sourceKey === "string" ? req.params.sourceKey.trim() : "";
  const fileIndex = Number(req.params?.fileIndex);
  if (!sourceKey || !Number.isInteger(fileIndex) || fileIndex < 0) {
    return reply.code(400).send({ error: "sourceKey and a file index are required." });
  }
  if (!sourceRegistry.get(sourceKey)) return reply.code(404).send({ error: "Source key was not found." });
  const result = await inspectFingerprint({ sourceKey, fileIndex, requestId: req.id });
  if (result.kind === "result" && result.value) return reply.send({ hash: result.value.hash, size: result.value.size });
  if (result.kind === "terminal") return reply.code(404).send({ error: `This file has no hash (${result.reason ?? "unavailable"}).` });
  return reply.code(202).send({ status: "pending" });
}
