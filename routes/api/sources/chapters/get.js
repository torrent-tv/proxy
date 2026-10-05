/** Snapshot only; chapter discovery never delays playback preparation. */
export function handleApiSourceChaptersGet(req, reply, { chapterController }) {
  const sourceKey = String(req.params?.sourceKey ?? "");
  const rawIndex = req.query?.fileIndex;
  const fileIndex = typeof rawIndex === "string" && /^\d+$/.test(rawIndex) ? Number(rawIndex) : NaN;
  const result = chapterController.get({ sourceKey, fileIndex });
  return reply.header("Cache-Control", "no-store").code(result.status).send(result.body);
}
