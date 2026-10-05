/** Record subtitle choice independently of document delivery. */
export async function handleApiSubtitlesPost(req, reply, { viewers, sourceRegistry, subtitleFilesFor, subtitleTracksFor }) {
  const body = req.body ?? {};
  const { consumerId, sourceKey, fileIndex, trackIndex = null, off = false } = body;
  if (typeof consumerId !== "string" || !consumerId || typeof sourceKey !== "string" ||
    !Number.isSafeInteger(fileIndex) || fileIndex < 0 || typeof off !== "boolean" ||
    (trackIndex !== null && (!Number.isSafeInteger(trackIndex) || trackIndex < 0))) {
    return reply.code(400).send({ error: "A viewer, source and subtitle file are required.", canRetry: false });
  }
  const viewer = viewers.get(consumerId);
  if (!sourceRegistry.get(sourceKey) || !viewer || viewer.gone || viewer.source?.sourceKey !== sourceKey ||
    (!off && trackIndex === null && !subtitleFilesFor(sourceKey, viewer.source.selectedFileIndex).includes(fileIndex))) {
    return reply.code(409).send({ code: "REQUEST_OBSOLETE", error: "The subtitle selection is no longer current.", canRetry: false });
  }
  if (!off && trackIndex !== null && fileIndex === viewer.source.selectedFileIndex) {
    const track = subtitleTracksFor(sourceKey, fileIndex).find(track => track.declaredIndex === trackIndex);
    if (!track || track.isTextBased?.() !== true) {
      return reply.code(422).send({ error: "The subtitle track is not supported.", canRetry: false });
    }
  }
  if (off) viewers.clearsSubtitle(consumerId, sourceKey);
  else if (!viewers.selectsSubtitle(consumerId, sourceKey, fileIndex, trackIndex)) {
    return reply.code(409).send({ code: "REQUEST_OBSOLETE", canRetry: false });
  }
  return reply.send({ received: true });
}
