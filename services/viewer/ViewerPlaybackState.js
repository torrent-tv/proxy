/**
 * Cross-request measurements owned by one live viewing. A viewer is the key,
 * rather than its reusable wire id, so a later viewing with the same id starts
 * with fresh measurements.
 */
export class ViewerPlaybackState {
  #byViewer = new Map();
  #waitOrder = new Map();

  #stateFor(viewer, create = false) {
    if (!viewer || typeof viewer !== "object") return null;
    let state = this.#byViewer.get(viewer);
    if (!state && create) {
      state = { ratesByOutput: new Map(), waits: new Map() };
      this.#byViewer.set(viewer, state);
    }
    return state ?? null;
  }

  rateState(viewer, output, playbackReadiness, lookaheadSeconds) {
    const owner = this.#stateFor(viewer, true);
    let state = owner.ratesByOutput.get(output);
    if (!state) {
      state = { link: new playbackReadiness.RateTrend(lookaheadSeconds), sources: new Map() };
      owner.ratesByOutput.set(output, state);
    }
    return state;
  }

  owns(viewer, output, state) {
    return this.#stateFor(viewer)?.ratesByOutput.get(output) === state;
  }

  forgetOutput(output) {
    for (const [viewer, owner] of this.#byViewer) {
      owner.ratesByOutput.delete(output);
      this.#deleteIfEmpty(viewer, owner);
    }
  }

  forgetViewerOutput(viewer, output) {
    const owner = this.#stateFor(viewer);
    if (!owner) return false;
    const removed = owner.ratesByOutput.delete(output);
    this.#deleteIfEmpty(viewer, owner);
    return removed;
  }

  addLinkReading(state, at, mbps) {
    state.link.add(at, mbps * 1_000_000);
  }

  sourceRateReadings(state, id, stats, now, playbackReadiness, lookaheadSeconds) {
    let source = state.sources.get(id);
    if (!source) {
      const { RateTrend, SessionRate } = playbackReadiness;
      source = { delivered: new RateTrend(lookaheadSeconds), free: new RateTrend(lookaheadSeconds),
        deliveredAll: new SessionRate(), freeAll: new SessionRate(), limit: null };
      state.sources.set(id, source);
    }
    if (Number.isFinite(stats?.downloadSpeed) && stats.downloadSpeed >= 0) {
      source.delivered.add(now, stats.downloadSpeed);
      source.deliveredAll.add(now, stats.downloadSpeed);
    }
    const limit = stats?.selectionLimit;
    if (limit && source.limit && limit.freeMs > source.limit.freeMs) {
      const free = Math.max(0, limit.freeBytes - source.limit.freeBytes) * 1000 / (limit.freeMs - source.limit.freeMs);
      source.free.add(now, free);
      source.freeAll.add(now, free);
    }
    if (limit) source.limit = limit;
    return sourceService(source.free.snapshot(), source.delivered.snapshot(),
      summary => playbackReadiness.forecastRate(summary, now, 0, "time"));
  }

  sourceTailRateReadings(state, id, now, playbackReadiness) {
    const source = state.sources.get(id);
    if (!source) return null;
    return sourceService(source.freeAll.snapshot(), source.deliveredAll.snapshot(),
      summary => playbackReadiness.forecastRate(summary, now, 0, "time"));
  }

  sourceRateSummaries(state, id) {
    const source = state.sources.get(id);
    return source ? { free: source.free.snapshot(), delivered: source.delivered.snapshot() } : null;
  }

  getWait(viewer, waitId) {
    return this.#stateFor(viewer)?.waits.get(waitId) ?? null;
  }

  hasWait(viewer, waitId) {
    return this.#stateFor(viewer)?.waits.has(waitId) ?? false;
  }

  recordWaitSnapshot({ viewer, consumerId, generation, sourceKey, fileIndex, waitId, features }) {
    const owner = this.#stateFor(viewer, true);
    const current = owner.waits.get(waitId);
    const context = current?.waitId === waitId ? current : {
      consumerId, generation, sourceKey, fileIndex, waitId, snapshots: [], observedWaits: new Set()
    };
    const measuredAt = performance.now();
    const ageElapsedMs = Number.isFinite(context.featuresMeasuredAt)
      ? Math.max(0, measuredAt - context.featuresMeasuredAt) : 0;
    const mergedFeatures = mergeWaitFeatures(context.features, features, ageElapsedMs);
    Object.assign(context, { consumerId, generation, sourceKey, fileIndex, waitId, features: mergedFeatures,
      featuresMeasuredAt: measuredAt, updatedAt: Date.now() });
    const previous = context.snapshots.at(-1);
    if (!previous || JSON.stringify(previous) !== JSON.stringify(mergedFeatures)) {
      const snapshot = { ...mergedFeatures };
      if (context.snapshots.length < 2) context.snapshots.push(snapshot);
      else context.snapshots[1] = snapshot;
    }
    owner.waits.set(waitId, context);
    if (!this.#waitOrder.has(context)) this.#waitOrder.set(context, { viewer, waitId });
    return context;
  }

  noteFirstFrame({ viewer, generation, waitId, wait, elapsedMs, stages, record }) {
    const observation = this.getWait(viewer, waitId);
    if (!observation || observation.generation !== generation || !Number.isSafeInteger(wait) || wait < 0 ||
        observation.observedWaits.has(wait) || !Number.isFinite(elapsedMs) || elapsedMs < 0) return false;
    const initialFeatures = observation.snapshots[0];
    if (initialFeatures) record({ seconds: elapsedMs / 1000, features: initialFeatures,
      featureSnapshots: observation.snapshots.slice(1), stages });
    observation.observedWaits.add(wait);
    observation.updatedAt = Date.now();
    return true;
  }

  deleteWait(viewer, waitId) {
    const owner = this.#stateFor(viewer);
    if (!owner) return false;
    const context = owner.waits.get(waitId);
    const removed = owner.waits.delete(waitId);
    if (context) this.#waitOrder.delete(context);
    this.#deleteIfEmpty(viewer, owner);
    return removed;
  }

  pruneWaits(now = Date.now(), maxObservations = 1000) {
    const cutoff = now - 30 * 60_000;
    for (const [viewer, owner] of this.#byViewer) {
      for (const [waitId, value] of owner.waits) {
        if (value.updatedAt < cutoff) {
          owner.waits.delete(waitId);
          this.#waitOrder.delete(value);
        }
      }
      if (owner) this.#deleteIfEmpty(viewer, owner);
    }
    while (this.#waitOrder.size > maxObservations) {
      const [context, { viewer, waitId }] = this.#waitOrder.entries().next().value;
      const owner = this.#stateFor(viewer);
      owner?.waits.delete(waitId);
      this.#waitOrder.delete(context);
      if (owner) this.#deleteIfEmpty(viewer, owner);
    }
  }

  forgetViewer(viewer) {
    const owner = this.#stateFor(viewer);
    if (!owner) return false;
    for (const context of owner.waits.values()) this.#waitOrder.delete(context);
    return this.#byViewer.delete(viewer);
  }

  viewerCount() {
    return this.#byViewer.size;
  }

  waitCount(viewer) {
    return this.#stateFor(viewer)?.waits.size ?? 0;
  }

  #deleteIfEmpty(viewer, owner) {
    if (owner.ratesByOutput.size === 0 && owner.waits.size === 0) this.#byViewer.delete(viewer);
  }
}

