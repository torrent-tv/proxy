/** Short startup measurements of packaged audio samples. */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { AUDIO_TRANSCODE_KBPS } from "./args.js";
import { ENCODE_BENCHMARK_TIMEOUT_MS } from "./hwaccel.js";

const SAMPLE_DIRECTORY = fileURLToPath(new URL("../../assets/calibration/audio/", import.meta.url));

function measure(ffmpegBin, file, operation, signal) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    let mediaSeconds = 0;
    let text = "";
    let diagnostics = "";
    const child = spawn(ffmpegBin, ["-hide_banner", "-loglevel", "info", "-nostats", "-benchmark",
      "-i", file, "-map", "0:a:0", "-vn", "-c:a", operation,
      ...(operation === "aac" ? ["-b:a", `${AUDIO_TRANSCODE_KBPS}k`, "-ac", "2"] : []),
      "-f", "null", "-", "-progress", "pipe:1"],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(ENCODE_BENCHMARK_TIMEOUT_MS)]) :
        AbortSignal.timeout(ENCODE_BENCHMARK_TIMEOUT_MS) });
    child.stdout.on("data", (data) => {
      text += String(data);
      const rows = text.split("\n");
      text = rows.pop();
      for (const row of rows) {
        if (row.startsWith("out_time_us=")) {
          const value = Number(row.slice("out_time_us=".length)) / 1e6;
          if (Number.isFinite(value) && value > 0) mediaSeconds = value;
        }
      }
    });
    child.stderr.on("data", (data) => { diagnostics += String(data); });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      const elapsed = (performance.now() - startedAt) / 1000;
      const runtime = diagnostics.match(/bench:.*rtime=(\d+\.(\d+))s/);
      // The reported decimal precision bounds timing uncertainty, including a
      // runtime printed as zero. This is a clock-resolution bound, not a weight.
      const processingSeconds = runtime ? Number(runtime[1]) + 10 ** -runtime[2].length : null;
      resolve(code === 0 && mediaSeconds > 0 && processingSeconds > 0 ?
        { speed: mediaSeconds / processingSeconds, work: mediaSeconds, elapsed, processingSeconds,
          startupSeconds: Math.max(0, elapsed - processingSeconds) } : null);
    });
  });
}

export async function benchmarkAudio({ ffmpegBin, logger, signal, sampleDirectory = SAMPLE_DIRECTORY }) {
  const samples = JSON.parse(await readFile(path.join(sampleDirectory, "manifest.json"), "utf8"));
  const readings = [];
  const startedAt = performance.now();
  for (const sample of samples) {
    for (const operation of ["copy", "aac"]) {
      if (signal?.aborted) return readings;
      const reading = await measure(ffmpegBin, path.join(sampleDirectory, sample.file), operation, signal);
      if (reading) readings.push({ ...sample, operation, ...reading });
      else logger?.warn(`audio calibration ${sample.codec}->${operation} could not be measured`);
    }
  }
  logger?.info(`audio calibration: ${readings.length} short packaged-sample measurements in ` +
    `${((performance.now() - startedAt) / 1000).toFixed(2)}s`);
  return readings;
}

export { audioReadingFor } from "./audio-work-rate.js";
