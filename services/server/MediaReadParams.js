/**
 * @file The parameters of a media read, and the metadata demand of an encode
 * input, which lasts as long as the signal of its request.
 */

export class MediaReadParams {
  #heldFile;
  #packetMemory;
  #readProbe;
  #probePackets;
  #baseUrl;
  #observeWait;
  #reads;
  #maps;
  #learnKeyframes;
  #formatOf;
  #warn;
  /** @type {WeakMap<AbortSignal, Map<string, { statements: Set<string>, abort: () => void }>>} */
  #trackers = new WeakMap();

  constructor({ heldFile, packetMemory, readProbe, probePackets, baseUrl, observeWait, reads, maps,
    learnKeyframes, formatOf, warn }) {
    this.#heldFile = heldFile;
    this.#packetMemory = packetMemory;
    this.#readProbe = readProbe;
    this.#probePackets = probePackets;
    this.#baseUrl = baseUrl;
    this.#observeWait = observeWait;
    this.#reads = reads;
    this.#maps = maps;
    this.#learnKeyframes = learnKeyframes;
    this.#formatOf = formatOf;
    this.#warn = warn;
  }

  async paramsFor({ sourceKey, fileIndex, requestId, packetInterval, demand, readPriority, signal }) {
    const file = this.#heldFile(sourceKey, fileIndex);
    if (!file) {
      return null;
    }
    const metadataTracker = readPriority?.requestId && signal
      ? this.#trackerFor(signal, sourceKey, fileIndex) : null;
    const maps = this.#maps;
    const params = {
      sourceKey,
      fileIndex,
      requestId,
      signal,
      packetInterval,
      readPriority,
      packetMemory: this.#packetMemory(sourceKey, fileIndex),
      downloadInterval: demand ? { from: demand.from, to: demand.to } : null,
      readRange: (start, end) => file.readHeld(start, Math.min(end, file.length - 1)),
      fileSize: file.length,
      probe: (statement, onRecord) => this.#readProbe({ sourceKey, fileIndex, statement: `ffprobe:${statement}`,
        probe: ({ requestId, signal }) => {
          const url = new URL("/media", this.#baseUrl());
          url.searchParams.set("sourceKey", sourceKey);
          url.searchParams.set("fileIndex", String(fileIndex));
          url.searchParams.set("readId", requestId);
          return this.#probePackets({ url: url.toString(), statement, signal, onRecord });
        } }),
      label: file.name,
      fileOffset: file.offset,
      onObserved: fields => {
        const process = fields.statement === "keyframes" ? "P5"
          : String(fields.statement).startsWith("ffprobe:") ? "X1" : "P2";
        const details = { process, fileIndex, requestId, statement: fields.statement, cached: fields.cached,
          result: fields.result, reason: fields.reason, ranges: fields.ranges,
          queuedMs: fields.queuedMs, readMs: fields.readMs };
        this.#observeWait(sourceKey, "process", { ...details, phase: "begin", at: fields.askedAt });
        this.#observeWait(sourceKey, "process", { ...details, phase: "end", at: fields.endedAt,
          startedAt: fields.askedAt, endedAt: fields.endedAt });
      },
      onTracks: tracks => file.noteVideo(tracks.some(track => track.type === "video")),
      onReadStart: () => ({ storage: this.#reads.revision(sourceKey, fileIndex), memory: this.#reads.memoryRevision(),
        demand: maps.epoch(sourceKey, fileIndex) }),
      onReadResult: async (statement, result, revision) => {
        if (revision.demand !== maps.epoch(sourceKey, fileIndex)) return;
        if (demand && !maps.wantsInterval(sourceKey, fileIndex, demand)) return;
        if (statement === "keyframes" && result.kind === "result") {
          this.#learnKeyframes(params, { times: result.value?.times ?? null, tolerance: result.value?.tolerance ?? 0,
            format: this.#formatOf(sourceKey, fileIndex) });
        }
        const finished = this.#reads.record(params, statement, result, revision.storage, revision.memory);
        if (statement === "chapters" && result.passive) await maps.withdrawMetadata(sourceKey, fileIndex, statement);
        else {
          const metadataStatement = requestId ? `${statement}:${requestId}` : statement;
          if (metadataTracker && result.kind === "needs-ranges") metadataTracker.statements.add(metadataStatement);
          if (metadataTracker && result.kind !== "needs-ranges") metadataTracker.statements.delete(metadataStatement);
          await maps.metadata({ sourceKey, fileIndex, statement: metadataStatement, result,
            ...(statement === "chapters" ? { priority: 1, urgent: false, deadlineAt: null } : {}),
            ...(demand ? { priority: demand.priority, urgent: demand.urgent, deadlineAt: demand.deadlineAt, interval: demand, leadSeconds: demand.leadSeconds ?? 0 } : {}),
            ...(readPriority?.requestId ? { priority: readPriority.rank, urgent: readPriority.urgent === true,
              deadlineAt: Number.isFinite(readPriority.deadlineAt) ? readPriority.deadlineAt : Number.POSITIVE_INFINITY,
              scope: "preparation" } : {}),
            // Neither a viewer's interval nor an encode input asked for it: the
            // file read itself, and that read is wanted while the file is.
            ...(!demand && !readPriority?.requestId ? { owner: "file" } : {}) });
        }
        if (finished && result.kind === "result") {
          void maps.refresh(sourceKey, fileIndex).catch(error =>
            this.#warn(`download map source=${sourceKey} file=${fileIndex} metadata refresh failed: ${error?.message ?? error}`));
        }
      },
      portionBytes: file.portionBytes
    };
    return params;
  }

  #trackerFor(signal, sourceKey, fileIndex) {
    const trackerKey = `${sourceKey}:${fileIndex}`;
    let trackersForSignal = this.#trackers.get(signal);
    if (!trackersForSignal) this.#trackers.set(signal, trackersForSignal = new Map());
    let metadataTracker = trackersForSignal.get(trackerKey);
    if (!metadataTracker) {
      metadataTracker = { statements: new Set(), abort: null };
      const tracker = metadataTracker;
      tracker.abort = () => {
        for (const statement of tracker.statements) {
          void this.#maps.withdrawMetadata(sourceKey, fileIndex, statement).catch(error =>
            this.#warn(`encode input demand withdrawal failed: ${error.message}`));
        }
        tracker.statements.clear();
        trackersForSignal.delete(trackerKey);
        if (trackersForSignal.size === 0) this.#trackers.delete(signal);
      };
      trackersForSignal.set(trackerKey, tracker);
      if (signal.aborted) tracker.abort();
      else signal.addEventListener("abort", tracker.abort, { once: true });
    }
    return metadataTracker;
  }
}
