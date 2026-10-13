import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import ffmpegBin from "ffmpeg-static";
import { inputCacheRoot, probeInputCache } from "../../services/encode/input-cache.js";

// The proxy's own FFmpeg and a generated file only; no torrent imports.

/** A process that writes `message` to stderr and exits with `code`. */
function finishing(code, message = "") {
  return () => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      if (message) child.stderr.emit("data", Buffer.from(message));
      child.emit("close", code);
    });
    return child;
  };
}

test("a read through FFmpeg's cache that completes makes the cache available", async () => {
  const probed = await probeInputCache({ ffmpegBin });
  assert.deepEqual(probed, { available: true, reason: "a read through it completed" });
});

test("a cache whose temporary file cannot be opened reads the input directly", async () => {
  // What FFmpeg 8.1.2 said on Home Assistant with a read-only root.
  const probed = await probeInputCache({ ffmpegBin: "ffmpeg", spawn: finishing(226,
    "[cache @ 0x7fba7e1f20] [TEMPFILE @ 0x7fc5068590] ff_tempfile: Cannot open temporary file /tmp/ffcacheXXXXXX\n" +
    "Error opening input files: Read-only file system\n") });
  assert.equal(probed.available, false);
  assert.equal(probed.reason, "FFmpeg exited 226: Error opening input files: Read-only file system");
});

test("an FFmpeg that does not start leaves the cache unavailable", async () => {
  const probed = await probeInputCache({ ffmpegBin: "ffmpeg", spawn: () => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => child.emit("error", new Error("spawn ffmpeg ENOENT")));
    return child;
  } });
  assert.deepEqual(probed, { available: false, reason: "FFmpeg did not start: spawn ffmpeg ENOENT" });
});

test("the cache's file is counted on /tmp where FFmpeg opens it with mkstemp, else where FFmpeg runs", () => {
  assert.equal(inputCacheRoot("linux"), "/tmp");
  assert.equal(inputCacheRoot("darwin"), "/tmp");
  assert.equal(inputCacheRoot("win32"), null);
  assert.equal(inputCacheRoot("android"), null);
});
