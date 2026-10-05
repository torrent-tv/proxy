/** The one conversion of a source interval into complete decode input. */
export class SegmentInputs {
  #index;
  #tracks;

  constructor({ index, tracks }) {
    if (typeof index?.inputFor !== "function" || !Array.isArray(tracks)) {
      throw new TypeError("Segment input requires a packet index and declared tracks.");
    }
    this.#index = index;
    this.#tracks = tracks;
  }

  forInterval({ from, to, tracks = this.#tracks, mode = "transcode" }) {
    const packets = [];
    const ranges = [];
    for (const track of tracks) {
      if (!["audio", "video"].includes(track.type)) continue;
      const input = this.#index.inputFor({ trackId: track.trackNumber, from, to, mode: typeof mode === "function" ? mode(track) : mode });
      if (input.kind !== "result") return { ...input, trackId: track.trackNumber };
      packets.push({ track, ...input });
      ranges.push(...input.ranges);
    }
    if (packets.length === 0) return { kind: "terminal", reason: "source-has-no-media-tracks" };
    return { kind: "result", from, to, tracks: packets, ranges: unionRanges(ranges) };
  }

  downloadZones(zones) {
    const converted = [];
    for (const zone of zones) {
      const input = this.forInterval(zone);
      if (input.kind !== "result") return input;
      for (const [byteStart, byteEnd] of input.ranges) converted.push({ ...zone, byteStart, byteEnd });
    }
    return { kind: "result", zones: converted };
  }
}

function unionRanges(ranges) {
  const ordered = ranges.map(range => [...range]).sort((a, b) => a[0] - b[0]);
  const result = [];
  for (const [start, end] of ordered) {
    const previous = result.at(-1);
    if (previous && start <= previous[1] + 1) previous[1] = Math.max(previous[1], end);
    else result.push([start, end]);
  }
  return result;
}
