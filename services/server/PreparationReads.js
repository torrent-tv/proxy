/**
 * @file The reads a source preparation makes: its `inspect` port, and the
 * publication of the native source map that follows a read.
 *
 * Moved out of `server.js` verbatim (torrent-tv/meta#280): every free variable
 * is a port, and the preparation it reports to is passed with each call, since
 * it is built after this owner.
 */

export class PreparationReads {
  #paramsFor;
  #containers;
  #subtitles;
  #fileLengthOf;
  #viewersOf;
  #segmentSeconds;
  #preparationInterval;
  #segmentInputs;
  #nativeMaps;
  #maps;
  #record;
  #planEncodersSoon;

  /**
   * @param {object} ports
   * @param {(work: object) => Promise<object | null>} ports.paramsFor - MediaReadParams#paramsFor.
   * @param {{ inspect: Function, containerFor: Function }} ports.containers
   * @param {{ inspectFile: Function, inspectPackets: Function }} ports.subtitles
   * @param {(sourceKey: string, fileIndex: number) => number | undefined} ports.fileLengthOf
   * @param {(sourceKey: string) => object[]} ports.viewersOf - Viewers#forSource.
   * @param {number} ports.segmentSeconds
   * @param {(role: string, from: number, segmentSeconds: number) => object} ports.preparationInterval
   * @param {(input: { index: object, tracks: object[] }) => { forInterval: Function }} ports.segmentInputs
   * @param {{ packets: Function, original: Function }} ports.nativeMaps
   * @param {{ metadata: Function, native: Function }} ports.maps
   * @param {(params: object, statement: string, result: object, storage: unknown, memory: unknown) => boolean} ports.record
   * @param {() => void} ports.planEncodersSoon
   */
  constructor({ paramsFor, containers, subtitles, fileLengthOf, viewersOf, segmentSeconds, preparationInterval,
    segmentInputs, nativeMaps, maps, record, planEncodersSoon }) {
    this.#paramsFor = paramsFor;
    this.#containers = containers;
    this.#subtitles = subtitles;
    this.#fileLengthOf = fileLengthOf;
    this.#viewersOf = viewersOf;
    this.#segmentSeconds = segmentSeconds;
    this.#preparationInterval = preparationInterval;
    this.#segmentInputs = segmentInputs;
    this.#nativeMaps = nativeMaps;
    this.#maps = maps;
    this.#record = record;
    this.#planEncodersSoon = planEncodersSoon;
  }

  /**
   * The native source map of a work whose input has been read.
   *
   * @param {object} work
   * @param {object} preparation - `{ accepts, urgentReadyFor, ... }`, the source preparation.
   */
  async publishNative(work, preparation) {
    if (!work.nativeInput || !preparation.accepts(work)) return Promise.resolve();
    const watching = this.#viewersOf(work.sourceKey)
      .filter(viewer => viewer.source.selectedFileIndex === work.fileIndex && viewer.outputs.size === 0);
    const convert = work.nativeInput.container ? this.#nativeMaps.original : this.#nativeMaps.packets;
    const zones = await convert({ ...work.nativeInput, viewers: watching,
      allowanceSeconds: this.#segmentSeconds,
      urgentReadyFor: viewer => preparation.urgentReadyFor(viewer) });
    if (!preparation.accepts(work)) return;
    return this.#maps.native({ sourceKey: work.sourceKey, fileIndex: work.fileIndex, zones });
  }

