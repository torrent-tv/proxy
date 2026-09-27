/**
 * @file What this host takes to create an output and to produce its first
 * segment: the recorded medians, the synthetic figure from the startup
 * measurement, and the file that keeps the medians across a restart.
 *
 * Moved out of the session manager whole. The file it keeps is to be deleted once
 * the synthetic figure takes every term of the first-segment time as an input.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../../../utils/logger.js";
import { TRANSCODE_FPS } from "../hwaccel.js";
// How many recent runs the two cold-start estimates keep. Both the
// session-create time and the first-segment time are reported to the browser as
// the median of this many samples, so it has to be long enough that one slow run
// does not move the figure and short enough that the estimate still follows the
// host: a proxy whose swarm has warmed up, or which has just picked up a second
// viewer, should stop quoting the numbers from ten minutes ago.
const FIRST_SEGMENT_SAMPLES = 20;

/** The directory of the installed proxy, where its measurements are kept when no state directory is named. */
export const PROXY_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export class HostTimings {
  /** What this reads and asks of the rest of the proxy, and nothing else. @type {object} */
  #host;

  #firstSegmentLatencies = [];

  /**
   * Output → when the request that created it arrived, until its first segment
   * is served. Taken out on that first segment, so each output is measured once
   * and an output nobody created in this process (adopted at startup) is never
   * measured at all.
   *
   * @type {WeakMap<object, number>}
   */
  #createdAt = new WeakMap();

  /**
   * Recent times to create a session, in ms — the second term of the browser's
   * estimate. Measured for the same reason as the first: it is 116-843 ms
   * depending on whether the keyframe index is already in hand, and guessing it
   * was one of the ways the shown figure stopped describing the whole wait.
   *
   * @type {number[]}
   */
  #sessionCreateLatencies = [];

  /**
   * @param {object} host - `segmentDurationSec`, `softwarePresetBenchmark`, `stateDir`
   */
  constructor(host) {
    this.#host = host;
  }

  /**
   * Where this host's recorded timings live: `--state-dir` when the deployment
   * names one, otherwise beside the installed proxy, which is where they have
   * always been kept.
   *
   * The default is deliberately the old location and not the working directory:
   * measured on the addon, both are inside the container's writable layer and
   * both are discarded when an update rebuilds it, so moving there bought
   * nothing — while for an ordinary `npm i -g` install the working directory is
   * wherever the operator happened to launch from, which splits the history
   * between runs and drops a file into someone's project.
   *
   * A deployment that HAS a persistent directory says so: the addon passes
   * `/data`, the one path its supervisor keeps across updates. Naming it here
   * would put Home Assistant into proxy code, which this repo does not do.
   *
   * Kept so a proxy that has just restarted is not back to knowing nothing —
   * the browser was shown an assumed rate for the whole of the first wait after
   * every restart. It is meant to be TEMPORARY: if the synthetic figure tracks
   * the measured one closely enough (see #compareSyntheticWithMeasured) this
   * file can go, and every machine is then right from its first second without
   * carrying anything between runs.
   *
   * @returns {string}
   */
  #hostTimingsPath() {
    const stateDir = typeof this.#host.stateDir === "string" && this.#host.stateDir.length > 0
      ? this.#host.stateDir
      : PROXY_ROOT;
    return path.join(stateDir, "host-timings.json");
  }

  loadHostTimings() {
    try {
      const raw = JSON.parse(readFileSync(this.#hostTimingsPath(), "utf8"));
      if (Array.isArray(raw?.firstSegment)) {
        this.#firstSegmentLatencies = raw.firstSegment.filter((value) => Number.isFinite(value) && value > 0);
      }
      if (Array.isArray(raw?.sessionCreate)) {
        this.#sessionCreateLatencies = raw.sessionCreate.filter((value) => Number.isFinite(value) && value > 0);
      }
      const asMs = (value) => (value === null ? "n/a" : `${value}ms`);
      logger.info(
        `host timings loaded from ${this.#hostTimingsPath()}: ` +
        `first-segment ${asMs(this.expectedFirstSegmentMs())}, ` +
        `session-create ${asMs(this.expectedSessionCreateMs())}`
      );
    } catch {
      // No file yet, or it is unreadable. The synthetic figure answers instead.
    }
  }

  #saveHostTimings() {
    try {
      writeFileSync(this.#hostTimingsPath(), JSON.stringify({
        firstSegment: this.#firstSegmentLatencies,
        sessionCreate: this.#sessionCreateLatencies
      }));
    } catch {
      // Read-only install, no permission — not worth failing a session over.
    }
  }

  syntheticFirstSegmentMs(output = {}) {
    const benchmark = this.#host.softwarePresetBenchmark;
    if (!Array.isArray(benchmark) || benchmark.length === 0) {
      return null;
    }
    const width = Number.isFinite(output.width) && output.width > 0 ? output.width : 1920;
    const height = Number.isFinite(output.height) && output.height > 0 ? output.height : 1080;
    const fps = Number.isFinite(output.fps) && output.fps > 0 ? output.fps : TRANSCODE_FPS;
    // The preset actually chosen sits somewhere in the middle of the ladder;
    // the median entry is the representative one and involves no choice.
    const sorted = [...benchmark].sort((left, right) => left.pixelsPerSec - right.pixelsPerSec);
    const pixelsPerSec = sorted[Math.floor(sorted.length / 2)]?.pixelsPerSec;
    if (!Number.isFinite(pixelsPerSec) || pixelsPerSec <= 0) {
      return null;
    }
    const pixels = this.#host.segmentDurationSec * width * height * fps;
    return (pixels / pixelsPerSec) * 1000;
  }

  /**
   * Say how the synthetic figure compares with what actually happened.
   *
   * The point is to learn whether the startup benchmark alone can carry the
   * estimate. If the two track each other, the recorded history can go and
   * every machine is right from its first second; if they do not, the log says
   * by how much and in which direction, which is the beginning of knowing why.
   *
   * @param {number} measuredMs
   * @returns {void}
   */
  #compareSyntheticWithMeasured(measuredMs) {
    const synthetic = this.syntheticFirstSegmentMs();
    if (synthetic === null) {
      return;
    }
    const ratio = measuredMs / synthetic;
    logger.info(
      `first-segment synthetic=${Math.round(synthetic)}ms measured=${Math.round(measuredMs)}ms ` +
      `ratio=${ratio.toFixed(2)} (1.00 would mean the startup benchmark alone suffices)`
    );
  }

  rememberSessionCreateLatency(latencyMs) {
    if (!Number.isFinite(latencyMs) || latencyMs <= 0) {
      return;
    }
    this.#sessionCreateLatencies.push(latencyMs);
    if (this.#sessionCreateLatencies.length > FIRST_SEGMENT_SAMPLES) {
      this.#sessionCreateLatencies.shift();
    }
    this.#saveHostTimings();
  }

  /**
   * What this host typically takes to create a session, in ms — the median of
   * recent ones, or null before any has finished.
   *
   * @returns {number | null}
   */
  expectedSessionCreateMs() {
    if (this.#sessionCreateLatencies.length === 0) {
      return null;
    }
    const sorted = [...this.#sessionCreateLatencies].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
  }

  /**
   * An output was created by a request that arrived at `at`.
   *
   * @param {object} output
   * @param {number} at
   * @returns {void}
   */
  noteOutputCreated(output, at) {
    if (Number.isFinite(at) && at > 0) {
      this.#createdAt.set(output, at);
    }
  }

  /**
   * A segment of this output has just been served. The first one closes the
   * cold-start measurement and is remembered; every later one is nothing.
   *
   * @param {object} output
   * @param {number} [now]
   * @returns {number | null} The cold-start latency when this was the first.
   */
  noteSegmentServed(output, now = Date.now()) {
    const at = this.#createdAt.get(output);
    if (at === undefined) {
      return null;
    }
    this.#createdAt.delete(output);
    const latencyMs = now - at;
    this.rememberFirstSegmentLatency(latencyMs);
    return latencyMs;
  }

  rememberFirstSegmentLatency(latencyMs) {
    if (!Number.isFinite(latencyMs) || latencyMs <= 0) {
      return;
    }
    this.#compareSyntheticWithMeasured(latencyMs);
    this.#firstSegmentLatencies.push(latencyMs);
    if (this.#firstSegmentLatencies.length > FIRST_SEGMENT_SAMPLES) {
      this.#firstSegmentLatencies.shift();
    }
    this.#saveHostTimings();
  }

  /**
   * What this host typically takes to produce a session's first segment, in
   * milliseconds — the median of recent runs, or null before any has finished.
   *
   * @returns {number | null}
   */
  expectedFirstSegmentMs() {
    if (this.#firstSegmentLatencies.length === 0) {
      // Nothing recorded yet — a machine's first run, or one whose history has
      // not been written. The startup benchmark answers without any history at
      // all, which is why the browser was showing an assumed rate here.
      return this.syntheticFirstSegmentMs();
    }
    const sorted = [...this.#firstSegmentLatencies].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
  }
}
