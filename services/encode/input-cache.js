/**
 * @file Whether this machine's FFmpeg can read an encoder's input through its
 * `cache:` protocol, and on which directory's disk that cache lies.
 *
 * FFmpeg's cache (libavformat/cache.c) keeps what it has read in a temporary
 * file opened by `avpriv_tempfile`, and a Linux build can only open that file
 * in /tmp (libavutil/file_open.c n8.1, `mkstemp`); a Windows or Android build
 * opens it where FFmpeg runs. Where no /tmp can be written, every run reading
 * through the cache fails at its open — checked on Home Assistant with a
 * read-only root: "ff_tempfile: Cannot open temporary file
 * /tmp/ffcacheXXXXXX", while the same file read directly opened. So one small
 * read through the cache is tried at startup with this proxy's own FFmpeg, and
 * until it has succeeded an input is read directly (torrent-tv/meta#178).
 */

import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Where FFmpeg keeps its cache's file: /tmp on a build that uses `mkstemp`,
 * else where FFmpeg runs, which for a run is a directory of the segments.
 *
 * @param {string} [platform]
 * @returns {string | null} null for the segments' own directory.
 */
export function inputCacheRoot(platform = process.platform) {
  return platform === "win32" || platform === "android" ? null : "/tmp";
}

/**
 * Read a small file through FFmpeg's cache once.
 *
 * @param {object} params
 * @param {string} params.ffmpegBin
 * @param {typeof nodeSpawn} [params.spawn]
 * @param {string} [params.scratch] - Where the file read is written.
 * @returns {Promise<{ available: boolean, reason: string }>}
 */
export async function probeInputCache({ ffmpegBin, spawn = nodeSpawn, scratch = os.tmpdir() }) {
  let directory = null;
  try {
    directory = await mkdtemp(path.join(scratch, "ttv-input-cache-"));
    const file = path.join(directory, "input.bin");
    await writeFile(file, randomBytes(64 * 1024));
    const { code, error } = await new Promise((resolve) => {
      let stderr = "";
      const child = spawn(ffmpegBin, ["-v", "error", "-nostdin", "-f", "data", "-i", `cache:file:${file}`,
        "-map", "0", "-c", "copy", "-f", "null", "-"], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      child.stderr?.on("data", (chunk) => { stderr += chunk; });
      child.once("error", (failure) => resolve({ code: null, error: failure.message }));
      child.once("close", (exitCode) => resolve({ code: exitCode, error: stderr.trim().split(/\r?\n/).pop() ?? "" }));
    });
    return code === 0 ? { available: true, reason: "a read through it completed" }
      : { available: false, reason: `FFmpeg ${code === null ? "did not start" : `exited ${code}`}: ${error || "no message"}` };
  } catch (error) {
    return { available: false, reason: `the file to read could not be prepared: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
