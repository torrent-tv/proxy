/** One published download map per file, including download-only metadata reads. */
export class DownloadMaps {
  #files = new Map();
  #publish;
  #resolvePlayback;
  #nextEpoch = 0;

  constructor({ publish, resolvePlayback = async map => map.zones }) {
    if (typeof publish !== "function") throw new TypeError("Download map publication is required.");
    this.#publish = publish;
    this.#resolvePlayback = resolvePlayback;
  }

  async playback({ sourceKey, fileIndex, durationSeconds, zones }) {
    const file = this.#file(sourceKey, fileIndex);
    file.durationSeconds = durationSeconds;
    const revision = ++file.revision;
    const now = Date.now();
    file.sourceZones = zones.map(zone => Number.isFinite(zone.deadlineAt) || !Number.isFinite(zone.withinSeconds)
      ? zone : { ...zone, deadlineAt: now + Math.max(0, zone.withinSeconds) * 1000 });
    let changed = false;
    const retained = file.zones.flatMap(zone => {
      const interval = zone.downloadInterval ?? zone;
      const current = file.sourceZones.find(candidate => candidate.from === interval.from && candidate.to === interval.to);
      const deadlineAt = current && Number.isFinite(current.deadlineAt)
        ? current.deadlineAt + (Math.max(0, zone.from - current.from) - (zone.leadSeconds ?? 0)) * 1000 : current?.deadlineAt;
      if (!current || Object.keys(current).some(key => key !== "from" && key !== "to" && !Object.is(zone[key], key === "deadlineAt" ? deadlineAt : current[key]))) changed = true;
      return current ? [{ ...zone, ...current, from: zone.from, to: zone.to, deadlineAt }] : [];
    });
    this.#setZones(file, retained);
    for (const [statement, metadata] of file.metadata) {
      if (metadata.interval && !this.wantsInterval(sourceKey, fileIndex, metadata.interval)) {
        file.metadata.delete(statement);
        changed = true;
      }
      else if (metadata.interval) {
        const current = file.sourceZones.find(zone => zone.from === metadata.interval.from && zone.to === metadata.interval.to);
        const deadlineAt = Number.isFinite(current.deadlineAt) ? current.deadlineAt - metadata.leadSeconds * 1000 : current.deadlineAt;
        if (metadata.priority !== current.priority || metadata.urgent !== current.urgent || metadata.deadlineAt !== deadlineAt) changed = true;
        metadata.priority = current.priority;
        metadata.urgent = current.urgent;
        metadata.deadlineAt = deadlineAt;
      }
    }
    if (changed) await this.#emit(file);
    if (revision !== file.revision) return;
    const resolved = await this.#resolvePlayback({ sourceKey, fileIndex, durationSeconds, zones: file.sourceZones,
      isCurrent: () => this.#files.get(`${sourceKey}:${fileIndex}`) === file && revision === file.revision });
    if (revision !== file.revision) return;
    this.#setZones(file, resolved);
    return this.#emit(file);
  }

