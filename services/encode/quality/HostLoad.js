/**
 * What the proxy's own work costs this host, read while it runs.
 *
 * The torrent thread's processor per megabyte it downloads, the share of the
 * machine this process draws doing nothing priced, how fast each watched torrent is moving, the speed
 * each file's supply demands, how long each file is, and how much of the machine
 * a new encoder could have. The encoders' own cost is `EncodeCost`'s.
 */

import os from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { logger } from "../../../utils/logger.js";
import { availableShareFrom } from "../available-share.js";
import { encoderCpuBetween } from "./encoder-cpu.js";
import { baseDrawFrom, costPerMegabyteFrom } from "../torrent-cost.js";
import { medianOf, movedBeyondScatter, READINGS_KEPT, scatterOf } from "../learned-median.js";
import { ENCODE_RUN_STATE, processCanBeSignalled } from "../encode-run-state.js";
import { SourceFiles } from "../../media/SourceFile.js";
import { costKindForSession } from "./EncodeCost.js";

/**
 * What the torrent thread says of itself over one interval: how late its event
 * loop ran, and how long reads for readers took inside it, from a command's
 * arrival to its answer (torrent-tv/meta#178). Empty where it says nothing.
 *
 * @param {{ readerMs: number | null, readerReads: number | null, loopP99Ms: number | null, loopMaxMs: number | null }} now
 * @param {{ readerMs: number | null, readerReads: number | null }} previous
 * @returns {string}
 */
function threadSays(now, previous) {
  const loop = Number.isFinite(now.loopP99Ms) && Number.isFinite(now.loopMaxMs)
    ? `; its loop late p99=${Math.round(now.loopP99Ms)}ms max=${Math.round(now.loopMaxMs)}ms` : "";
  const reads = Number.isFinite(now.readerReads) && Number.isFinite(previous.readerReads) && now.readerReads > previous.readerReads
    && Number.isFinite(now.readerMs) && Number.isFinite(previous.readerMs)
    ? `; ${now.readerReads - previous.readerReads} read(s) for readers took ${Math.round(now.readerMs - previous.readerMs)}ms in it` : "";
  // Whether our own selection held the swarm back over the interval, and what
  // it gave in the time it did not (`SelectionLimit`, torrent-tv/meta#178).
  const ms = (now.selection?.ms ?? 0) - (previous.selection?.ms ?? 0);
  const freeMs = (now.selection?.freeMs ?? 0) - (previous.selection?.freeMs ?? 0);
  const freeBytes = (now.selection?.freeBytes ?? 0) - (previous.selection?.freeBytes ?? 0);
  const held = ms > 0 && freeMs >= 0 && freeMs <= ms
    ? `; our selection held a peer back ${Math.round((1 - freeMs / ms) * 100)}% of the time` +
      (freeMs > 0 ? `, the rest gave ${(freeBytes / freeMs / 1000).toFixed(2)} MB/s` : "") : "";
  return loop + reads + held;
}

export class HostLoad {
  /** What this reads and asks of the rest of the proxy, and nothing else. @type {object} */
  #host;

  /**
   * How much of the machine a new encoder could have, from the LAST reading;
   * undefined before one, and `known: false` whenever the last reading was
   * missing or was not a share of the machine. It is never older than the
   * reading that made it: every pass either replaces it or says unknown.
   */
  hostAvailability;

  /** The previous reading of the machine, to compare the next one against. */
  #hostLoadSample = null;

  /** The previous reading taken while nothing was encoding, for this process's base draw. */
  #idleLoadSample = null;

  /** The previous reading of the torrent thread's processor and the bytes downloaded. */
  #torrentSample = null;
  /** This thread's event-loop lateness, begun at the first machine reading. */
  #mainLoop = null;

  /** A reading of the torrent thread is under way; it asks the worker, which may not answer. */
  #readingTorrent = false;

  /**
   * The share of the machine the torrent thread draws in intervals that
   * downloaded nothing: what comes off its spending before the rest is priced
   * per downloaded byte.
   */
  #observedThreadBaseDraw = null;

  /** @type {number[]} Recent readings behind that median. */
  #threadBaseReadings = [];

  /**
   * The download limit the processor share last set, bytes per second;
   * Infinity for none, null before the share ran. Said beside what the
   * torrents actually moved.
   */
  downloadLimit = null;

  /** The previous reading of the whole machine taken while nothing was encoding. */
  #idleAvailabilitySample = null;

  /** A reading is under way; the next tick must not start another beside it. */
  #reporting = false;

  /**
   * How long each file is in bytes, from its declared source statistics. The torrent moves the CONTAINER, so this — not the video stream's
   * bitrate — is what its work should be priced against.
   *
   * @type {Map<string, number>}
   */
  fileLengthByKey = new Map();

  /**
   * The machine's seconds per megabyte downloaded, as the processor share and
   * the quality offer read it. Null: no established price, so the download is
   * not limited and the offer counts no torrent cost.
   *
   * Not set from the torrent thread's reading below. On 2.97.8 that reading
   * carried the thread's other work — 1287, 217 and 146 ms per MB at the AVI's
   * start, median 263 against 12.5 on the MKV — and held the AVI download at
   * its own film rate; until the price is established it is kept for the log
   * only (torrent-tv/meta#178, control run).
   */
  observedTorrentCostPerMegabyte = null;

