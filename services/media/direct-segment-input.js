/**
 * @file The bytes one segment reads, from an index its container already
 * holds, for the download map's pass (torrent-tv/meta#178).
 *
 * The pass works out every segment of every output a viewer watches, one at a
 * time. A segment read from the original file is answered by arithmetic over
 * the index; a soundtrack segment of an AVI needs the sound's packet table,
 * which is built once for the whole film. While that table was being built the
 * pass waited for it, and the picture's segments after the soundtrack's first
 * were not stated to the swarm: field r42 (Home Assistant, 2026-10-14), the
 * picture's next piece was asked for 4.0 s after its input asked for it, 3.2 s
 * of that behind the table.
 */
import { SegmentInputs } from "./SegmentInputs.js";

/**
 * @param {object} container - Has `supportsOriginalSourceRanges`, `readSourceRanges` and `readPacketIndex`.
 * @param {{ interval: object, tracks: object[], mode: (track: object) => string }} segment
 * @param {(built: Promise<void>) => void} whenBuilt - Given a promise that settles when a table
 *   still being built is built or refused, when the answer is "pending".
 * @returns {Promise<{ kind: string, ranges?: Array<[number, number]> }>} `pending` when the
 *   answer waits for a table still being built.
 */
export async function directSegmentInput(container, { interval, tracks, mode }, whenBuilt) {
  if (await container.supportsOriginalSourceRanges(interval) === true) return container.readSourceRanges(interval);
  // The table is begun, or joined, and not waited for.
  if (container.packetTableWouldWait?.() === true) {
    whenBuilt(container.readPacketIndex(interval).then(() => undefined, () => undefined));
    return { kind: "pending" };
  }
  const index = await container.readPacketIndex(interval);
  await index.prepareAudioDependencies?.(interval, container.readRange);
  return new SegmentInputs({ index, tracks }).forInterval({ ...interval, mode });
}
