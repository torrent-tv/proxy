/**
 * @file How long material nobody is using is kept, and where that number comes
 * from.
 *
 * It was three numbers and they contradicted each other: a torrent went at
 * fifteen minutes while the session it feeds lived to thirty, so between them
 * there was a session with no source. All three stand for one unmeasured thing
 * — whether the viewer comes back — so they are one number now, and the thing
 * they stand for is being measured.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { IDLE_KEEP_MS } from "../services/disk/keep.js";
import { Returns } from "../services/disk/returns.js";

const MINUTE = 60 * 1000;

test("material outlives the session that reads it", () => {
  // The contradiction this replaced, stated as the rule it must never break
  // again: whatever holds a source must not go while something that reads it
  // is still alive. The session's own period is thirty minutes.
  const SESSION_TTL_MS = 30 * MINUTE;
  assert.ok(
    IDLE_KEEP_MS > SESSION_TTL_MS,
    "a session would outlive its own source again: material is kept " +
      `${IDLE_KEEP_MS / MINUTE}min against a session's ${SESSION_TTL_MS / MINUTE}min`
  );
});

test("one number, and both kinds of material read it", async () => {
  // Two guesses about one unknown is what produced the contradiction. Asserted
  // on the source: a second literal period appearing anywhere is the fault
  // coming back.
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const read = (relative) => readFileSync(path.join(here, "..", relative), "utf8");

  assert.match(read("services/torrent-pool.js"), /TORRENT_IDLE_TTL_MS = IDLE_KEEP_MS/);
  assert.match(read("services/hls-session-manager.js"), /SEGMENT_STORE_IDLE_MS = IDLE_KEEP_MS/);
});

test("a session opened on material still held is a return, and its age is kept", () => {
  const returns = new Returns();
  const now = 10 * 60 * MINUTE;

  returns.note({ lastReadAt: now - 5 * MINUTE, now });
  returns.note({ lastReadAt: now - 45 * MINUTE, now });
  returns.note({ lastReadAt: now - 20 * MINUTE, now });

  const shape = returns.shape();
  assert.equal(shape.warm, 3);
  assert.equal(shape.cold, 0);
  assert.equal(shape.medianMs, 20 * MINUTE, "the middle return is not the median");
  assert.equal(shape.longestMs, 45 * MINUTE);
});

test("a session opened on material this proxy never had is not a return", () => {
  const returns = new Returns();
  const now = 10 * 60 * MINUTE;

  returns.note({ lastReadAt: null, now });
  returns.note({ lastReadAt: 0, now });

  assert.equal(returns.shape(), null, "an opening with nothing behind it was counted as a return");
});

test("the reading says what viewers do beside what is being kept", () => {
  const returns = new Returns();
  const now = 10 * 60 * MINUTE;
  assert.equal(returns.describe(IDLE_KEEP_MS), null, "it spoke before it had anything to say");

  returns.note({ lastReadAt: now - 12 * MINUTE, now });
  returns.note({ lastReadAt: null, now });

  const line = returns.describe(IDLE_KEEP_MS);
  assert.match(line, /1 session\(s\) opened on material still held/);
  assert.match(line, /1 on material gone/);
  assert.match(line, /median 12min after the last read/);
  assert.match(line, /kept for 60min/);
});