  /**
   * The torrent thread's processor per downloaded megabyte, its base draw taken
   * off: a reading for the log, used by nothing.
   */
  torrentThreadCostPerMegabyte = null;

  /** @type {number[]} Recent readings behind that median. */
  #torrentCostReadings = [];

  /**
   * The share of the machine this process draws with nothing encoding and the
   * torrents moving nothing — the spending that would have happened anyway.
   * The processor share takes it off what the proxy has.
   */
  #observedBaseDraw = null;

  /** @type {number[]} Recent readings behind that median. */
  #baseDrawReadings = [];

  /**
   * What each watched TORRENT is measured to be moving right now, in bytes per
   * second, keyed by source. Rebuilt every budget tick from the live sessions,
   * so an entry that is present was taken this tick.
   *
   * @type {Map<string, number>}
   */
  #downloadRateByKey = new Map();

  /**
   * The speed each file's own interruptions were last measured to demand,
   * keyed `sourceKey:fileIndex`. Kept per source rather than per session
   * because the first offer for a file is made before any session of it exists,
   * and a file that has been watched before has already told the reader what
   * its swarm does.
   *
   * @type {Map<string, number>}
   */
  #requiredSpeedByKey = new Map();

  /** Last complete supply reading for each source file. @type {Map<string, object>} */
  #supplyByKey = new Map();

  /**
   * @param {object} host - `liveRunsOf`, `runStateOf`, the readings of `encode/host-load.js` (`readMachineState`, `readProcessCpuSeconds`, `readProxyCpuSeconds`, `readSystemCpu`, `shareOfMachine`), `getSourceStats`, `getTorrentTotals`, `outputs`, and optionally `costSecOf(session)`, `EncodeCost`'s cost of an output, said beside each run's `k`
   */
  /** The share of the machine this process draws doing nothing priced; zero until measured. */
  get baseDraw() {
    return this.#observedBaseDraw ?? 0;
  }

  constructor(host) {
    this.#host = host;
  }

