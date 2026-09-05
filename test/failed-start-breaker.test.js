/**
 * @file A start that cannot succeed must not be commanded for ever.
 *
 * Two defects met here on 2026-09-05, and only together did they produce an
 * unbounded loop.
 *
 * The first is older than the second and had never once run: `#onRunEnded`
 * removed the run from the session and THEN asked whether the run was still the
 * session's, a question that always answers "no" after the removal. Everything
 * below that point was unreachable — the fallback from a failed hardware
 * encoder to software, the retry when the torrent data goes away, the limit on
 * retrying a position that keeps failing, and the error line naming the ffmpeg
 * command. Measured over both of the field host's log files: zero occurrences
 * of that error line and zero of `fast failure at segment`, across every
 * session that proxy had ever run.
 *
 * The second is that the limit only counted past segment #0, because it was
 * written for seek restarts and a seek is never to the beginning — leaving the
 * one position the plan commands first with no count at all.
 *
 * With what encoders should exist re-decided on a five-second timer, the two
 * showed up as a restart every five seconds, for sixteen minutes, in the field.
 * Re-decided the moment its inputs change, they show up as a loop as fast as
 * spawning can fail: fifty passes of the plan before a probe stopped it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HlsSessionManager } from "../services/hls-session-manager.js";
import { SourceFile } from "../services/source/SourceFile.js";
import { ENCODE_EXIT } from "../services/encode/encode-exit.js";

const SESSION_ID = "cccccccc-0000-4000-8000-000000000001";

/**
 * A session with one run in it, shaped as the manager expects.
 *
 * @param {string} dirPath
 * @returns {{ session: object, run: object }}
 */
function sessionWithARun(dirPath) {
  const run = { from: 0, to: -1, argsDescribed: "ffmpeg …", state: "ENDED_FAILED" };
  const session = {
    id: SESSION_ID,
    dirPath,
    state: "live",
    file: new SourceFile({ sourceKey: "source-1", fileIndex: 0, name: "video.mkv" }),
    get inputFile() { return this.file; },
    get audioFile() { return this.file; },
    outputKey: "output-under-test",
    consumers: new Set(["someone"]),
    viewers: new Map(),
    runs: new Set([run]),
    transcodeVideo: false,
    failedStartAt: -1,
    failedStartCount: 0,
    lastError: "",
    lastRequestedSegment: 0,
    progress: { updatedAt: 0, processedSeconds: 0, totalSeconds: 100, startPositionSeconds: 0 },
    lastAccessedAt: Date.now()
  };
  return { session, run };
}

/**
 * @param {object} run
 * @param {number} from
 * @returns {object}
 */
function failedFast(run, from) {
  return {
    address: "output-under-test",
    run,
    ending: ENCODE_EXIT.FAILED,
    from,
    to: -1,
    livedMs: 20,
    because: "the process could not be started: spawn ffmpeg ENOENT",
    lastError: "the process could not be started: spawn ffmpeg ENOENT",
    producedCount: 0
  };
}

test("a run that ended is still recognised as the session's own", (t) => {
  const dirPath = mkdtempSync(path.join(os.tmpdir(), "breaker-"));
  t.after(() => rmSync(dirPath, { recursive: true, force: true }));
  const manager = new HlsSessionManager({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090
  });
  const { session, run } = sessionWithARun(dirPath);
  manager.sessionsById.set(SESSION_ID, session);

  manager.noteRunEnded(session, run, failedFast(run, 0));

  // If the identity were read after the removal, nothing here would have been
  // written: the handler would have returned at its second line.
  assert.equal(session.failedStartCount, 1, "the failure was counted");
  assert.equal(session.failedStartAt, 0, "at the position it happened");
  assert.ok(session.lastError.length > 0, "and the session knows what went wrong");
});

test("the count runs at segment 0, which is where a first start happens", (t) => {
  const dirPath = mkdtempSync(path.join(os.tmpdir(), "breaker-"));
  t.after(() => rmSync(dirPath, { recursive: true, force: true }));
  const manager = new HlsSessionManager({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090
  });
  const { session } = sessionWithARun(dirPath);
  manager.sessionsById.set(SESSION_ID, session);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const run = { from: 0, to: -1, argsDescribed: "ffmpeg …" };
    session.runs.add(run);
    manager.noteRunEnded(session, run, failedFast(run, 0));
    assert.equal(session.failedStartCount, attempt);
  }
});

test("real work resets the count, so a transient failure is not permanent", (t) => {
  const dirPath = mkdtempSync(path.join(os.tmpdir(), "breaker-"));
  t.after(() => rmSync(dirPath, { recursive: true, force: true }));
  const manager = new HlsSessionManager({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090
  });
  const { session } = sessionWithARun(dirPath);
  manager.sessionsById.set(SESSION_ID, session);

  const quick = { from: 0, to: -1 };
  session.runs.add(quick);
  manager.noteRunEnded(session, quick, failedFast(quick, 0));
  assert.equal(session.failedStartCount, 1);

  const lived = { from: 0, to: -1 };
  session.runs.add(lived);
  manager.noteRunEnded(session, lived, { ...failedFast(lived, 0), livedMs: 30_000 });

  assert.equal(session.failedStartCount, 0, "a run that did real work is not a failing start");
  assert.equal(session.failedStartAt, -1);
});