  refresh(sourceKey, fileIndex) {
    const file = this.#files.get(`${sourceKey}:${fileIndex}`);
    if (!file) return Promise.resolve();
    file.refreshAgain = true;
    if (file.refreshPending) return file.refreshPending;
    file.refreshPending = (async () => {
      try {
        do {
          file.refreshAgain = false;
          if (this.#files.get(`${sourceKey}:${fileIndex}`) !== file) return;
          await this.playback({ sourceKey, fileIndex, durationSeconds: file.durationSeconds, zones: file.sourceZones });
        } while (file.refreshAgain);
      } finally { file.refreshPending = null; }
    })();
    return file.refreshPending;
  }

  epoch(sourceKey, fileIndex) {
    return this.#files.get(`${sourceKey}:${fileIndex}`)?.epoch ?? 0;
  }

  native({ sourceKey, fileIndex, zones }) {
    const file = this.#file(sourceKey, fileIndex);
    file.nativeZones = zones;
    return this.#emit(file);
  }

  wantsInterval(sourceKey, fileIndex, { from, to }) {
    return this.#files.get(`${sourceKey}:${fileIndex}`)?.sourceZones.some(zone => zone.from === from && zone.to === to) ?? false;
  }

  /** Exact source ranges already resolved by the download map, without new reads. */
  inputsForOutput(sourceKey, outputKey, index) {
    const sources = [];
    for (const file of this.#files.values()) {
      if (file.sourceKey !== sourceKey) continue;
      const ranges = file.inputs.get(outputKey)?.get(index);
      if (!ranges?.length) continue;
      sources.push({ sourceId: `${sourceKey}:${file.fileIndex}`,
        ranges });
    }
    return sources.length ? sources : null;
  }

  metadata({ sourceKey, fileIndex, statement, result, priority = 100, urgent = true, deadlineAt = 0, interval, leadSeconds = 0, scope = "playback", order = 0 }) {
    if (!Number.isFinite(leadSeconds) || leadSeconds < 0) throw new TypeError("Metadata preparation time must be finite and nonnegative.");
    const file = this.#file(sourceKey, fileIndex);
    if (result.kind === "needs-ranges") {
      if (interval && !this.wantsInterval(sourceKey, fileIndex, interval)) return Promise.resolve();
      const current = interval && file.sourceZones.find(zone => zone.from === interval.from && zone.to === interval.to);
      if (current) {
        priority = current.priority;
        urgent = current.urgent;
        deadlineAt = Number.isFinite(current.deadlineAt) ? current.deadlineAt - leadSeconds * 1000 : current.deadlineAt;
      }
      file.metadata.set(statement, { ranges: result.ranges, requestId: result.requestId, priority, urgent, deadlineAt, interval, leadSeconds, scope, order });
    } else if (result.kind !== "needs-memory") {
      // Allocation refusal says nothing about whether previously missing
      // source bytes have arrived. Keep their demand until the read resolves.
      file.metadata.delete(statement);
    }
    return this.#emit(file);
  }

  withdrawMetadata(sourceKey, fileIndex, statement) {
    const file = this.#files.get(`${sourceKey}:${fileIndex}`);
    return file?.metadata.delete(statement) ? this.#emit(file) : Promise.resolve();
  }

  repriceMetadata(sourceKey, fileIndex, statement, demand) {
    const file = this.#files.get(`${sourceKey}:${fileIndex}`);
    const metadata = file?.metadata.get(statement);
    if (!metadata || Object.keys(demand).every(key => Object.is(metadata[key], demand[key]))) return Promise.resolve();
    Object.assign(metadata, demand);
    return this.#emit(file);
  }

  forget(sourceKey, fileIndex, { keepPreparation = false } = {}) {
    const file = this.#file(sourceKey, fileIndex);
    this.#setZones(file, []);
    file.sourceZones = [];
    if (!keepPreparation) file.nativeZones = [];
    file.revision++;
    file.epoch = ++this.#nextEpoch;
    for (const [statement, metadata] of file.metadata) {
      if (!keepPreparation || metadata.scope !== "preparation") file.metadata.delete(statement);
    }
    // Keep the publication sequence when the same file is requested again.
    return this.#emit(file);
  }

  /** Closing a source discards its maps and cancels queued publications. */
  retire(sourceKey) {
    for (const [key, file] of this.#files) {
      if (file.sourceKey !== sourceKey) continue;
      file.revision++;
      this.#files.delete(key);
    }
  }

  #file(sourceKey, fileIndex) {
    if (typeof sourceKey !== "string" || !sourceKey || !Number.isSafeInteger(fileIndex) || fileIndex < 0) {
      throw new TypeError("A download map requires a source file address.");
    }
    const key = `${sourceKey}:${fileIndex}`;
    let file = this.#files.get(key);
    if (!file) {
      file = { sourceKey, fileIndex, durationSeconds: 0, zones: [], inputs: new Map(), nativeZones: [], sourceZones: [], revision: 0, epoch: ++this.#nextEpoch, metadata: new Map(), pending: Promise.resolve() };
      this.#files.set(key, file);
    }
    return file;
  }

  #setZones(file, zones) {
    file.zones = zones;
    file.inputs = new Map();
    for (const zone of zones) {
      if (typeof zone.outputKey !== "string" || !Number.isSafeInteger(zone.index)) continue;
      let output = file.inputs.get(zone.outputKey);
      if (!output) file.inputs.set(zone.outputKey, output = new Map());
      let ranges = output.get(zone.index);
      if (!ranges) output.set(zone.index, ranges = []);
      ranges.push({ start: zone.byteStart, end: zone.byteEnd + 1 });
    }
  }

  #emit(file) {
    const zones = [...file.zones, ...file.nativeZones];
    for (const { ranges, requestId, priority, urgent, deadlineAt, order } of file.metadata.values()) {
      for (const [byteStart, byteEnd] of ranges) {
        zones.push({ byteStart, byteEnd, priority, urgent, downloadOnly: true, requestId, deadlineAt, ...(order ? { order } : {}) });
      }
    }
    const publication = { sourceKey: file.sourceKey, fileIndex: file.fileIndex, durationSeconds: file.durationSeconds, zones };
    const pending = file.pending.then(() => {
      if (this.#files.get(`${file.sourceKey}:${file.fileIndex}`) === file) return this.#publish(publication);
    });
    // A failed publication must not prevent the next state change from being sent.
    file.pending = pending.catch(() => undefined);
    return pending;
  }
}
