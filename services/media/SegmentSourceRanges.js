/**
 * @file One resolver of a segment's source byte ranges (torrent-tv/meta#272).
 *
 * The chain tracks, media-info, source-navigation, then the direct index, the
 * container's source ranges or its packets, with the cache of what was worked
 * out, was in `server.js` and repeated by the encoder's input. The method names
 * are those of wait-trace P4.1.
 */
import { directSegmentInput } from "./direct-segment-input.js";
import { SegmentInputs } from "./SegmentInputs.js";

const FALLBACK = "container-index-fallback";

export class SegmentSourceRanges {
  /** @type {Map<string, Array<[number, number]>>} */
  #ranges = new Map();
  #orchestrator;

  /** @param {{ orchestrator: { inspect(params: object, statement: string): Promise<object>, known(sourceKey: string, fileIndex: number): object | null | undefined } }} ports */
  constructor({ orchestrator }) {
    this.#orchestrator = orchestrator;
  }

  keyOf(sourceKey, fileIndex, interval) {
    return `${sourceKey}:${fileIndex}:${JSON.stringify(interval)}`;
  }

  cached(rangesKey) {
    const ranges = this.#ranges.get(rangesKey);
    return ranges ? { kind: "result", ranges, method: "source-range-cache" } : null;
  }

  async tracksOf(params, isCurrent = () => true) {
    const answer = await this.#orchestrator.inspect(params, "tracks");
    if (!isCurrent()) return { kind: "stale" };
    if (answer.kind !== "result") return answer;
    const container = this.#orchestrator.known(params.sourceKey, params.fileIndex);
    if (typeof container?.readSourceRanges !== "function" && typeof container?.readPacketIndex !== "function") {
      return { kind: "needs-index", reason: "packet-index-not-yet-available" };
    }
    return { kind: "result", trackList: answer.value, container };
  }

  async shiftOf(params, isCurrent = () => true) {
    const answer = await this.#orchestrator.inspect(params, "media-info");
    if (!isCurrent()) return { kind: "stale" };
    if (answer.kind !== "result") return answer;
    return { kind: "result", shift: Number(answer.value?.startTimeSeconds) || 0 };
  }

  async navigable(params, isCurrent = () => true) {
    const answer = await this.#orchestrator.inspect(params, "source-navigation");
    if (!isCurrent()) return { kind: "stale" };
    if (answer.kind !== "result") return answer;
    return { kind: "result", value: answer.value === true };
  }

  async readInput(params, { original, tracks, modes, interval }, isCurrent = () => true) {
    const answer = await this.#orchestrator.inspect(params, original ? "source-ranges" : "packets");
    if (!isCurrent()) return { kind: "stale", step: "packets" };
    if (answer.kind !== "result") return { kind: answer.kind, step: "packets", answer };
    const input = original ? answer.value
      : new SegmentInputs({ index: answer.value, tracks }).forInterval({ ...interval, mode: track => modes.get(track) });
    if (input.kind !== "result") return { kind: input.kind, step: "input", answer: input };
    return { kind: "result", method: original ? "container-source-ranges" : "packet-index", input };
  }

  async resolve({ rangesKey, direct, interval, tracks, modes, intervalParams, isCurrent = () => true, whenBuilt = () => {} }) {
    if (direct) {
      let value = null;
      try {
        value = await directSegmentInput(direct, { interval, tracks, mode: track => modes.get(track) }, whenBuilt);
      } catch { value = null; }
      if (value?.kind === "pending") return { kind: "pending", method: "direct-source-index", step: "direct" };
      if (value?.kind === "result") {
        this.#ranges.set(rangesKey, value.ranges);
        return { kind: "result", ranges: value.ranges, method: "direct-source-index" };
      }
    }
    const params = await intervalParams();
    if (!isCurrent()) return { kind: "stale", method: FALLBACK, step: "params" };
    if (!params) return { kind: "needs-source", method: FALLBACK, step: "params" };
    const navigation = await this.navigable(params, isCurrent);
    if (navigation.kind === "stale") return { kind: "stale", method: FALLBACK, step: "navigation" };
    if (navigation.kind !== "result") return { kind: navigation.kind, method: FALLBACK, step: "navigation", answer: navigation };
    const read = await this.readInput(params, { original: navigation.value, tracks, modes, interval }, isCurrent);
    if (read.kind !== "result") return { ...read, method: FALLBACK };
    this.#ranges.set(rangesKey, read.input.ranges);
    return { kind: "result", ranges: read.input.ranges, method: read.method };
  }

  forget(sourceKey) {
    for (const key of this.#ranges.keys()) if (key.startsWith(`${sourceKey}:`)) this.#ranges.delete(key);
  }
}
