/** Report the position and intent of a viewer playing the source directly. */
export async function handleApiSourceViewerPost(req, reply, { sourceRegistry, viewers }) {
  const { sourceKey, fileIndex: indexText } = req.params;
  const fileIndex = Number(indexText);
  const body = req.body;
  if (!Number.isSafeInteger(fileIndex) || fileIndex < 0 || !body || typeof body !== "object" ||
      typeof body.consumerId !== "string" || !body.consumerId) {
    return reply.code(400).send({ error: "A file index and consumerId are required.", canRetry: false });
  }
  if (!sourceRegistry.get(sourceKey)) return reply.code(404).send({ error: "Source key was not found.", canRetry: false });
  if (!viewers.reportSource(body.consumerId, sourceKey, fileIndex, body)) {
    return reply.code(409).send({ error: "The source selection is no longer current.",
      code: "REQUEST_OBSOLETE", canRetry: false });
  }
  return reply.send({ received: true });
}