  /** Read the declared source length for pricing; this does not request file bytes. */
  async readFileLength(sourceKey, fileIndex) {
    if (!this.#host.getSourceStats) return null;
    try {
      const stats = await this.#host.getSourceStats(sourceKey, fileIndex);
      const length = Number(stats?.fileLength);
      if (!Number.isFinite(length) || length <= 0) return null;
      this.fileLengthByKey.set(SourceFiles.keyFor(sourceKey, fileIndex), length);
      return length;
    } catch {
      return null;
    }
  }

  /**
   * What the torrent costs this machine per megabyte it downloads, and what
   * this process draws when it is doing nothing priced. One reading of the
   * torrent totals feeds both.
   *
   * THE PRICE OF A BYTE is the torrent thread's own processor time against the
   * bytes every torrent downloaded, both read by that thread in one moment, so
   * they cover one interval. It is taken whether or not anything encodes: up to
   * 2.97.7 it was taken only while nothing encoded, and an AVI re-encoded from
   * the first second of its download never got a price, so the processor share
   * never limited the download it was built for (field 2026-10-11: 0 limits on
   * the AVI, 267 on the MKV, torrent-tv/meta#178). The thread's base draw —
   * what it spends in intervals that downloaded nothing — comes off first, with
   * the check of `encode/torrent-cost.js` that what is left is more than the
   * base draw's own scatter; an interval that downloaded nothing is never a
   * price. The torrent's work on other threads is not counted.
   *
   * THE BASE DRAW OF THIS PROCESS is taken as before: only while nothing
   * encodes and nothing downloads, and never across metadata parsing.
   *
   * @param {boolean} nothingEncoding
   */
  async #learnTorrentCost(nothingEncoding) {
    if (this.#readingTorrent) return;
    this.#readingTorrent = true;
    try {
      const activityBefore = this.#host.readMetadataActivity?.();
      const totals = await this.#torrentTotals();
      const now = {
        takenAt: Date.now(),
        cpuSeconds: this.#host.readProxyCpuSeconds(),
        bytes: totals?.downloaded ?? null,
        uploaded: totals?.uploaded ?? null,
        served: totals?.served ?? null,
        threadCpuSeconds: totals?.threadCpuSeconds ?? null,
        readerMs: totals?.readerMs ?? null,
        readerReads: totals?.readerReads ?? null,
        loopP99Ms: totals?.loopP99Ms ?? null,
        loopMaxMs: totals?.loopMaxMs ?? null,
        selection: totals?.selection ?? null,
        metadata: this.#host.readMetadataActivity?.()
      };
      this.#learnThreadCost(now);
      if (!nothingEncoding) {
        this.#idleLoadSample = null;
        return;
      }
      const previous = this.#idleLoadSample;
      this.#idleLoadSample = now;
      if (previous === null || now.bytes === null || previous.bytes === null || now.bytes !== previous.bytes) return;
      // Process CPU includes metadata parsing; an interval holding it is not
      // what this process draws doing nothing.
      if (activityBefore?.active || now.metadata?.active || previous.metadata?.active ||
        activityBefore?.epoch !== now.metadata?.epoch || previous.metadata?.epoch !== now.metadata?.epoch) return;
      const elapsedSec = (now.takenAt - previous.takenAt) / 1000;
      // Divided by the cores: `process.cpuUsage()` adds up every thread, while
      // everything this figure is set against is a share of the whole machine.
      const cpuSeconds = (now.cpuSeconds - previous.cpuSeconds) / Math.max(1, os.cpus().length);
      this.#learnBaseDraw(baseDrawFrom({ cpuSeconds, elapsedSeconds: elapsedSec }));
    } finally {
      this.#readingTorrent = false;
    }
  }

  /**
   * One interval of the torrent thread: its base draw where it downloaded
   * nothing, a price where it downloaded something, and what it moved against
   * the limit in force, said while anything moves or is limited.
   *
   * @param {{ takenAt: number, bytes: number | null, uploaded: number | null, served: number | null, threadCpuSeconds: number | null }} now
   */
  #learnThreadCost(now) {
    const previous = this.#torrentSample;
    this.#torrentSample = now;
    if (previous === null || now.bytes === null || previous.bytes === null ||
      now.threadCpuSeconds === null || previous.threadCpuSeconds === null) return;
    const elapsedSec = (now.takenAt - previous.takenAt) / 1000;
    const megabytes = (now.bytes - previous.bytes) / 1e6;
    // A torrent leaving the pool takes its bytes out of the total, and a new
    // worker starts its clock again: such an interval says nothing.
    if (!(elapsedSec > 0) || megabytes < 0 || now.threadCpuSeconds < previous.threadCpuSeconds) return;
    const cpuSeconds = (now.threadCpuSeconds - previous.threadCpuSeconds) / Math.max(1, os.cpus().length);
    const limit = this.downloadLimit;
    // What else the thread moved over the same interval, across every torrent:
    // sent back to the swarm, and handed to readers (encoder inputs, container
    // reads, `/stream`). Said beside the download so that the thread's
    // processor can be set against each kind of work (torrent-tv/meta#178).
    const movedOf = (key) => Number.isFinite(now[key]) && Number.isFinite(previous[key]) && now[key] >= previous[key]
      ? (now[key] - previous[key]) / 1e6 : null;
    const rateOf = (key) => movedOf(key) === null ? "n/a" : `${(movedOf(key) / elapsedSec).toFixed(2)} MB/s`;
    if (megabytes > 0 || Number.isFinite(limit) || movedOf("served") > 0 || movedOf("uploaded") > 0) {
      logger.info(
        `torrent: downloaded ${(megabytes / elapsedSec).toFixed(2)} MB/s, sent to peers ${rateOf("uploaded")}, ` +
        `handed to readers ${rateOf("served")} over ${elapsedSec.toFixed(1)}s, ` +
        `limit ${Number.isFinite(limit) ? `${(limit / 1e6).toFixed(2)} MB/s` : "none"}; ` +
        `its thread drew ${Math.round(cpuSeconds / elapsedSec * 100)}% of the machine` + threadSays(now, previous)
      );
    }
    if (megabytes === 0) {
      this.#learnThreadBaseDraw(baseDrawFrom({ cpuSeconds, elapsedSeconds: elapsedSec }));
      return;
    }
    const costPerMegabyte = costPerMegabyteFrom({
      cpuSeconds,
      elapsedSeconds: elapsedSec,
      megabytes,
      baseDraw: this.#observedThreadBaseDraw,
      // How much the base draw's own readings disagree, which is how much of
      // this interval's remainder means nothing.
      drawScatter: scatterOf(this.#threadBaseReadings)
    });
    if (costPerMegabyte === null) {
      return;
    }
    const readings = [...this.#torrentCostReadings, costPerMegabyte].slice(-READINGS_KEPT);
    this.#torrentCostReadings = readings;
    const median = medianOf(readings);
    if (!movedBeyondScatter(this.torrentThreadCostPerMegabyte, median, readings)) {
      return;
    }
    this.torrentThreadCostPerMegabyte = median;
    logger.info(
      `host-load: the torrent thread costs ${(median * 1000).toFixed(1)}ms of the machine per downloaded MB ` +
      `(median of ${readings.length}, latest ${(costPerMegabyte * 1000).toFixed(1)}ms over ${megabytes.toFixed(1)}MB, ` +
      `its base draw ${((this.#observedThreadBaseDraw ?? 0) * 100).toFixed(1)}% of the machine taken off; ` +
      `for the log only, not the download limit or the quality offer)`
    );
  }

  /**
   * What the torrent thread draws in an interval that downloaded nothing.
   *
   * @param {number | null} share - Of the machine, over the interval just read.
   */
  #learnThreadBaseDraw(share) {
    if (share === null) {
      return;
    }
    const readings = [...this.#threadBaseReadings, share].slice(-READINGS_KEPT);
    this.#threadBaseReadings = readings;
    const median = medianOf(readings);
    if (!movedBeyondScatter(this.#observedThreadBaseDraw, median, readings)) {
      return;
    }
    this.#observedThreadBaseDraw = median;
    logger.info(
      `host-load: the torrent thread draws ${(median * 100).toFixed(1)}% of the machine while it downloads nothing ` +
      `(median of ${readings.length}, latest ${(share * 100).toFixed(1)}%)`
    );
  }

  /**
   * What each watched file's torrent is moving right now.
   *
   * The torrent is priced per megabyte it moves, so the price has to be charged
   * against the megabytes it IS moving. Charged against the file's own byte
   * rate — what the viewer consumes — it asks for payment on a fully downloaded
   * file that is moving nothing, and it under-charges a file being fetched
   * ahead of the viewer, which is the state every session starts in.
   *
   * Rebuilt whole each tick from the live sessions, so an entry that is here
   * was taken this tick and a source nobody is watching leaves by itself.
   *
   * @returns {Promise<void>}
   */
  async sampleDownloadRates() {
    if (!this.#host.getSourceStats) {
      return;
    }
    /** @type {Map<string, { sourceKey: string, fileIndex: number }>} */
    const wanted = new Map();
    for (const session of this.#host.outputs.values()) {
      wanted.set(session.file.key, {
        sourceKey: session.file.sourceKey,
        fileIndex: session.file.fileIndex
      });
    }
    /** @type {Map<string, number>} */
    const measured = new Map();
    for (const [key, source] of wanted) {
      try {
        const stats = await this.#host.getSourceStats(source.sourceKey, source.fileIndex);
        // The TORRENT's rate, which is what it is: one swarm feeding one
        // client, whichever of its files are being read. Kept per source and
        // divided among the files being watched, so two episodes of one pack
        // do not each charge the machine for the whole download.
        const length = Number(stats?.fileLength);
        if (Number.isFinite(length) && length > 0) this.fileLengthByKey.set(key, length);
        const rate = Number(stats?.downloadSpeed);
        if (Number.isFinite(rate) && rate >= 0) {
          measured.set(source.sourceKey, rate);
        }
        // Kept, not rebuilt: the demand a swarm made on this file does not stop
        // being true when a tick fails to fetch it, and it is what the FIRST
        // offer of the next session will be judged against.
        const demanded = Number(stats?.supply?.requiredSpeed);
        if (Number.isFinite(demanded) && demanded > 0) {
          this.#requiredSpeedByKey.set(key, demanded);
        }
        if (stats?.supply) {
          this.#supplyByKey.set(key, stats.supply);
        }
      } catch {
        // The pool is busy or gone. A reading missed is not a fault, and the
        // key simply does not appear this tick.
      }
    }
    this.#downloadRateByKey = measured;
  }

  /**
   * How many files of one torrent have a live session reading them.
   *
   * @param {string} sourceKey
   * @returns {number} At least one, so the rate is never divided by nothing.
   */
  #filesWatchedOn(sourceKey) {
    const files = new Set();
    for (const session of this.#host.outputs.values()) {
      if (session?.file.sourceKey === sourceKey) {
        files.add(session.file.fileIndex);
      }
    }
    return Math.max(1, files.size);
  }

  /**
   * The speed this file's supply demands, as last measured on this swarm.
   *
   * @param {string} sourceKey
   * @param {number} fileIndex
   * @returns {number | null}
   */
  requiredSpeedFor(sourceKey, fileIndex) {
    return this.#requiredSpeedByKey.get(SourceFiles.keyFor(sourceKey, fileIndex)) ?? null;
  }

  /** Last complete supply reading for a source file. */
  supplyFor(file) {
    return this.#supplyByKey.get(SourceFiles.keyFor(file.sourceKey, file.fileIndex)) ?? null;
  }

  /**
   * How many megabytes a second the torrent is moving for this file — measured
   * where a reading exists, and otherwise the rate the file has to be moved at
   * to be watched at all (its length over its duration), which is what the
   * measured rate averages to over a viewing.
   *
   * @param {string} sourceKey
   * @param {number} fileIndex
   * @param {number | null} fileLengthBytes
   * @param {number | null} durationSeconds
   * @returns {number | null}
   */
  torrentMegabytesPerSecond(sourceKey, fileIndex, fileLengthBytes, durationSeconds) {
    const measured = this.#downloadRateByKey.get(sourceKey);
    if (Number.isFinite(measured)) {
      return measured / 1e6 / this.#filesWatchedOn(sourceKey);
    }
    // The FILE's rate, not the video stream's. What the torrent moves is the
    // container: on the releases this serves, two or three AC-3 tracks add
    // 10-25 % to what the picture alone would suggest.
    const fileLength = Number(fileLengthBytes);
    const duration = Number(durationSeconds);
    if (Number.isFinite(fileLength) && fileLength > 0 && Number.isFinite(duration) && duration > 0) {
      return fileLength / duration / 1e6;
    }
    return null;
  }

  /**
   * Record what this process draws when it is doing none of the work that gets
   * priced.
   *
   * @param {number | null} share - Of the machine, over the interval just read.
   * @returns {void}
   */
  #learnBaseDraw(share) {
    if (share === null) {
      return;
    }
    const readings = [...this.#baseDrawReadings, share].slice(-READINGS_KEPT);
    this.#baseDrawReadings = readings;
    const median = medianOf(readings);
    if (!movedBeyondScatter(this.#observedBaseDraw, median, readings)) {
      return;
    }
    this.#observedBaseDraw = median;
    logger.info(
      `host-load: this process draws ${(median * 100).toFixed(1)}% of the machine with nothing encoding and ` +
      `nothing downloading (median of ${readings.length}, latest ${(share * 100).toFixed(1)}%)`
    );
  }

  /**
   * The bytes every torrent has downloaded and sent to peers, the bytes the
   * torrent thread handed to readers, and that thread's processor seconds, read
   * together by that thread, or null when it cannot be asked.
   * Downloaded bytes only: every one is verified against the piece hash and
   * written to the store; a byte sent back to the swarm is neither.
   *
   * @returns {Promise<{ downloaded: number | null, uploaded: number | null, served: number | null, threadCpuSeconds: number | null } | null>}
   */
  async #torrentTotals() {
    if (typeof this.#host.getTorrentTotals !== "function") {
      return null;
    }
    try {
      const totals = await this.#host.getTorrentTotals();
      const read = (key) => { const value = Number(totals?.[key]); return Number.isFinite(value) ? value : null; };
      return { downloaded: read("downloaded"), uploaded: read("uploaded"), served: read("served"), threadCpuSeconds: read("threadCpuSeconds"),
        readerMs: read("readerMs"), readerReads: read("readerReads"), loopP99Ms: read("loopP99Ms"), loopMaxMs: read("loopMaxMs"),
        selection: totals?.selection ?? null };
    } catch {
      return null; // the pool is busy or gone; a reading missed is not a fault
    }
  }

  /**
   * One reading of the machine, never beside another. The tick fires without
   * waiting for the previous one, and two readings in flight at once each stamp
   * their own time after their own await and then replace one another as the
   * "previous" sample, so a delta of counters is divided by an interval that is
   * not its own (field 2026-10-06: three readings inside 0.1 s).
   *
   * Only the reading of the MACHINE is held to one at a time: its awaits are
   * files of `/proc` and `/sys`, which answer. The torrent's cost asks the
   * torrent worker, which may not answer, and a reading waiting on it would
   * stop every later one — the machine's availability would then stay as it
   * was for as long as the worker did.
   */
  async reportHostLoad() {
    if (this.#reporting) {
      return;
    }
    this.#reporting = true;
    let nothingEncoding = false;
    try {
      nothingEncoding = await this.#reportMachineOnce();
    } finally {
      this.#reporting = false;
    }
    await this.#learnTorrentCost(nothingEncoding);
  }

  /**
   * The machine's availability while nothing is encoding, taken the same way as
   * while something is. Without it the last figure from the last encoder stayed
   * in force for ever: it refused every new encoder, and a refused encoder is
   * the only thing that would have taken the next reading.
   */
  async #learnIdleAvailability(watched, suspended) {
    const [system, endedChildren] = await Promise.all([
      this.#host.readSystemCpu?.() ?? null,
      this.#host.readEndedChildrenCpuSeconds?.() ?? null
    ]);
    const sample = { takenAt: Date.now(), system, endedChildren, byPid: new Map(), proxyCpuSeconds: this.#host.readProxyCpuSeconds(),
      processor: this.#host.sampleProcessor?.() ?? null };
    const previous = this.#idleAvailabilitySample;
    this.#idleAvailabilitySample = sample;
    if (previous === null) {
      this.hostAvailability = availableShareFrom({});
      return;
    }
    // Nothing runs at either reading, and a run may still have run between
    // them: what it used is in the ended-children time (`encoder-cpu.js`).
    const encoders = encoderCpuBetween(previous, sample);
    const share = this.#host.shareOfMachine(
      { takenAt: previous.takenAt, processCpuSeconds: 0, system: previous.system },
      { takenAt: sample.takenAt, processCpuSeconds: encoders?.seconds ?? 0, system: sample.system }
    );
    const proxyShare = this.#setAvailability(share, previous, sample);
    // Said while something is watched, so what is free while every encoder
    // stands is seen beside what it is free for (torrent-tv/meta#178); a proxy
    // nobody watches stays quiet.
    if (share !== null && watched) {
      await this.#sayMachine(share, proxyShare, 0, suspended, false, this.#processorLine(previous, sample, share, proxyShare));
    }
  }

  /**
   * One line of the machine's reading, the same whether encoders run or stand.
   * `available` is the share OTHER processes leave the proxy, what the offer
   * and the processor share divide; `free` is what nothing used over the
   * interval. Unknown stays `n/a`, never zero.
   */
  async #sayMachine(share, proxyShare, running, suspended, incomplete = false, processor = "") {
    const machine = await this.#host.readMachineState();
    // HOW LATE THIS THREAD'S LOOP RAN over the interval: every answer to FFmpeg
    // and every hand-over of a copy waits for it (torrent-tv/meta#178). Begun at
    // the first reading, so a check that never reads the machine starts no timer.
    if (!this.#mainLoop) {
      this.#mainLoop = monitorEventLoopDelay({ resolution: 20 });
      this.#mainLoop.enable();
    }
    const late = this.#mainLoop.count > 0
      ? ` loop p99=${Math.round(this.#mainLoop.percentile(99) / 1e6)}ms max=${Math.round(this.#mainLoop.max / 1e6)}ms` : "";
    this.#mainLoop.reset();
    const asPercent = (value) => (value === null || value === undefined ? "n/a" : `${Math.round(value * 100)}%`);
    const free = Number.isFinite(share.systemShare) ? Math.max(0, 1 - share.systemShare) : null;
    logger.info(
      `host-load: ffmpeg=${incomplete ? `at least ${asPercent(share.processShare)} (a run was not read; availability kept)` : asPercent(share.processShare)} ` +
      `proxy=${asPercent(proxyShare)} ` +
      `system=${asPercent(share.systemShare)} ` +
      `iowait=${asPercent(share.iowaitShare)} cpu=${machine.megahertz === null ? "n/a" : `${machine.megahertz}MHz`} ` +
      `temp=${machine.celsius === null ? "n/a" : `${machine.celsius}C`} ` +
      `encoders=${running} running` + (suspended > 0 ? ` +${suspended} suspended` : "") +
      ` over=${share.elapsedSec.toFixed(1)}s` +
      // What the offer will multiply a prediction by, in the same line as the
      // readings it comes from.
      ` available=${asPercent(this.hostAvailability.share)} for-encoders=${asPercent(this.hostAvailability.forEncoders)}` +
      (Number.isFinite(this.hostAvailability.boundCores) ? ` of ${this.hostAvailability.boundCores.toFixed(2)} cores` : "") +
      ` free=${asPercent(free)}` + processor + late
    );
  }

