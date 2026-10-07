/** Source preparation is derived from viewers before any output exists. */
export class SourcePreparation {
  #viewers;
  #candidates;
  #related;
  #priorityFor;
  #inspect;
  #withdraw;
  #failed;
  #reprice;
  #inputReady;
  #readyChanged;
  #work = new Map();
  #revision = 0;
  #completedRevision = null;
  #pending = null;
  #candidateAbort = new AbortController();

  constructor({ viewers, candidatesFor, relatedFilesFor = () => [], priorityFor = (_viewer, priority) => priority,
    inputReady = async () => false, readyChanged = () => {}, inspect, withdraw, reprice = () => {}, failed }) {
    this.#viewers = viewers;
    this.#candidates = candidatesFor;
    this.#related = relatedFilesFor;
    this.#priorityFor = priorityFor;
    this.#inspect = inspect;
    this.#withdraw = withdraw;
    this.#failed = failed;
    this.#reprice = reprice;
    this.#inputReady = inputReady;
    this.#readyChanged = readyChanged;
  }

  refresh() {
    this.#revision++;
    this.#candidateAbort.abort();
    this.#candidateAbort = new AbortController();
    for (const [key, work] of this.#work) {
      const demand = this.demandFor(work);
      if (demand) { this.#reprice(work, demand); continue; }
      this.#work.delete(key);
      this.#withdraw(work);
    }
    if (!this.#pending) {
      let succeeded = false;
      this.#pending = this.#run().then(() => { succeeded = true; }).catch(error => this.#failed?.(error)).finally(() => {
        this.#pending = null;
        if (succeeded && this.#completedRevision !== this.#revision) void this.refresh();
      });
    }
    return this.#pending;
  }

  /** Current owners determine priority; old work never restores a withdrawn read. */
  demandFor(work) {
    if (work.selected && work.statement === "packets" &&
      work.positions !== this.#positionsFor(work.sourceKey, work.fileIndex, work.ownerId)) return null;
    if (work.role === "subtitle-embedded" && ["packets", "subtitle-cues"].includes(work.statement) &&
      work.positions !== this.#positionsFor(work.sourceKey, work.fileIndex, work.ownerId, true)) return null;
    const owners = this.#viewers.forSource(work.sourceKey).filter(viewer => {
      if (work.ownerId !== undefined && viewer.id !== work.ownerId) return false;
      if (work.role === "subtitle-embedded" && (viewer.subtitle?.fileIndex !== work.fileIndex ||
        viewer.subtitle.trackIndex !== work.trackIndex)) return false;
      const selected = viewer.source.selectedFileIndex;
      if (work.ownerFileIndex !== undefined) return selected === work.ownerFileIndex &&
        (work.role !== "source-rest" || viewer.outputs.size === 0);
      if (work.statement !== "packets") return selected === null || selected === work.fileIndex;
      if (selected !== null) return selected === work.fileIndex && viewer.outputs.size === 0 && work.selected;
      return !work.selected && viewer.source.visibleFileIndices.includes(work.fileIndex);
    });
    if (!owners.length) return null;
    const selected = work.ownerFileIndex === undefined && owners.some(viewer => viewer.source.selectedFileIndex !== null);
    const base = work.role === "source-rest" ? 1 : work.role === "next-episode" ? 5 : work.ownerFileIndex !== undefined ? 10 : 100;
    const demands = owners.map(viewer => {
      const chosenSubtitle = ["subtitle", "subtitle-embedded"].includes(work.role) && viewer.subtitle?.fileIndex === work.fileIndex;
      const ownBase = chosenSubtitle ? 100 : base;
      const priority = this.#priorityFor(viewer, ownBase, work);
      return { priority, urgent: (selected || chosenSubtitle) && priority === ownBase };
    });
    const priority = Math.max(...demands.map(demand => demand.priority));
    const urgent = demands.some(demand => demand.urgent);
    return { priority,
      urgent, deadlineAt: urgent ? 0 : Infinity, order: work.order ?? 0 };
  }

