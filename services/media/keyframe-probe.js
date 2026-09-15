/**
 * @file Where a file's keyframes are, found by DECODING it rather than by
 * reading what its container states.
 *
 * The SECOND reader of one fact, and the weaker of the two: the container's own
 * index is two point reads of 16 KB and names every keyframe, while this scans
 * the media over a torrent-backed input and on a large file often does not
 * finish — measured 2026-08-02, 77 keyframes in 45 s against all 570 in 0.8 s
 * from the index. So it is never waited for and never displaces an index that
 * answered; `KeyframeTable.learn` keeps the fuller answer whichever arrives
 * second.
 *
 * It exists because some containers state no index at all, and a keyframe is
 * still needed for something both encode branches need: choosing a SOURCE seek
 * position ffmpeg can land on. `-ss` before `-i` trusts the container's
 * on-the-fly seek, which for some containers (observed: AVI with VBR MP3 audio)
 * can point at a position with no valid frame boundary at all — ffmpeg then
 * fails outright ("Seek failed" / "Header missing"), not merely imprecisely.
 *
 * **Why it is here and not in `container/`.** It runs a process and reads the
 * file over the address this proxy serves it at. A container is built from four
 * functions and takes byte ranges; it spawns nothing and knows no URL. Both are
 * readings of the same file, so both are this layer's — and they are separate
 * files because one of them needs a machine and the other needs sixteen
 * kilobytes.
 */

import { spawn } from "node:child_process";

/**
 * The ffprobe that sits beside a given ffmpeg.
 *
 * @param {string} ffmpegBin
 * @returns {string}
 */
export function ffprobeBinFor(ffmpegBin) {
  if (typeof ffmpegBin !== "string" || ffmpegBin.length === 0) {
    return "ffprobe";
  }
  if (/ffmpeg(\.exe)?$/i.test(ffmpegBin)) {
    return ffmpegBin.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
  }
  return "ffprobe";
}

/**
 * Where this file's keyframes are, found by DECODING it rather than by reading
 * what its container states.
 *
 * The second reader of one fact, and the weaker of the two: the container's own
 * index is two point reads of 16 KB and names every keyframe, while this scans
 * the media over a torrent-backed input and on a large file often does not
 * finish — measured 2026-08-02, 77 keyframes in 45 s against all 570 in 0.8 s
 * from the index. So it is never waited for and never displaces an index that
 * answered; `KeyframeTable.learn` keeps the fuller answer whichever arrives
 * second.
 *
 * It exists because some containers state no index at all, and a keyframe is
 * still needed for something both branches need: choosing a SOURCE seek
 * position ffmpeg can land on. `-ss` before `-i` trusts the container's
 * on-the-fly seek, which for some containers (observed: AVI with VBR MP3 audio)
 * can point at a position with no valid frame boundary at all — ffmpeg then
 * fails outright ("Seek failed" / "Header missing"), not merely imprecisely.
 *
 * It lives here, beside the codec probe, because it is the same kind of thing:
 * a reading of the file made by running ffmpeg's own tools over the address
 * this proxy serves it at. The container layer takes byte ranges and spawns
 * nothing.
 *
 * @param {string} ffmpegBin
 * @param {string | URL} inputUrl
 * @param {number} [timeoutMs]
 * @returns {Promise<number[] | null>} Sorted keyframe times, or null.
 */
export async function probeVideoKeyframeTimes(ffmpegBin, inputUrl, timeoutMs = 25_000) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(
        ffprobeBinFor(ffmpegBin),
        [
          "-v", "error",
          // `-skip_frame nokey` makes the decoder discard non-keyframes, so the
          // probe reads only what it needs. Without it a full packet scan of a
          // ~5 GB MKV cannot finish inside any sane budget over a torrent-backed
          // input, the probe returns nothing, and the playlist falls back to a
          // uniform grid — which on the COPY path is a lie: cuts land on the
          // source's real keyframes, not on a 4 s ruler. The player then finds
          // the declared times do not match the media, stops trusting the
          // playlist and walks the file from segment #1 to locate the seek
          // position by hand (field 2026-08-02: a seek to 1:30 produced requests
          // #1, #2, #45, #86, #123 … #1187, taking minutes and never arriving).
          "-skip_frame", "nokey",
          "-select_streams", "v:0",
          "-show_entries", "packet=pts_time,flags",
          "-of", "csv=p=0",
          String(inputUrl)
        ],
        { stdio: ["ignore", "pipe", "ignore"], windowsHide: true }
      );
    } catch {
      resolve(null);
      return;
    }
    let stdout = "";
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        if (!proc.killed) {
          proc.kill("SIGTERM");
        }
      } catch {
        // ignore
      }
      finish(null);
    }, timeoutMs);
    proc.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    proc.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        finish(null);
        return;
      }
      const times = [];
      for (const line of stdout.split("\n")) {
        // Each line: "<pts_time>,<flags>" e.g. "12.345000,K__"
        const comma = line.indexOf(",");
        if (comma < 0) {
          continue;
        }
        const flags = line.slice(comma + 1);
        if (!flags.includes("K")) {
          continue;
        }
        const t = Number(line.slice(0, comma));
        if (Number.isFinite(t)) {
          times.push(t);
        }
      }
      times.sort((a, b) => a - b);
      finish(times.length > 0 ? times : null);
    });
  });
}
