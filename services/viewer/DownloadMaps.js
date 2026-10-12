/**
 * How often what the publications of one file cost is said, at most: the
 * cadence of the proxy's other once-a-minute readings.
 */
const REPORT_EVERY_MS = 60_000;

/** One published download map per file, including download-only metadata reads. */
export class DownloadMaps {
  #files = new Map();
  #publish;
  #resolvePlayback;
  #nextEpoch = 0;
  #log;
  #now;
  /**
   * Milliseconds on the clock both threads read the same way, to the
   * microsecond: what a publication's stages are measured with, the torrent
   * thread's receipt included (torrent-tv/meta#177).
   */
  #clock;

  constructor({ publish, resolvePlayback = async map => map.zones, log = null, now = Date.now,
    clock = () => performance.timeOrigin + performance.now() }) {
    if (typeof publish !== "function") throw new TypeError("Download map publication is required.");
    this.#publish = publish;
    this.#resolvePlayback = resolvePlayback;
    this.#log = typeof log === "function" ? log : null;
    this.#now = now;
    this.#clock = clock;
  }

  async playback({ sourceKey, fileIndex, durationSeconds, zones }) {
    const file = this.#file(sourceKey, fileIndex);
    file.durationSeconds = durationSeconds;
    const revision = ++file.revision;
    const now = Date.now();
    file.sourceZones = zones.map(zone => Number.isFinite(zone.deadlineAt) || !Number.isFinite(zone.withinSeconds)
      ? zone : { ...zone, deadlineAt: now + Math.max(0, zone.withinSeconds) * 1000 });
    let changed = false;
    // Until the new zones are resolved to bytes, a resolved zone stays while
    // the film it covers is still wanted. A viewer moving on re-cuts every zone
    // without making its film unwanted; dropping the zones that lost their
    // exact interval published an empty map every few seconds of playback,
    // which let the swarm go and emptied the encoder's resolved input (Home
    // Assistant 2026-10-07, torrent-tv/meta#95). A zone no new zone overlaps —
    // a seek away — is withdrawn at once.
    const retained = file.zones.flatMap(zone => {
      const interval = zone.downloadInterval ?? zone;
      const current = file.sourceZones.find(candidate => candidate.from === interval.from && candidate.to === interval.to);
      if (!current) {
        const stillWanted = file.sourceZones.some(candidate => candidate.from < interval.to && interval.from < candidate.to);
        if (!stillWanted) changed = true;
        return stillWanted ? [zone] : [];
      }
      const deadlineAt = Number.isFinite(current.deadlineAt)
        ? current.deadlineAt + (Math.max(0, zone.from - current.from) - (zone.leadSeconds ?? 0)) * 1000 : current.deadlineAt;
      if (Object.keys(current).some(key => key !== "from" && key !== "to" && !Object.is(zone[key], key === "deadlineAt" ? deadlineAt : current[key]))) changed = true;
      return [{ ...zone, ...current, from: zone.from, to: zone.to, deadlineAt }];
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
    const isCurrent = () => this.#files.get(`${sourceKey}:${fileIndex}`) === file && revision === file.revision;
    // WHAT IS RESOLVED IS STATED WHILE THE REST IS STILL BEING RESOLVED. A pass
    // works the zones out in the order the swarm is to fetch them, and
    // published only at its end it kept the first bytes from the swarm for as
    // long as the far end of the film took: 14.6 s on a cold two-hour AVI, the
    // swarm fetching nothing for 17.5 s while the encoder waited for its next
    // piece (Home Assistant 2026-10-12, torrent-tv/meta#178). The swarm
    // fetches the highest group still missing, so before the pass works out a
    // zone of a lower priority than any before it, what it has resolved is
    // published, with the zones still retained for what it has not reached. A
    // pass that works nothing out — every pass over a film already worked out
    // — states nothing early.
    let stated = Number.POSITIVE_INFINITY;
    const workingOut = (priority, zones) => {
      if (!(priority < stated)) return;
      stated = priority;
      if (zones.length === 0 || !isCurrent()) return;
      this.#setZones(file, withRetained(zones, retained));
      this.#emit(file).catch(() => undefined);
    };
    const resolved = await this.#resolvePlayback({ sourceKey, fileIndex, durationSeconds, zones: file.sourceZones,
      isCurrent, workingOut });
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
      const entry = { ranges: result.ranges, requestId: result.requestId, priority, urgent, deadlineAt, interval, leadSeconds, scope, order };
      const previous = file.metadata.get(statement);
      if (previous && sameMetadata(previous, entry) && this.#standing(file)) return this.#unchanged(file);
      file.metadata.set(statement, entry);
    } else if (result.kind === "needs-memory") {
      // Allocation refusal says nothing about whether previously missing
      // source bytes have arrived. Keep their demand until the read resolves —
      // and since it changes nothing in the map, nothing is built for it: the
      // sound packet table of a two-hour AVI was refused once per soundtrack
      // segment, 1943 times in 8.3 s, each a build and sort of every zone of
      // the file (torrent-tv/meta#178).
      if (this.#standing(file)) return this.#unchanged(file);
    } else if (!file.metadata.delete(statement) && this.#standing(file)) {
      return this.#unchanged(file);
    }
    return this.#emit(file);
  }

  /**
   * Whether the map last built for this file still stands, so a statement that
   * changes nothing needs no new one: nothing `#emit` reads has changed since
   * it ran (`dirty`), and the publication it made was not refused — `#emit`
   * forgets the shape when the torrent thread did not apply the map or the
   * publication failed, and that is what makes the next statement, changed or
   * not, send it again.
   */
  #standing(file) {
    return !file.dirty && Boolean(file.shape);
  }