  accepts(work) { return this.#work.get(work.key) === work && this.demandFor(work) !== null; }

  /** A retired torrent cannot retain completed preparation or accept late reads. */
  forget(sourceKey) {
    this.#revision++;
    this.#candidateAbort.abort();
    this.#candidateAbort = new AbortController();
    for (const [key, work] of this.#work) {
      if (work.sourceKey !== sourceKey) continue;
      this.#work.delete(key);
      this.#withdraw(work);
    }
  }

  urgentReadyFor(viewer) {
    if (!this.subtitleReadyFor(viewer)) return false;
    return [...this.#work.values()].some(work => work.selected && work.ownerId === viewer.id &&
      work.urgentReady === true && viewer.source?.sourceKey === work.sourceKey &&
      viewer.source.selectedFileIndex === work.fileIndex && viewer.outputs.size === 0 &&
      work.positions === this.#positionsFor(work.sourceKey, work.fileIndex, viewer.id));
  }

  /**
   * Whether the subtitle this viewer chose has been read where they stand.
   *
   * Playback readiness waits on this (`subtitle-readiness.js`), so every way
   * the read can END must answer it, and a refusal is one of them. The cues
   * are the last of four reads — the track table, the media info, the packet
   * index, then the cues — and a refusal at an earlier step means the later
   * ones are never asked. Counting only the cues' own answer left a track the
   * proxy cannot read waiting for ever.
   */
  subtitleReadyFor(viewer) {
    const selection = viewer.subtitle;
    if (!selection) return true;
    const positions = () => this.#positionsFor(selection.sourceKey, selection.fileIndex, viewer.id, true);
    return [...this.#work.values()].some(work => work.sourceKey === selection.sourceKey &&
      work.fileIndex === selection.fileIndex && ["result", "terminal"].includes(work.result) &&
      (selection.trackIndex === null ? work.statement === "subtitle-file" && work.ownerFileIndex === viewer.source.selectedFileIndex
        : work.role === "subtitle-embedded" && work.ownerId === viewer.id && work.trackIndex === selection.trackIndex &&
          (work.positions === undefined || work.positions === positions()) &&
          (work.statement === "subtitle-cues" || work.result === "terminal")));
  }

  async bytesChanged(sourceKey, fileIndex) {
    let changed = false;
    for (const work of this.#work.values()) {
      if (!work.selected || work.sourceKey !== sourceKey || work.fileIndex !== fileIndex || !work.inputRanges) continue;
      const revision = work.readinessRevision = (work.readinessRevision ?? 0) + 1;
      const ready = await this.#inputReady(work);
      if (revision !== work.readinessRevision || !this.accepts(work)) continue;
      if (work.urgentReady !== ready) {
        work.urgentReady = ready;
        changed = true;
        this.#readyChanged(work, ready);
      }
    }
    if (changed) for (const work of this.#work.values()) {
      const demand = this.demandFor(work);
      if (demand) this.#reprice(work, demand);
    }
  }

  ownsFile(sourceKey, fileIndex) {
    return [...this.#work.values()].some(work => work.sourceKey === sourceKey &&
      work.fileIndex === fileIndex && this.demandFor(work));
  }

  #positionsFor(sourceKey, fileIndex, ownerId, includeOutputs = false) {
    return JSON.stringify(this.#viewers.forSource(sourceKey)
      .filter(viewer => viewer.source.selectedFileIndex === fileIndex && (includeOutputs || viewer.outputs.size === 0) &&
        (ownerId === undefined || viewer.id === ownerId))
      .map(viewer => [viewer.id, viewer.position?.seconds ?? 0]).sort((left, right) => left[0].localeCompare(right[0])));
  }

  result(work, result) {
    const current = this.#work.get(work.key);
    if (current !== work || !this.demandFor(work)) return;
    current.result = result.kind;
    if (!["needs-ranges", "needs-memory"].includes(result.kind)) void this.refresh();
  }

  async #run() {
    let revision;
    do {
      revision = this.#revision;
      for (const sourceKey of this.#viewers.sourceKeys()) {
        let candidates;
        try { candidates = await this.#availableCandidates(sourceKey, this.#candidateAbort.signal); }
        catch (error) {
          if (error?.name === "AbortError") break;
          throw error;
        }
        if (revision !== this.#revision) break;
        const people = this.#viewers.forSource(sourceKey);
        const selected = people.map(viewer => viewer.source.selectedFileIndex).filter(index => index !== null);
        const files = [...new Set([...candidates, ...selected])];
        const related = [...new Set(selected)].flatMap(ownerFileIndex =>
          this.#related(sourceKey, ownerFileIndex).map(file => ({ ...file, ownerFileIndex })));
        for (const viewer of people) {
          if (viewer.subtitle?.trackIndex !== null && viewer.subtitle?.trackIndex !== undefined &&
            viewer.subtitle.fileIndex === viewer.source.selectedFileIndex) {
            related.push({ fileIndex: viewer.subtitle.fileIndex, ownerFileIndex: viewer.source.selectedFileIndex,
              ownerId: viewer.id, trackIndex: viewer.subtitle.trackIndex, role: "subtitle-embedded" });
          }
        }
        for (const [key, work] of this.#work) {
          if (work.sourceKey === sourceKey && !files.includes(work.fileIndex) &&
            !related.some(file => file.fileIndex === work.fileIndex && file.ownerFileIndex === work.ownerFileIndex)) {
            this.#work.delete(key);
            this.#withdraw(work);
          }
        }
        const metadata = [];
        for (const [order, fileIndex] of files.entries()) {
          for (const statement of ["tracks", "media-info"]) {
            if (revision !== this.#revision) break;
            const work = this.#request({ sourceKey, fileIndex, statement, order });
            if (!this.demandFor(work)) continue;
            metadata.push(work);
            await this.#read(work);
          }
        }
        if (revision !== this.#revision || metadata.some(work => !["result", "terminal"].includes(work.result))) continue;
        for (const [order, fileIndex] of files.entries()) {
          if (revision !== this.#revision) break;
          const selections = [{ selected: false }, ...people
            .filter(viewer => viewer.source.selectedFileIndex === fileIndex && viewer.outputs.size === 0)
            .map(viewer => ({ selected: true, ownerId: viewer.id }))];
          for (const selection of selections) {
            const work = this.#request({ sourceKey, fileIndex, statement: "packets", ...selection, order });
            if (this.demandFor(work)) await this.#read(work);
          }
        }
        for (const [order, file] of related.entries()) {
          if (revision !== this.#revision) break;
          if (file.role === "subtitle") {
            await this.#read(this.#request({ sourceKey, ...file, statement: "subtitle-file", order: files.length + order }));
            continue;
          }
          const declarations = [];
          for (const statement of ["tracks", "media-info"]) {
            const work = this.#request({ sourceKey, ...file, statement, order: files.length + order });
            declarations.push(work);
            await this.#read(work);
          }
          if (declarations.some(work => work.result !== "result")) continue;
          const packets = this.#request({ sourceKey, ...file, statement: "packets", order: files.length + order });
          await this.#read(packets);
          if (file.role === "subtitle-embedded" && packets.result === "result") {
            await this.#read(this.#request({ sourceKey, ...file, statement: "subtitle-cues", order: files.length + order }));
          }
        }
      }
    } while (revision !== this.#revision);
    this.#completedRevision = revision;
  }

  #request(address) {
    if (address.selected && address.statement === "packets") {
      address = { ...address, positions: this.#positionsFor(address.sourceKey, address.fileIndex, address.ownerId) };
    }
    if (address.role === "subtitle-embedded" && ["packets", "subtitle-cues"].includes(address.statement)) {
      address = { ...address, positions: this.#positionsFor(address.sourceKey, address.fileIndex, address.ownerId, true) };
    }
    const key = JSON.stringify([address.sourceKey, address.fileIndex, address.statement, address.selected ?? null,
      address.ownerFileIndex ?? null, address.role ?? null, address.positions ?? null, address.ownerId ?? null, address.trackIndex ?? null]);
    let work = this.#work.get(key);
    if (work && work.order !== address.order) {
      work.order = address.order;
      const demand = this.demandFor(work);
      if (demand) this.#reprice(work, demand);
    }
    if (!work) {
      work = { ...address, key, requestId: `prepare:${key}`, result: null };
      if (this.demandFor(work)) this.#work.set(key, work);
    }
    return work;
  }

  #availableCandidates(sourceKey, signal) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error, value) => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", aborted);
        if (error) reject(error); else resolve(value);
      };
      const aborted = () => finish(new DOMException("Source preparation was cancelled.", "AbortError"));
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) { aborted(); return; }
      Promise.resolve().then(() => {
        if (signal.aborted) throw new DOMException("Source preparation was cancelled.", "AbortError");
        return this.#candidates(sourceKey);
      }).then(value => finish(null, value), error => finish(error));
    });
  }

  async #read(work) {
    if (work.result !== null || !this.demandFor(work)) return;
    const result = await this.#inspect(work);
    if (this.#work.get(work.key) === work && this.demandFor(work)) work.result = result.kind;
    if (work.selected && work.inputRanges) await this.bytesChanged(work.sourceKey, work.fileIndex);
  }
}
