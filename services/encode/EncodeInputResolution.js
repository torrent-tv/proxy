/**
 * @file What an encoder run reads: the input of a piece's run and the sound's
 * packets walked from the picture's copy. Moved from the composition root
 * (torrent-tv/meta#275, step 5 of #270); every collaborator is a port, so this
 * file imports nothing.
 */

export class EncodeInputResolution {
  #paramsFor;
  #sourceRanges;
  #selectTracks;
  #readingInterval;
  #trackFor;
  #declaredTracks;
  #known;
  #outputs;
  #log;
  #warn;
  #now;

  /**
   * @param {object} ports
   * @param {(request: object) => Promise<object | null>} ports.paramsFor MediaReadParams#paramsFor
   * @param {object} ports.sourceRanges SegmentSourceRanges (tracksOf, shiftOf, navigable, readInput)
   * @param {Function} ports.selectTracks segment-reading
   * @param {Function} ports.readingInterval segment-reading
   * @param {Function} ports.trackFor segment-reading
   * @param {(sourceKey: string, fileIndex: number) => object[] | undefined} ports.declaredTracks
   * @param {(sourceKey: string, fileIndex: number) => object | null | undefined} ports.known
   * @param {() => Iterable<object>} ports.outputs the output catalog's values
   * @param {(line: string) => void} ports.log
   * @param {(line: string) => void} ports.warn
   * @param {() => number} [ports.now]
   */
  constructor({ paramsFor, sourceRanges, selectTracks, readingInterval, trackFor, declaredTracks, known, outputs, log, warn, now = Date.now }) {
    this.#paramsFor = paramsFor;
    this.#sourceRanges = sourceRanges;
    this.#selectTracks = selectTracks;
    this.#readingInterval = readingInterval;
    this.#trackFor = trackFor;
    this.#declaredTracks = declaredTracks;
    this.#known = known;
    this.#outputs = outputs;
    this.#log = log;
    this.#warn = warn;
    this.#now = now;
  }

