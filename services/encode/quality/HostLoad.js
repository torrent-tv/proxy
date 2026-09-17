/**
 * What the proxy's own work costs this host, read while it runs.
 *
 * The torrent's CPU per megabyte it moves, the share of a core this process
 * draws doing nothing priced, how fast each watched torrent is moving, the speed
 * each file's supply demands, how long each file is, and how much of the machine
 * a new encoder could have. The encoders' own cost is `EncodeCost`'s.
 */

import os from "node:os";
import { logger } from "../../../utils/logger.js";
import { availableShareFrom } from "../available-share.js";
import { baseDrawFrom, costPerMegabyteFrom } from "../torrent-cost.js";
import { medianOf, movedBeyondScatter, READINGS_KEPT, scatterOf } from "../learned-median.js";
import { ENCODE_RUN_STATE, processCanBeSignalled } from "../encode-run-state.js";
import { SourceFiles } from "../../media/SourceFile.js";

// How far ahead of its own read head a reader asks the swarm for, expressed in
// seconds of PLAYBACK. The torrent thread can only think in bytes, and a fixed
// byte window is wrong at both ends of the range: 32 MB is half a minute of a
// 1080p film and about four seconds of a disc remux. Duration and file size are
// both known here, so the window is sized where the knowledge is and sent down
// on the ffmpeg input URL.
const READ_WINDOW_SECONDS = 30;
// Bounds, so a wrong or unusual byte rate cannot ask for something absurd. The
// floor keeps a few pieces in flight on a low-bitrate file; the ceiling keeps
// one reader from claiming more than a fraction of the piece store.
const READ_WINDOW_MIN_BYTES = 16 * 1024 * 1024;
const READ_WINDOW_MAX_BYTES = 96 * 1024 * 1024;

export class HostLoad {
  /** What this reads and asks of the rest of the proxy, and nothing else. @type {object} */
  #host;

  /** How much of the machine a new encoder could have, from the last reading; undefined before one. */
  hostAvailability;

  /** The previous reading of the machine, to compare the next one against. */
  #hostLoadSample = null;

  /** The previous reading taken while nothing was encoding, for the torrent's own cost. */
  #idleLoadSample = null;

  /**
   * How long each file is in bytes, from the stats call the read window already
   * makes. The torrent moves the CONTAINER, so this — not the video stream's
   * bitrate — is what its work should be priced against.
   *
   * @type {Map<string, number>}
   */
  fileLengthByKey = new Map();

  /** Seconds of this process's CPU per megabyte the torrent moves, once measured. */
  observedTorrentCostPerMegabyte = null;

  /** @type {number[]} Recent readings behind that median. */
  #torrentCostReadings = [];

  /**
   * The share of one core this process draws with nothing encoding and the
   * torrents moving nothing — the spending that would have happened anyway, and
   * which must come off a reading before the rest is called the torrent's.
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

  /**
   * @param {object} host - `liveRunsOf`, `runStateOf`, the readings of `encode/host-load.js` (`readMachineState`, `readProcessCpuSeconds`, `readProxyCpuSeconds`, `readSystemCpu`, `shareOfMachine`), `getSourceStats`, `getTorrentTotals`, `outputs`
   */
  constructor(host) {
    this.#host = host;
  }

  /**
   * The read-ahead window for a file, in bytes, sized from how many seconds of
   * playback it holds.
   *
   * @param {string} sourceKey
   * @param {number} fileIndex
   * @param {number} durationSeconds
   * @returns {Promise<number>} Zero when the byte rate cannot be established,
   *   which leaves the reader on its own default.
   */
  async readWindowBytesFor(sourceKey, fileIndex, durationSeconds) {
    // The length read here is also what prices the torrent's own work for this
    // file, so it is remembered rather than discarded.

    if (!this.#host.getSourceStats || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return 0;
    }
    let fileLength = 0;
    try {
      const stats = await this.#host.getSourceStats(sourceKey, fileIndex);
      fileLength = Number(stats?.fileLength);
    } catch {
      return 0;
    }
    if (!Number.isFinite(fileLength) || fileLength <= 0) {
      return 0;
    }
    this.fileLengthByKey.set(SourceFiles.keyFor(sourceKey, fileIndex), fileLength);
    const bytesPerSecond = fileLength / durationSeconds;
    // Shared between the readers this file already has. The window is stated in
    // seconds of playback and the store's memory is one budget for the whole
    // torrent, so N readers asking for thirty seconds each ask for N times what
    // was provided for — and on 2026-08-15 that is exactly what happened: a
    // viewer with a picture and an audio track had every resident piece held at
    // once, a read ended with zero bytes, and every encoder on the file took
    // that for the end of it.
    //
    // Dividing keeps the promise the budget was written against. It is not the
    // sliding window of roadmap item 8 — pieces still leave only by the store's
    // own eviction — but it removes the multiplication that broke it.
    const readers = Math.max(1, this.#readersOn(sourceKey, fileIndex));
    const wanted = Math.round((bytesPerSecond * READ_WINDOW_SECONDS) / readers);
    return Math.min(READ_WINDOW_MAX_BYTES, Math.max(READ_WINDOW_MIN_BYTES, wanted));
  }

  /**
   * How many live sessions read this file: the picture, any rung being warmed
   * beside it, and any audio track published on its own.
   *
   * @param {string} sourceKey
   * @param {number} fileIndex
   * @returns {number}
   */
  #readersOn(sourceKey, fileIndex) {
    let readers = 0;
    for (const session of this.#host.outputs.values()) {
      if (session?.file.sourceKey === sourceKey && session.file.fileIndex === fileIndex) {
        readers += 1;
      }
    }
    return readers;
  }

