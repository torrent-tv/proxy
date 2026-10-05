/** Request a complete timeline when the container header declares no duration. */
export async function readPlaybackDeclarations(orchestrator, params) {
  const tracks = await orchestrator.inspect(params, "tracks");
  if (tracks.kind !== "result") return tracks;
  let media = await orchestrator.inspect(params, "media-info");
  if (media.kind !== "result") return media;
  if (!(media.value.durationSeconds > 0)) {
    const packets = await orchestrator.inspect({ ...params, packetInterval: undefined }, "packets");
    if (packets.kind !== "result") return packets;
    media = await orchestrator.inspect(params, "media-info");
    if (media.kind !== "result") return media;
    if (!(media.value.durationSeconds > 0)) {
      return { kind: "terminal", reason: "media-duration-unavailable",
        message: "The complete source index does not declare a positive playback duration." };
    }
  }
  return { kind: "result", value: { tracks: tracks.value, media: media.value } };
}