  // `timing`, when given, is told how long each read of a file waited behind
  // the reads asked before it and how long it took (torrent-tv/meta#166).
  async resolve(output, fromIndex, toIndex, timing = null, isCurrent = null, signal = null, readPriority = null) {
    const grid = output.timeline?.published ?? output.timeline?.boundaries;
    const from = grid?.[fromIndex], to = grid?.[toIndex + 1];
    if (!Number.isFinite(from) || !(to > from)) return { kind: "terminal", reason: "output-interval-not-declared" };
    const selected = new Map();
    for (const type of ["video", "audio"]) {
      const spec = output.spec[type];
      if (!spec) continue;
      const list = selected.get(spec.fileIndex) ?? [];
      list.push({ type, index: type === "video" ? null : spec.trackIndex,
        mode: type === "video" ? spec.encode ? "transcode" : "copy" : spec.transcode ? "transcode" : "copy" });
      selected.set(spec.fileIndex, list);
    }
    // Every selected file is read the same way in one run: from the original
    // file when each container can name the bytes the interval needs, from
    // reassembled packets otherwise.
    const files = [];
    for (const [fileIndex, choices] of selected) {
      const params = await this.#paramsFor({ sourceKey: output.file.sourceKey, fileIndex,
        requestId: readPriority?.requestId, readPriority, signal });
      if (!params) return { kind: "needs-source" };
      if (isCurrent) params.isCurrent = isCurrent;
      if (signal) params.signal = signal;
      if (timing) {
        params.walkAccount = timing.walk ??= { lockMs: 0, reads: 0, bytes: 0 };
        params.onTimed = (statement, waitedMs, readMs) => {
          timing.reads += 1;
          timing.queuedMs += waitedMs;
          timing.readMs += readMs;
          const measured = timing.readsByStatement[statement] ??= { queuedMs: 0, readMs: 0 };
          measured.queuedMs += waitedMs;
          measured.readMs += readMs;
        };
      }
      const tracks = await this.#sourceRanges.tracksOf(params);
      if (tracks.kind !== "result") return tracks;
      const selection = this.#selectTracks(tracks.trackList, choices);
      if (!selection) return { kind: "terminal", reason: "selected-track-is-absent" };
      const { wanted, modes } = selection;
      const media = await this.#sourceRanges.shiftOf(params);
      if (media.kind !== "result") return media;
      const timeShiftSeconds = media.shift;
      const sourceInterval = output.timeline.sourceInterval(fromIndex, toIndex, timeShiftSeconds);
      params.packetInterval = this.#readingInterval(selection, sourceInterval);
      const navigation = await this.#sourceRanges.navigable(params);
      if (navigation.kind !== "result") return navigation;
      files.push({ fileIndex, choices, params, wanted, modes, timeShiftSeconds, sourceInterval, navigable: navigation.value });
    }
    const original = output.segmentFormat.supportsOriginalInput === true && files.every(file => file.navigable);
    const sources = [];
    for (const { fileIndex, choices, params, wanted, modes, timeShiftSeconds, sourceInterval } of files) {
      const read = await this.#sourceRanges.readInput(params, { original, tracks: wanted, modes, interval: sourceInterval });
      if (read.kind !== "result") return read.answer;
      if (original) {
        sources.push({ sourceKey: params.sourceKey, fileIndex, timeShiftSeconds,
          input: { ...read.input, original: true, selections: wanted.map(track => ({ track,
            index: track.declaredIndex ?? choices.find(choice => choice.type === track.type)?.index ?? 0 })) } });
        continue;
      }
      sources.push({ sourceKey: params.sourceKey, fileIndex, input: read.input, timeShiftSeconds });
    }
    return { kind: "result", sources };
  }

  // THE SOUND'S PACKETS FROM THE PICTURE'S COPY. A Matroska soundtrack is
  // fed to its encoder packet by packet, and finding its packets walks the
  // clusters the Cues name for the piece — picture and sound together,
  // about 20 MB for 0.3 MB of sound on the field's 1080p film. The picture's
  // input copies those same clusters through the torrent thread first, and
  // walked a second time there each soundtrack piece took 6-11 s, slower
  // than the film plays (r61, torrent-tv/meta#178). Walked from the copy
  // while it is held, the sound reads only its own packets later.
  stretchCopied(output, from, to, input) {
    for (const source of input.sources ?? []) {
      const container = this.#known(source.sourceKey, source.fileIndex);
      const tracks = this.#declaredTracks(source.sourceKey, source.fileIndex);
      if (typeof container?.learnPackets !== "function" || !Array.isArray(tracks)) continue;
      const carried = new Set((source.input.selections ?? []).map(selection => selection.track?.trackNumber));
      const sounds = new Set();
      for (const other of this.#outputs()) {
        const sound = other.spec?.audio;
        if (other.spec?.video || !sound || other.file?.sourceKey !== source.sourceKey || sound.fileIndex !== source.fileIndex) continue;
        const track = this.#trackFor(tracks, { type: "audio", index: sound.trackIndex });
        if (track && !carried.has(track.trackNumber)) sounds.add(track.trackNumber);
      }
      if (!sounds.size || !Number.isFinite(source.input.from) || !(source.input.to > source.input.from)) continue;
      const read = (start, end) => {
        const answer = input.read(source.fileIndex, start, end);
        return answer && typeof answer.then !== "function" && answer.end === end ? answer.bytes : null;
      };
      const holdsUntil = start => {
        if (input.heldUntil) return input.heldUntil(source.fileIndex, start);
        const range = source.input.ranges.find(([first, last]) => first <= start && start <= last);
        return range ? range[1] + 1 : null;
      };
      const startedAt = this.#now();
      const releaseInput = input.retain?.();
      void container.learnPackets({ from: source.input.from, to: source.input.to, trackIds: [...sounds] }, read, holdsUntil).then(learned =>
        this.#log(`encode input #${from}..#${to} of ${output.outputKey}: soundtrack packets of track(s) ${[...sounds].join(",")} ` +
          `over ${source.input.from.toFixed(3)}-${source.input.to.toFixed(3)}s ` +
          (learned === "walked" ? "walked" : `not all walked (${learned === "memory" ? "memory refused" : "the copy does not hold the rest"})`) +
          ` from its copy in ${this.#now() - startedAt}ms`),
      error => this.#warn(`encode input #${from}..#${to} of ${output.outputKey}: walking the soundtrack from its copy failed: ${error?.message ?? error}`))
        .finally(() => releaseInput?.());
    }
  }
}