  #unchanged(file) {
    this.#statsOf(file).skipped += 1;
    this.#report(file);
    return Promise.resolve();
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
      file = { sourceKey, fileIndex, durationSeconds: 0, zones: [], inputs: new Map(), nativeZones: [], sourceZones: [], revision: 0, epoch: ++this.#nextEpoch, metadata: new Map(), pending: Promise.resolve(), dirty: true };
      this.#files.set(key, file);
    }
    return file;
  }

  #setZones(file, zones) {
    file.zones = zones;
    // What `#emit` reads has changed, whether or not it is published now.
    file.dirty = true;
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
    file.dirty = false;
    const builtFrom = this.#clock();
    const zones = [...file.zones, ...file.nativeZones];
    for (const { ranges, requestId, priority, urgent, deadlineAt, order } of file.metadata.values()) {
      for (const [byteStart, byteEnd] of ranges) {
        zones.push({ byteStart, byteEnd, priority, urgent, downloadOnly: true, requestId, deadlineAt, ...(order ? { order } : {}) });
      }
    }
    const publication = { sourceKey: file.sourceKey, fileIndex: file.fileIndex, durationSeconds: file.durationSeconds, zones };
    // SENT ONLY WHEN THE TORRENT WOULD ACT ON IT DIFFERENTLY: other bytes,
    // another level or order of claim, or deadlines in another order. A map was
    // sent after every read of the file's statements, changed or not, and the
    // read waited for it: field 2026-10-10, 48-64 such reads per stretch of a
    // two-hour AVI, 28-54 s before its copy began, with 5-12 thousand zones in
    // each map (torrent-tv/meta#166). A deadline worked out again on a later
    // clock moves every zone of a viewer playing on by the same amount and
    // orders nothing differently, so the deadlines' order is compared and not
    // their values.
    const shape = shapeOf(publication);
    // WHAT A PUBLICATION COSTS, stage by stage (torrent-tv/meta#177): building
    // and comparing it here, every time something is stated, sent or not;
    // waiting behind the previous one; the synchronous post, which drops the
    // zones repeated for the torrent and copies the rest for the other thread;
    // from the post to the torrent thread's
    // handler, which holds the transfer and that thread's queue together; and
    // applying it there. A cold minute of #166 run 12 built 10 408 maps and
    // sent 439, and nothing said what that cost.
    const builtMs = this.#clock() - builtFrom;
    if (file.shape && sameShape(file.shape, shape)) {
      const stats = this.#statsOf(file);
      stats.unchanged += 1;
      stats.unsentBuildMs += builtMs;
      this.#report(file);
      return Promise.resolve();
    }
    file.shape = shape;
    const askedAt = this.#clock();
    const pending = file.pending.then(() => {
      if (this.#files.get(`${file.sourceKey}:${file.fileIndex}`) !== file) return undefined;
      const sentAt = this.#now();
      const postedAt = this.#clock();
      const sent = this.#publish({ ...publication, postedAt });
      const postMs = this.#clock() - postedAt;
      return Promise.resolve(sent).then(reply => {
        const answeredAt = this.#clock();
        // A torrent not yet in the thread applies nothing, so this map was not
        // delivered and the next one, however alike, has to be.
        if (reply?.appliedMs === null && file.shape === shape) file.shape = null;
        // The window open now, which a report since this map was asked for may have started.
        const stats = this.#statsOf(file);
        stats.sent += 1;
        stats.zones.push(zones.length);
        stats.deliveredMs.push(this.#now() - sentAt);
        stats.sentBuildMs.push(builtMs);
        stats.waitedMs.push(postedAt - askedAt);
        stats.postMs.push(postMs);
        if (Number.isFinite(reply?.receivedAt)) stats.toHandlerMs.push(Math.max(0, reply.receivedAt - postedAt - postMs));
        if (Number.isFinite(reply?.repliedAt)) stats.replyMs.push(Math.max(0, answeredAt - reply.repliedAt));
        if (Number.isFinite(reply?.appliedMs)) stats.appliedMs.push(reply.appliedMs);
        this.#report(file);
        return reply;
      });
    });
    // A failed publication must not prevent the next state change from being
    // sent, and leaves nothing to compare the next one against.
    file.pending = pending.catch(() => {
      if (file.shape === shape) file.shape = null;
    });
    return pending;
  }

  #statsOf(file) {
    file.stats ??= emptyStats(this.#now());
    return file.stats;
  }

  /** What this file's publications cost, said once a minute at most and only when one was asked for. */
  #report(file) {
    const stats = file.stats;
    const now = this.#now();
    if (!this.#log || !stats || now - stats.since < REPORT_EVERY_MS) return;
    const total = values => Math.round(values.reduce((sum, value) => sum + value, 0));
    this.#log(`download map ${file.sourceKey.slice(0, 48)}:${file.fileIndex}: ${stats.sent} sent and ` +
      `${stats.unchanged} unchanged not sent in ${((now - stats.since) / 1000).toFixed(1)}s; ` +
      `zones median ${middle(stats.zones)} max ${largest(stats.zones)}; ` +
      `delivered median ${middle(stats.deliveredMs)}ms max ${largest(stats.deliveredMs)}ms (${total(stats.deliveredMs)}ms in all), ` +
      `applied in the torrent thread median ${middle(stats.appliedMs)}ms max ${largest(stats.appliedMs)}ms ` +
      `(${total(stats.appliedMs)}ms in all); ` +
      `stages of a sent map — built ${stage(stats.sentBuildMs)}, waited behind the previous ${stage(stats.waitedMs)}, ` +
      `posted ${stage(stats.postMs)}, post to the torrent thread's handler ${stage(stats.toHandlerMs)}, ` +
      `reply back ${stage(stats.replyMs)}; maps built and not sent took ${total([stats.unsentBuildMs])}ms here; ` +
      `${stats.skipped} statement(s) changed nothing and built no map`);
    file.stats = emptyStats(now);
  }
}

