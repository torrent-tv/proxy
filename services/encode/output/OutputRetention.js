/**
 * @file When an output became unused, and which stored segments may leave.
 *
 * Usage is supplied by the viewer layer; stored bytes by storage. This owns
 * only the start of the unused period, never viewers or segment readiness.
 */
export class OutputRetention {
  #unusedSince = new Map();

  observe(key, needed, now) {
    if (needed) this.#unusedSince.delete(key);
    else if (!this.#unusedSince.has(key)) this.#unusedSince.set(key, now);
  }

  expired(key, periodMs, now) {
    const since = this.#unusedSince.get(key);
    return since !== undefined && now - since >= periodMs;
  }

  forgetExcept(keys) {
    for (const key of this.#unusedSince.keys()) {
      if (!keys.has(key)) this.#unusedSince.delete(key);
    }
  }
}

/**
 * Disk-pressure order, from plain storage and viewer facts. Active responses
 * protect their output; a viewer's current segment is never a candidate.
 *
 * @param {{ key: string, segments: { index: number, size: number }[], positions: number[], reading: boolean }[]} outputs
 * @returns {{ key: string, index: number, size: number }[]}
 */
export function leastNeededSegments(outputs) {
  const candidates = [];
  for (const { key, segments, positions, reading } of outputs) {
    if (reading) continue;
    const earliest = positions.length ? Math.min(...positions) : null;
    const furthest = positions.length ? Math.max(...positions) : null;
    for (const { index, size } of segments) {
      if (positions.includes(index)) continue;
      const rank = earliest === null ? 0 : index < earliest ? 1 : 2;
      const distance = earliest === null ? index : index < earliest ? earliest - index : index - furthest;
      candidates.push({ key, index, size, rank, distance });
    }
  }
  return candidates.sort((left, right) => left.rank - right.rank || right.distance - left.distance);
}