  /**
   * Reads what the work asks for, and publishes what each read finds.
   *
   * @param {object} work
   * @param {object} preparation
   * @returns {Promise<object>} The answer the source preparation takes.
   */
  async inspect(work, preparation) {
    const params = await this.#paramsFor(work);
    if (!params) return { kind: "needs-source" };
    params.isCurrent = () => preparation.accepts(work);
    const originalContainer = work.statement === "packets" ? await this.#containers.containerFor(params) : null;
    const navigation = work.statement === "packets" && work.role !== "subtitle-embedded"
      ? await this.#containers.inspect(params, "source-navigation") : { kind: "result", value: false };
    if (navigation.kind !== "result") return navigation;
    const originalRanges = navigation.value;
    if (!originalRanges && work.statement === "packets" && work.role === "source-rest" && preparation.accepts(work)) {
      const length = this.#fileLengthOf(work.sourceKey, work.fileIndex);
      if (length > 0) {
        const statement = `${work.statement}:${work.requestId}:input`;
        await this.#maps.metadata({ sourceKey: work.sourceKey, fileIndex: work.fileIndex, statement,
          result: { kind: "needs-ranges", ranges: [[0, length - 1]], requestId: statement },
          scope: "preparation", ...preparation.demandFor(work) });
      }
    }
    if ((work.statement === "packets" && (work.role !== "source-rest" || originalRanges)) || work.role === "subtitle-embedded" && work.statement === "subtitle-cues") {
      const info = await this.#containers.inspect({ ...params, onReadResult: undefined }, "media-info");
      if (info.kind !== "result") return info;
      const positions = this.#viewersOf(work.sourceKey)
        .filter(viewer => viewer.source.selectedFileIndex === work.fileIndex &&
          (work.ownerId === undefined || viewer.id === work.ownerId))
        .map(viewer => viewer.positionSeconds() ?? 0);
      const from = (positions.length ? Math.min(...positions) : 0) + (Number(info.value?.startTimeSeconds) || 0);
      params.packetInterval = this.#preparationInterval(work.role, from, this.#segmentSeconds);
      if (work.role === "subtitle-embedded") {
        const tracks = await this.#containers.containerFor(params).then(container => container.readTracks());
        const track = tracks.find(track => track.type === "subtitle" && track.declaredIndex === work.trackIndex);
        if (!track || track.isTextBased?.() !== true) return { kind: "terminal", reason: "subtitle-track-not-supported" };
        params.packetInterval.trackIds = [track.trackNumber];
        params.subtitleTrackIndex = work.trackIndex;
      }
    }
    params.onReadResult = async (statement, result, revision) => {
      if (!preparation.accepts(work)) return;
      this.#record(params, statement, result, revision.storage, revision.memory);
      const inputStatement = `${work.statement}:${work.requestId}:input`;
      if (statement === "source-ranges" && result.kind === "result") {
        if (work.selected) work.inputRanges = result.value.ranges;
        if (work.role === "source-rest") {
          const info = await this.#containers.inspect({ ...params, onReadResult: undefined }, "media-info");
          if (!preparation.accepts(work)) return;
          if (info.kind === "result") {
            work.nativeInput = { container: originalContainer, durationSeconds: info.value.durationSeconds,
              startTimeSeconds: info.value.startTimeSeconds ?? 0 };
            await this.publishNative(work, preparation);
          }
        } else {
          await this.#maps.metadata({ sourceKey: work.sourceKey, fileIndex: work.fileIndex,
            statement: inputStatement, result: { kind: "needs-ranges", ranges: result.value.ranges, requestId: inputStatement },
            scope: "preparation", ...preparation.demandFor(work) });
          if (work.selected) await preparation.bytesChanged(work.sourceKey, work.fileIndex);
        }
      }
      if (statement === "packets" && work.role === "source-rest" && result.kind === "result") {
        const tracks = await this.#containers.containerFor(params).then(container => container.readTracks());
        const info = await this.#containers.inspect({ ...params, onReadResult: undefined }, "media-info");
        if (!preparation.accepts(work)) return;
        if (info.kind === "result") {
          work.nativeInput = { index: result.value, tracks, durationSeconds: info.value.durationSeconds,
            startTimeSeconds: info.value.startTimeSeconds ?? 0 };
          await this.publishNative(work, preparation);
        }
      }
      if (statement === "packets" && work.role !== "source-rest" && result.kind === "result" && (work.selected || work.ownerFileIndex !== undefined)) {
        const tracks = await this.#containers.containerFor(params).then(container => container.readTracks());
        if (!preparation.accepts(work)) return;
        const bounds = tracks.filter(track => ["video", "audio"].includes(track.type))
          .map(track => result.value.boundsOf(track.trackNumber)).filter(Boolean);
        const interval = params.packetInterval ?? (bounds.length ? {
          from: Math.max(0, Math.min(...bounds.map(bound => bound.start))), to: Math.max(...bounds.map(bound => bound.end))
        } : null);
        if (interval && interval.to > interval.from) {
          const input = work.role === "subtitle-embedded"
            ? result.value.inputFor({ trackId: params.packetInterval.trackIds[0], ...interval })
            : this.#segmentInputs({ index: result.value, tracks }).forInterval(interval);
          if (work.selected) work.inputRanges = input.kind === "result" ? input.ranges : null;
          await this.#maps.metadata({ sourceKey: work.sourceKey, fileIndex: work.fileIndex,
            statement: inputStatement, result: input.kind === "result" ? { kind: "needs-ranges", ranges: input.ranges, requestId: inputStatement } : input,
            scope: "preparation", ...preparation.demandFor(work) });
          if (work.selected) await preparation.bytesChanged(work.sourceKey, work.fileIndex);
        }
      }
      if (!preparation.accepts(work)) return;
      await this.#maps.metadata({ sourceKey: work.sourceKey, fileIndex: work.fileIndex,
        statement: `${work.statement}:${work.requestId}`, result, scope: "preparation", ...preparation.demandFor(work) });
      preparation.result(work, result);
      if (["subtitle-file", "subtitle-cues"].includes(statement)) this.#planEncodersSoon();
    };
    return work.statement === "subtitle-file"
      ? this.#subtitles.inspectFile(params) : work.statement === "subtitle-cues"
        ? this.#subtitles.inspectPackets(params) : this.#containers.inspect(params, originalRanges ? "source-ranges" : work.statement);
  }
}