/**
 * Zones resolved so far, with the retained zones of every segment they do not
 * yet resolve again: a segment's bytes are stated once, by its newest reading.
 */
function withRetained(resolved, retained) {
  const keyOf = zone => typeof zone.outputKey === "string" && Number.isSafeInteger(zone.index) ? `${zone.outputKey}:${zone.index}` : null;
  const resolvedKeys = new Set(resolved.map(keyOf).filter(key => key !== null));
  return [...resolved, ...retained.filter(zone => {
    const key = keyOf(zone);
    return key === null || !resolvedKeys.has(key);
  })];
}

/** @param {number} since */
function emptyStats(since) {
  return { since, sent: 0, unchanged: 0, zones: [], deliveredMs: [], appliedMs: [],
    sentBuildMs: [], waitedMs: [], postMs: [], toHandlerMs: [], replyMs: [], unsentBuildMs: 0, skipped: 0 };
}

/** One stage's median, largest and sum, in milliseconds with tenths. @param {number[]} values */
function stage(values) {
  if (values.length === 0) return "n/a";
  const sorted = [...values].sort((left, right) => left - right);
  const sum = values.reduce((total, value) => total + value, 0);
  return `median ${sorted[Math.floor(sorted.length / 2)].toFixed(1)}ms max ${sorted.at(-1).toFixed(1)}ms sum ${Math.round(sum)}ms`;
}

