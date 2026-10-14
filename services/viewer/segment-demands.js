/** The tracks of this file an output reads, and how: copied or encoded again. */
export function trackChoicesOf(output, fileIndex) {
  const tracks = [];
  for (const type of ["video", "audio"]) {
    const spec = output.spec?.[type];
    if (spec?.fileIndex !== fileIndex) continue;
    tracks.push({ type, index: type === "video" ? 0 : spec.trackIndex,
      mode: type === "video" ? spec.encode ? "transcode" : "copy" : spec.transcode ? "transcode" : "copy" });
  }
  return tracks;
}