  /**
   * The processor's upper bound and its measured free amount over the same
   * interval, for the machine's line (torrent-tv/meta#180, phase 1). Read
   * beside today's figures and used by no decision; empty where the host does
   * not take these readings.
   *
   * @param {{ processor?: object | null }} previous
   * @param {{ processor?: object | null }} sample
   * @param {{ processShare: number | null, systemShare: number | null }} share
   * @param {number | null} proxyShare
   * @returns {string}
   */
  #processorLine(previous, sample, share, proxyShare) {
    if (typeof this.#host.processorBetween !== "function" || typeof this.#host.describeProcessor !== "function") {
      return "";
    }
    const ourShare = Number.isFinite(proxyShare) && Number.isFinite(share.processShare) ? proxyShare + share.processShare : null;
    return this.#host.describeProcessor(this.#host.processorBetween(previous.processor, sample.processor, {
      systemShare: share.systemShare,
      ourShare,
      hostCores: Math.max(1, os.cpus().length)
    }));
  }

  /**
   * What each run's FFmpeg spent per second of film over the interval between
   * two readings, with the runs beside it (torrent-tv/meta#180, phase 1).
   *
   * In CPU seconds per second of film (`k`), which is not the unit of
   * `EncodeCost` (seconds of the whole machine per second of film, from
   * speed): a run that uses all it is given has `cost = k / cores`. A `k` read
   * beside other runs already carries their contention, so it is said with
   * them; a run is alone only when no other run was alive at either reading.
   * Only runs read at both ends that made film in between are said. For the
   * log only.
   *
   * Beside each `k`, `EncodeCost`'s cost of the run's output (`c`) and `k`
   * converted to that unit over the cores this process may use (`k/U`), on the
   * same reading: where a run uses less than it is given the two differ, and
   * whether the processor claim moves from `c` to `k` is judged from these
   * lines (plan 2.3, torrent-tv/meta#180). `c` is filed as if the run were
   * alone on a quiet machine; a `k` read beside other runs is not.
   *
   * @param {{ takenAt: number, byPid: Map<number, number>, runs?: Map<number, { film: number | null, label: string, kind: string }> }} previous
   * @param {{ takenAt: number, byPid: Map<number, number>, runs?: Map<number, { film: number | null, label: string, kind: string }> }} sample
   */
  #sayRunCosts(previous, sample) {
    if (!previous.runs || !sample.runs) return;
    const elapsedSec = (sample.takenAt - previous.takenAt) / 1000;
    if (!(elapsedSec > 0)) return;
    const alive = new Map([...previous.runs, ...sample.runs]);
    const boundCores = Number(sample.processor?.bound?.cores);
    const cores = Number.isFinite(boundCores) && boundCores > 0 ? boundCores : Math.max(1, os.cpus().length);
    const said = [];
    for (const [pid, run] of sample.runs) {
      const before = previous.runs.get(pid);
      const cpuNow = sample.byPid.get(pid);
      const cpuBefore = previous.byPid.get(pid);
      if (!before || !Number.isFinite(cpuNow) || !Number.isFinite(cpuBefore) || cpuNow < cpuBefore) continue;
      if (!Number.isFinite(run.film) || !Number.isFinite(before.film)) continue;
      const film = run.film - before.film;
      if (!(film > 0)) continue;
      const cpu = cpuNow - cpuBefore;
      const beside = [...alive].filter(([other]) => other !== pid).map(([, other]) => other.kind);
      const k = cpu / film;
      said.push(`${run.label} ${run.kind} k=${k.toFixed(3)} CPU-s per film-s ` +
        `(${cpu.toFixed(2)} CPU-s, ${film.toFixed(2)} film-s, speed ${(film / elapsedSec).toFixed(2)}x, ` +
        `${(cpu / elapsedSec).toFixed(2)} cores), ` +
        `c=${Number.isFinite(run.costSec) && run.costSec > 0 ? run.costSec.toFixed(3) : "unpriced"} k/U=${(k / cores).toFixed(3)} ` +
        `(U=${cores.toFixed(2)} cores), beside ${beside.length}` + (beside.length > 0 ? ` [${beside.join(", ")}]` : ""));
    }
    if (said.length > 0) {
      logger.info(`processor: run cost over ${elapsedSec.toFixed(1)}s: ${said.join("; ")}`);
    }
  }

  /**
   * `EncodeCost`'s cost of an output, for the log; null where it is unpriced
   * or cannot be read.
   *
   * @param {object} session
   * @returns {number | null}
   */
  #costSecOf(session) {
    try {
      const cost = Number(this.#host.costSecOf?.(session));
      return Number.isFinite(cost) && cost > 0 ? cost : null;
    } catch {
      return null;
    }
  }

  /**
   * @param {{ elapsedSec: number, processShare: number | null, systemShare: number | null, rejected?: string[] } | null} share
   * @param {{ proxyCpuSeconds: number | null }} previous
   * @param {{ proxyCpuSeconds: number | null, processor?: { bound?: { cores: number } | null } | null }} sample
   * @returns {number | null} The proxy's own share of the machine, for the log.
   */
  #setAvailability(share, previous, sample) {
    if (share === null) {
      this.hostAvailability = availableShareFrom({});
      return null;
    }
    if (share.rejected?.length) {
      logger.warn(
        `host-load: ignored a reading over ${share.elapsedSec.toFixed(1)}s that is not a share of the machine ` +
        `(${share.rejected.join(" ")}); availability is unknown until the next one`
      );
    }
    const cores = Math.max(1, os.cpus().length);
    const proxyShare = Number.isFinite(previous.proxyCpuSeconds)
      ? (sample.proxyCpuSeconds - previous.proxyCpuSeconds) / (share.elapsedSec * cores)
      : null;
    // Of the cores this process may use where that is fewer than the host's
    // (torrent-tv/meta#180, phase 3).
    const availability = availableShareFrom({
      systemBusy: share.systemShare,
      encoderShare: share.processShare,
      proxyShare,
      hostCores: cores,
      boundCores: sample.processor?.bound?.cores ?? null
    });
    // The processor left free and what other work takes, in cores, for the
    // pause rule (torrent-tv/meta#180, phase 4). Unknown stays null.
    const ourShare = Number.isFinite(proxyShare) && Number.isFinite(share.processShare) ? proxyShare + share.processShare : null;
    const reading = typeof this.#host.processorBetween === "function"
      ? this.#host.processorBetween(previous.processor ?? null, sample.processor ?? null,
        { systemShare: share.systemShare, ourShare, hostCores: cores })
      : null;
    this.hostAvailability = {
      ...availability,
      freeCores: Number.isFinite(reading?.freeCores) ? reading.freeCores : null,
      otherCores: availability.known ? availability.unattributed * cores : null
    };
    return proxyShare;
  }

  /** @returns {Promise<boolean>} True when no encoder is running, which is when the torrent's cost can be taken. */
  async #reportMachineOnce() {
    const outputs = [...this.#host.outputs.values()];
    const encoding = outputs.filter(
      (session) => processCanBeSignalled(this.#host.runStateOf(session))
    );
    const runningNow = encoding.filter((session) => this.#host.runStateOf(session) !== ENCODE_RUN_STATE.SUSPENDED);
    if (runningNow.length === 0) {
      // No encoder is RUNNING. A suspended one costs nothing, and counting it
      // as work meant this was never reached: measured 2026-08-15, four minutes
      // in which every encoder was suspended, the torrent's price could have
      // been taken, and none was. What this process spends now is the download,
      // the verification, the piece store and the delivery. Item 7.
      await this.#learnIdleAvailability(outputs.length > 0,
        encoding.filter((session) => this.#host.runStateOf(session) === ENCODE_RUN_STATE.SUSPENDED).length);
      this.#hostLoadSample = null;
      return true;
    }
    this.#idleLoadSample = null;
    this.#idleAvailabilitySample = null;
    // EVERY encoder, added up. One of them is meaningless on a host that runs a
    // picture and an audio track at once, and picking the first would have
    // reported whichever the map happened to hold.
    // Kept per PROCESS, not as one total. The set changes between readings —
    // a seek kills ffmpeg and starts another with a new pid whose counter
    // begins at zero, a session ends, a rendition begins — and subtracting one
    // total from another across a changed set produces nonsense: a restart
    // alone would print something like `ffmpeg=-598%`. Only pids present in
    // BOTH readings are counted, so a process that came or went contributes
    // nothing rather than a lie.
    // Each run's pid and start are read BEFORE the readings are awaited: a run
    // that ends meanwhile drops its process, and read after the await it threw
    // `Cannot read properties of null (reading 'pid')`, seven times in one
    // field session, each losing that reading (r64, torrent-tv/meta#178).
    // With the film each has made and what it is, for its cost over the
    // interval (torrent-tv/meta#180).
    const runs = encoding.flatMap((session) => this.#host.liveRunsOf(session)
      .filter((run) => Number.isInteger(run.process?.pid))
      .map((run) => ({
        pid: run.process.pid,
        startedAt: run.startedAt,
        film: filmMadeBy(run),
        label: `${session.outputKey ?? session.id} #${run.from}..#${run.to}`,
        kind: costKindForSession(session),
        costSec: this.#costSecOf(session)
      })));
    const [system, endedChildren, ...cpuReadings] = await Promise.all([
      this.#host.readSystemCpu(),
      this.#host.readEndedChildrenCpuSeconds?.() ?? null,
      ...runs.map((run) => this.#host.readProcessCpuSeconds(run.pid))
    ]);
    /** @type {Map<number, number>} */
    const byPid = new Map();
    /** @type {Map<number, number>} */
    const startedAt = new Map();
    /** @type {Map<number, { film: number | null, label: string, kind: string, costSec: number | null }>} */
    const runsByPid = new Map();
    runs.forEach((run, index) => {
      const seconds = cpuReadings[index];
      if (seconds !== null) {
        byPid.set(run.pid, seconds);
        startedAt.set(run.pid, run.startedAt);
      }
      runsByPid.set(run.pid, { film: run.film, label: run.label, kind: run.kind, costSec: run.costSec });
    });
    const sample = {
      takenAt: Date.now(),
      byPid,
      startedAt,
      endedChildren,
      system,
      // The proxy's own CPU, across every thread: the torrent, the hashing, the
      // piece store and the delivery. None of it is in the encode budget, and
      // on the addon host it is most of what the machine does while encoders
      // are suspended.
      proxyCpuSeconds: this.#host.readProxyCpuSeconds(),
      runs: runsByPid,
      processor: this.#host.sampleProcessor?.() ?? null
    };
    const previous = this.#hostLoadSample;
    this.#hostLoadSample = sample;
    if (previous === null) {
      return false; // the first reading is only something to compare against
    }
    // Every process counted once, including runs that started or ended between
    // the readings (`encoder-cpu.js`). Unknown stays unknown: on a host with no
    // `/proc` there are no readings at all, and the share is null rather than a
    // confident zero.
    const encoders = encoderCpuBetween(previous, sample);
    this.#sayRunCosts(previous, sample);
    const share = this.#host.shareOfMachine(
      { takenAt: previous.takenAt, processCpuSeconds: encoders === null ? null : 0, system: previous.system },
      { takenAt: sample.takenAt, processCpuSeconds: encoders?.seconds ?? null, system: sample.system }
    );
    if (share === null) {
      this.hostAvailability = availableShareFrom({});
      return false;
    }
    // How many of them are stopped by the look-ahead cap. Without this a zero
    // share reads as an encoder being starved of the machine, when it is an
    // encoder deliberately not running — which is what the first readings on
    // the addon host actually were (2026-08-15: `ffmpeg=0% system=24%`, both
    // encoders suspended, and the speed beside it a stale figure from before
    // they stopped).
    const suspended = encoding.filter((session) => this.#host.runStateOf(session) === ENCODE_RUN_STATE.SUSPENDED).length;
    const running = encoding.length - suspended;
    if (encoders && !encoders.complete) {
      // A lower bound of our own load is not a reading of what other work left
      // us: the last availability stands, and the line says so.
      await this.#sayMachine(share, null, running, suspended, true, this.#processorLine(previous, sample, share, null));
      return false;
    }
    // Kept for the quality offer, which predicts from a benchmark taken on a
    // QUIET host: the same reading that is printed here says how much of the
    // machine a new encoder could actually have. Only what nobody has been
    // charged for is subtracted — see `encode/available-share.js`.
    const proxyShare = this.#setAvailability(share, previous, sample);
    await this.#sayMachine(share, proxyShare, running, suspended, false, this.#processorLine(previous, sample, share, proxyShare));
    return false;
  }

  /**
   * What this file costs the machine merely by being fetched and delivered
   * while it is watched, in seconds of work per second of video.
   *
   * A viewer consumes the file at its own byte rate, and every one of those
   * bytes is downloaded, verified and pushed by this process. Priced per
   * megabyte by `observedTorrentCostPerMegabyte`, which is unset while no price
   * is established. Zero while either term is unmeasured
   * — a guess here would refuse rungs on arithmetic nobody performed.
   *
   * @param {HlsSession} session
   * @returns {number}
   */
  torrentCostSecFor(session) {
    const perMegabyte = this.observedTorrentCostPerMegabyte;
    const megabytesPerSecond = this.torrentMegabytesPerSecond(
      session.file.sourceKey,
      session.file.fileIndex,
      this.fileLengthByKey.get(session.file.key) ?? null,
      session.file.durationSeconds
    );
    return perMegabyte !== null && megabytesPerSecond !== null
      ? perMegabyte * megabytesPerSecond
      : 0;
  }
}

/**
 * The film a run has made since it started, from its progress, or null before
 * it has said any.
 *
 * @param {{ progress?: { processedSeconds?: number, startPositionSeconds?: number } }} run
 * @returns {number | null}
 */
function filmMadeBy(run) {
  const made = Number(run.progress?.processedSeconds) - Number(run.progress?.startPositionSeconds ?? 0);
  return Number.isFinite(made) && made >= 0 ? made : null;
}