/**
 * Whether two metadata demands are the same demand: every field, the byte
 * ranges and the interval by value. The fields that do not reach the
 * publication — the interval, the preparation time, the scope — decide how the
 * demand is repriced and withdrawn later, so a change of them is a change.
 */
function sameMetadata(left, right) {
  return left.requestId === right.requestId && Object.is(left.priority, right.priority) &&
    left.urgent === right.urgent && Object.is(left.deadlineAt, right.deadlineAt) &&
    Object.is(left.leadSeconds, right.leadSeconds) && left.scope === right.scope && left.order === right.order &&
    (left.interval?.from ?? null) === (right.interval?.from ?? null) &&
    (left.interval?.to ?? null) === (right.interval?.to ?? null) &&
    left.ranges.length === right.ranges.length &&
    left.ranges.every(([start, end], index) => start === right.ranges[index][0] && end === right.ranges[index][1]);
}

/** How many numbers describe one zone's part in what the torrent does. */
const ZONE_FIELDS = 7;

/** @param {boolean | undefined} value */
function flag(value) {
  return value === true ? 2 : value === false ? 1 : 0;
}

/** @param {{ deadlineAt?: number }} zone */
function deadlineOf(zone) {
  return Number.isFinite(zone.deadlineAt) ? zone.deadlineAt : Number.POSITIVE_INFINITY;
}

/**
 * What the torrent acts on in a publication, packed for comparison: each
 * zone's bytes, priority, words of level, order of claim, and the RANK of its
 * deadline among the map's zones rather than the deadline itself. A zone with
 * no deadline carries the time it is wanted within, which the torrent turns
 * into a deadline on its own clock when the map is applied.
 *
 * @param {{ durationSeconds: number, zones: object[] }} publication
 * @returns {{ durationSeconds: number, fields: Float64Array }}
 */
function shapeOf({ durationSeconds, zones }) {
  const byDeadline = zones.map((_zone, index) => index).sort((left, right) => {
    const first = deadlineOf(zones[left]);
    const second = deadlineOf(zones[right]);
    return first === second ? left - right : first < second ? -1 : 1;
  });
  const fields = new Float64Array(zones.length * ZONE_FIELDS);
  byDeadline.forEach((index, rank) => {
    fields[index * ZONE_FIELDS + 5] = rank;
  });
  zones.forEach((zone, index) => {
    const at = index * ZONE_FIELDS;
    fields[at] = Number.isFinite(zone.byteStart) ? zone.byteStart : -1;
    fields[at + 1] = Number.isFinite(zone.byteEnd) ? zone.byteEnd : -1;
    fields[at + 2] = Number.isFinite(zone.priority) ? zone.priority : -1;
    fields[at + 3] = flag(zone.urgent) * 27 + flag(zone.deferred) * 9 + flag(zone.behind) * 3 + flag(zone.downloadOnly);
    fields[at + 4] = Number.isSafeInteger(zone.order) ? zone.order : 0;
    fields[at + 6] = Number.isFinite(zone.deadlineAt) ? -2 : Number.isFinite(zone.withinSeconds) ? zone.withinSeconds : -1;
  });
  return { durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : -1, fields };
}

/** @param {{ durationSeconds: number, fields: Float64Array }} left @param {{ durationSeconds: number, fields: Float64Array }} right */
function sameShape(left, right) {
  if (left.durationSeconds !== right.durationSeconds || left.fields.length !== right.fields.length) return false;
  for (let index = 0; index < left.fields.length; index++) {
    if (left.fields[index] !== right.fields[index]) return false;
  }
  return true;
}

/** @param {number[]} values */
function middle(values) {
  if (values.length === 0) return "n/a";
  const sorted = [...values].sort((left, right) => left - right);
  return Math.round(sorted[Math.floor(sorted.length / 2)]);
}

/** @param {number[]} values */
function largest(values) {
  return values.length === 0 ? "n/a" : Math.round(Math.max(...values));
}
