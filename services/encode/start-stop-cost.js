/**
 * @file What starting and stopping an encoder costs on THIS host, measured
 * before any viewer exists.
 *
 * WHY IT HAS TO BE MEASURED AT STARTUP. Both figures decide one thing: whether
 * to leave an encoder where it stands or kill it and start another elsewhere.
 * The plan compares when the wanted pieces appear under each arrangement, and
 * for that it needs how long a fresh encoder takes to produce anything and how
 * long killing one takes.
 *
 * Until now both were learned only from runs that had ENDED, so at a cold open
 * they were zero — and zero does not read as "not measured", it reads as
 * "free". A warming encoder then owed one piece and a moved one owed
 * `0 + 0 + one piece`: the same figure to the millisecond. The tie fell to
 * position, so any advantage however small won, and the plan moved the encoder
 * on every pass. Field 2026-09-08, the first fifteen seconds of a session:
 * start at #68, a second later kill and start at #69, half a second later kill
 * and start at #68 again, each dying having produced nothing. Over two days,
 * 153 runs stopped that way and 68 of them made no segment at all.
 *
 * ONE RUN GIVES BOTH READINGS. An encoder is started on a generated picture
 * through the same pipeline a session uses, timed until it says it has closed
 * its first piece, then killed and timed until it exits. Nothing about the
 * measurement is chosen: it is the same encoder, the same muxer, the same
 * channel the encoder announces finished pieces on.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * How long the measurement may take before it is abandoned.
 *
 * Not a property of the host and not a figure anything is derived from: it
 * bounds a startup step so a machine that cannot produce a piece at all does not
 * hold the proxy closed. A host that hits it has said something useful — that
 * its first piece takes longer than this — and the plan is told the bound rather
 * than a zero.
 */
const GIVE_UP_AFTER_MS = 30_000;

/**
 * Measure a start and a stop on this host.
 *
 * @param {object} params
 * @param {string} params.ffmpegBin
 * @param {import("./Encoder.js").Encoder} params.encoder - The encoder this
 *   proxy has chosen, so the reading is of the thing that will actually run.
 * @param {number} [params.segmentDurationSec]
 * @param {{ info: Function, warn: Function }} [params.logger]
 * @param {() => number} [params.now]
 * @returns {Promise<{ firstByteWaitSec: number, killCostSec: number } | null>}
 *   Null where nothing could be measured, which is said rather than passed off
 *   as a zero.
 */
export async function measureStartAndStop({
  ffmpegBin,
  encoder,
  segmentDurationSec = 4,
  logger = null,
  now = Date.now
}) {
  const log = logger ?? { info: () => {}, warn: () => {} };
  const dir = mkdtempSync(path.join(os.tmpdir(), "tt-startstop-"));
  try {
    const args = [
      "-hide_banner",
      "-nostats",
      "-loglevel",
      "error",
      // A generated picture: the reading is of this host's encoder and muxer,
      // and a file would add its own reading and its own download.
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=640x360:rate=25`,
      "-t",
      String(segmentDurationSec * 4),
      // The encoder this proxy has chosen, asked for its own arguments: the
      // reading must be of the thing that will actually run, since what a start
      // costs is mostly the encoder opening.
      ...(typeof encoder?.buildVideoArgs === "function"
        ? encoder.buildVideoArgs({ targetWidth: 640, targetHeight: 360, segmentDurationSec, fps: 25 })
        : ["-c:v", "libx264", "-preset", "ultrafast"]),
      "-an",
      "-f",
      "segment",
      "-segment_time",
      String(segmentDurationSec),
      // The channel the encoder names its finished pieces on — the same one a
      // session reads, so "the first piece exists" means here what it means
      // there.
      "-segment_list",
      "pipe:3",
      "-segment_list_flags",
      "+live",
      "-segment_format",
      "mp4",
      path.join(dir, "seg-%05d.mp4")
    ];

    const spawnedAt = now();
    const child = spawn(ffmpegBin, args, {
      stdio: ["ignore", "ignore", "pipe", "pipe"],
      windowsHide: true
    });

    const firstPiece = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), GIVE_UP_AFTER_MS);
      timer.unref?.();
      child.stdio?.[3]?.on("data", () => {
        clearTimeout(timer);
        resolve(now() - spawnedAt);
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.on("exit", () => {
        clearTimeout(timer);
        resolve(null);
      });
    });

    if (firstPiece === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      log.warn("hwaccel: a start could not be measured; the plan is told so rather than told zero");
      return null;
    }

    const killedAt = now();
    const died = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), GIVE_UP_AFTER_MS);
      timer.unref?.();
      child.on("exit", () => {
        clearTimeout(timer);
        resolve(now() - killedAt);
      });
      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(timer);
        resolve(null);
      }
    });

    const firstByteWaitSec = firstPiece / 1000;
    const killCostSec = died === null ? 0 : died / 1000;
    log.info(
      `hwaccel: a start costs ${firstByteWaitSec.toFixed(2)}s to a first piece and ` +
      `a stop ${killCostSec.toFixed(2)}s on this host — measured before any viewer, ` +
      "because a plan told zero reads it as free and moves an encoder for nothing"
    );
    return { firstByteWaitSec, killCostSec };
  } catch (error) {
    log.warn(
      `hwaccel: a start and a stop could not be measured: ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}
