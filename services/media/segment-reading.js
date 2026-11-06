import { ContainerTrack } from "./tracks/ContainerTrack.js";

/**
 * What a segment reads: the one rule that names the tracks of a choice and the
 * interval the segment states. Pure; keeps no state.
 */

/** The track a choice names, or null. The picture is the first usable video track (torrent-tv/meta#49) and ignores `choice.index`; any other type is chosen by its place among the tracks of that type. */
export function trackFor(trackList, choice) {
  if (choice.type === "video") return ContainerTrack.firstUsable(trackList, "video");
  return trackList.filter(track => track.type === choice.type)[choice.index] ?? null;
}

/** The tracks of every choice, in choice order, and each one's mode; null when any choice finds no track. */
export function selectTracks(trackList, choices) {
  const wanted = [], modes = new Map();
  for (const choice of choices) {
    const track = trackFor(trackList, choice);
    if (!track) return null;
    wanted.push(track);
    modes.set(track, choice.mode);
  }
  return { wanted, modes };
}

/** The interval a segment states: the source interval, then `trackIds`, then `modes`. The key order matters: it is the `rangesKey`. */
export function readingInterval({ wanted, modes }, sourceInterval) {
  return { ...sourceInterval, trackIds: wanted.map(track => track.trackNumber),
    modes: Object.fromEntries(wanted.map(track => [track.trackNumber, modes.get(track)])) };
}

export function segmentReading(trackList, choices, sourceInterval) {
  const selection = selectTracks(trackList, choices);
  if (!selection) return null;
  return { ...selection, interval: readingInterval(selection, sourceInterval) };
}
