/** Compatibility acknowledgement: source preparation is owned by present viewers. */
export async function handleApiSourceWarmPost(req, reply, { sourceRegistry, viewers }) {
  const sourceKey = typeof req.params.sourceKey === "string" ? req.params.sourceKey.trim() : "";
  if (!sourceKey) return reply.code(400).send({ error: "sourceKey is required." });
  if (!sourceRegistry.get(sourceKey)) return reply.code(404).send({ error: "Source key was not found." });
  const started = (viewers?.forSource(sourceKey).length ?? 0) > 0;
  return reply.send({ started, swarm: started, edges: false, fill: false });
}