export function sourceService(free, delivered, rateOf) {
  if (!free) return delivered;
  if (!delivered) return free;
  return (rateOf(delivered) ?? 0) > (rateOf(free) ?? 0) ? delivered : free;
}

function mergeWaitFeatures(previous, incoming, ageElapsedMs) {
  const merged = { ...(previous ?? {}) };
  for (const [key, value] of Object.entries(incoming ?? {})) {
    if (value === null || value === undefined) {
      if (!Object.hasOwn(merged, key)) merged[key] = null;
      continue;
    }
    if (key === "extension") {
      if (typeof value === "string" && value.length > 0) merged[key] = value;
      continue;
    }
    if (key === "fileAvailable") {
      if (typeof value === "boolean") merged[key] = value;
      continue;
    }
    if (key === "videoOperation" || key === "audioOperation") {
      if (value === "copy" || value === "encode") merged[key] = value;
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
        ((key === "fileLength" || key === "linkMbps") && value === 0)) continue;
    merged[key] = value;
  }
  const hasIncomingAge = Number.isFinite(incoming?.linkSampleAgeMs) && incoming.linkSampleAgeMs >= 0;
  if (Number.isFinite(merged.linkSampleAgeMs) && !hasIncomingAge) {
    merged.linkSampleAgeMs += Number.isFinite(ageElapsedMs) ? Math.max(0, ageElapsedMs) : 0;
  }
  return merged;
}