  /**
   * What the torrent itself costs this machine, per megabyte it moves.
   *
   * Downloading, verifying every piece and pushing segments down a data channel
   * are work on the same box as the encoder, they scale with the file's own
   * bitrate, and the budget counts none of it. Measured on the addon host with
   * every encoder suspended, the machine was still 20-29 % busy.
   *
   * Taken only while NOTHING is encoding, because that is the only moment the
   * spending can be attributed without arithmetic: what this process uses then
   * is the torrent's.
   */
  async #learnTorrentCost() {
    const now = {
      takenAt: Date.now(),
      cpuSeconds: this.#host.readProxyCpuSeconds(),
      bytes: await this.#torrentBytesMoved()
    };
    const previous = this.#idleLoadSample;
    this.#idleLoadSample = now;
    if (previous === null || now.bytes === null || previous.bytes === null) {
      return;
    }
    const elapsedSec = (now.takenAt - previous.takenAt) / 1000;
    const megabytes = (now.bytes - previous.bytes) / 1e6;
    // Divided by the cores, because `process.cpuUsage()` adds up every thread
    // while everything this figure is later added to is measured in WALL
    // seconds per second of video. Left undivided on the four-core addon host
    // it overstated the torrent by four times, which on the field's own rung
    // was the difference between offering it and refusing it.
    const cores = Math.max(1, os.cpus().length);
    const cpuSeconds = (now.cpuSeconds - previous.cpuSeconds) / cores;
    if (megabytes === 0) {
      // Nothing encoding and not one byte moved: whatever this process spent in
      // that interval, it spends whether or not there is a torrent. Measuring
      // it is what lets the next interval be attributed instead of divided
      // whole — see `encode/torrent-cost.js` for the readings that forced this.
      this.#learnBaseDraw(baseDrawFrom({ cpuSeconds, elapsedSeconds: elapsedSec }));
      return;
    }
    const costPerMegabyte = costPerMegabyteFrom({
      cpuSeconds,
      elapsedSeconds: elapsedSec,
      megabytes,
      baseDraw: this.#observedBaseDraw,
      // How much the draw's own readings disagree, which is how much of this
      // interval's remainder means nothing.
      drawScatter: scatterOf(this.#baseDrawReadings)
    });
    if (costPerMegabyte === null) {
      return;
    }
    const readings = [...this.#torrentCostReadings, costPerMegabyte].slice(-READINGS_KEPT);
    this.#torrentCostReadings = readings;
    const median = medianOf(readings);
    if (!movedBeyondScatter(this.observedTorrentCostPerMegabyte, median, readings)) {
      return;
    }
    this.observedTorrentCostPerMegabyte = median;
    logger.info(
      `host-load: the torrent costs ${(median * 1000).toFixed(1)}ms of CPU per MB on this host ` +
      `(median of ${readings.length}, latest ${(costPerMegabyte * 1000).toFixed(1)}ms over ${megabytes.toFixed(1)}MB, ` +
      `base draw ${((this.#observedBaseDraw ?? 0) * 100).toFixed(1)}% of a core already taken off)`
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
        // And onto the sessions themselves, which is where the browser's
        // minimum buffer is read from. Set only by the downshift check until
        // now, it stood still on every session that never fell below realtime,
        // so the figures the viewer waits on were minutes old or absent.
        if (stats?.supply) {
          for (const session of this.#host.outputs.values()) {
            if (session?.file.sourceKey === source.sourceKey && session.file.fileIndex === source.fileIndex) {
              session.supplyFigures = stats.supply;
            }
          }
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
   * @param {number | null} share - Of one core, over the interval just read.
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
      `host-load: this process draws ${(median * 100).toFixed(1)}% of a core with nothing encoding and ` +
      `nothing downloading (median of ${readings.length}, latest ${(share * 100).toFixed(1)}%)`
    );
  }

  /**
   * Bytes this proxy's torrents have moved in total, or null when it cannot be
   * asked.
   *
   * @returns {Promise<number | null>}
   */
  async #torrentBytesMoved() {
    if (typeof this.#host.getTorrentTotals !== "function") {
      return null;
    }
    try {
      const totals = await this.#host.getTorrentTotals();
      // Downloaded bytes only. Every one of them is verified against the piece
      // hash and written to the store; a byte sent back to the swarm is neither,
      // and adding the two would price both at whatever the mixture happened to
      // be on the day.
      const downloaded = Number(totals?.downloaded);
      return Number.isFinite(downloaded) ? downloaded : null;
    } catch {
      return null; // the pool is busy or gone; a reading missed is not a fault
    }
  }

  async reportHostLoad() {
    const encoding = [...this.#host.outputs.values()].filter(
      (session) => processCanBeSignalled(this.#host.runStateOf(session))
    );
    const runningNow = encoding.filter((session) => this.#host.runStateOf(session) !== ENCODE_RUN_STATE.SUSPENDED);
    if (runningNow.length === 0) {
      // No encoder is RUNNING. A suspended one costs nothing, and counting it
      // as work meant this was never reached: measured 2026-08-15, four minutes
      // in which every encoder was suspended, the torrent's price could have
      // been taken, and none was. What this process spends now is the download,
      // the verification, the piece store and the delivery. Item 7.
      await this.#learnTorrentCost();
      this.#hostLoadSample = null;
      return;
    }
    this.#idleLoadSample = null;
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
    const pids = encoding.flatMap((session) => this.#host.liveRunsOf(session).map((run) => run.process?.pid ?? null)).filter((pid) => pid !== null);
    const [system, ...cpuReadings] = await Promise.all([
      this.#host.readSystemCpu(),
      ...pids.map((pid) => this.#host.readProcessCpuSeconds(pid))
    ]);
    /** @type {Map<number, number>} */
    const byPid = new Map();
    pids.forEach((pid, index) => {
      const seconds = cpuReadings[index];
      if (seconds !== null) {
        byPid.set(pid, seconds);
      }
    });
    const sample = {
      takenAt: Date.now(),
      byPid,
      system,
      // The proxy's own CPU, across every thread: the torrent, the hashing, the
      // piece store and the delivery. None of it is in the encode budget, and
      // on the addon host it is most of what the machine does while encoders
      // are suspended.
      proxyCpuSeconds: this.#host.readProxyCpuSeconds()
    };
    const previous = this.#hostLoadSample;
    this.#hostLoadSample = sample;
    if (previous === null) {
      return; // the first reading is only something to compare against
    }
    // Summed over the pids both readings hold, so nothing is measured against a
    // process that was not there before. Unknown stays unknown: on a host with
    // no `/proc` there are no readings at all, and the share is null rather
    // than a confident zero.
    let encoderDelta = null;
    for (const [pid, seconds] of sample.byPid) {
      const before = previous.byPid?.get(pid);
      if (before !== undefined && seconds >= before) {
        encoderDelta = (encoderDelta ?? 0) + (seconds - before);
      }
    }
    const share = this.#host.shareOfMachine(
      { takenAt: previous.takenAt, processCpuSeconds: encoderDelta === null ? null : 0, system: previous.system },
      { takenAt: sample.takenAt, processCpuSeconds: encoderDelta, system: sample.system }
    );
    if (share === null) {
      return;
    }
    // How many of them are stopped by the look-ahead cap. Without this a zero
    // share reads as an encoder being starved of the machine, when it is an
    // encoder deliberately not running — which is what the first readings on
    // the addon host actually were (2026-08-15: `ffmpeg=0% system=24%`, both
    // encoders suspended, and the speed beside it a stale figure from before
    // they stopped).
    const suspended = encoding.filter((session) => this.#host.runStateOf(session) === ENCODE_RUN_STATE.SUSPENDED).length;
    const running = encoding.length - suspended;
    const machine = await this.#host.readMachineState();
    const asPercent = (value) => (value === null ? "n/a" : `${Math.round(value * 100)}%`);
    const cores = Math.max(1, os.cpus().length);
    const proxyShare = Number.isFinite(previous.proxyCpuSeconds)
      ? (sample.proxyCpuSeconds - previous.proxyCpuSeconds) / (share.elapsedSec * cores)
      : null;
    // Kept for the quality offer, which predicts from a benchmark taken on a
    // QUIET host: the same reading that is printed here says how much of the
    // machine a new encoder could actually have. Only what nobody has been
    // charged for is subtracted — see `encode/available-share.js`.
    this.hostAvailability = availableShareFrom({
      systemBusy: share.systemShare,
      encoderShare: share.processShare,
      proxyShare
    });
    logger.info(
      `host-load: ffmpeg=${asPercent(share.processShare)} proxy=${asPercent(proxyShare)} ` +
      `system=${asPercent(share.systemShare)} ` +
      `iowait=${asPercent(share.iowaitShare)} cpu=${machine.megahertz === null ? "n/a" : `${machine.megahertz}MHz`} ` +
      `temp=${machine.celsius === null ? "n/a" : `${machine.celsius}C`} ` +
      `encoders=${running} running` + (suspended > 0 ? ` +${suspended} suspended` : "") +
      ` over=${share.elapsedSec.toFixed(1)}s` +
      // What the offer will multiply a prediction by, in the same line as the
      // readings it comes from.
      ` available=${asPercent(this.hostAvailability.share)}`
    );
  }

  /**
   * What this file costs the machine merely by being fetched and delivered
   * while it is watched, in seconds of work per second of video.
   *
   * A viewer consumes the file at its own byte rate, and every one of those
   * bytes is downloaded, verified and pushed by this process. Priced per
   * megabyte from readings taken while nothing was encoding, so the two
   * measurements do not contain each other. Zero while either term is unmeasured
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
