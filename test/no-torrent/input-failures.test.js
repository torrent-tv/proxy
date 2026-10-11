import test from "node:test";
import assert from "node:assert/strict";
import { InputFailures, failedAdmittedInput } from "../../services/encode/InputFailures.js";

test("resource, process and hardware failures do not condemn unchanged input", () => {
  const invalid = { ending: "failed", code: 1, signal: null, because: "invalid data found when processing input" };
  assert.equal(failedAdmittedInput(invalid), true);
  assert.equal(failedAdmittedInput({ ...invalid, ending: "short", code: 0 }), true);
  assert.equal(failedAdmittedInput(invalid, true), false);
  assert.equal(failedAdmittedInput({ ...invalid, code: null, because: "the process could not be started: ENOENT" }), false);
  assert.equal(failedAdmittedInput({ ...invalid, signal: "SIGKILL" }), false);
  assert.equal(failedAdmittedInput({ ...invalid, ending: "input-lost" }), false);
  for (const because of ["Cannot allocate memory", "No space left on device", "Resource temporarily unavailable", "Too many open files"]) {
    assert.equal(failedAdmittedInput({ ...invalid, because }), false);
  }
});

test("failed admitted input is refused only while its bytes and parameters agree", () => {
  const failures = new InputFailures();
  const parameters = { outputKey: "output", encoder: "libx264", width: 640, height: 360, fps: 25 };
  const key = failures.key({ fingerprint: "original" }, parameters);
  failures.note("output", 4, key, "invalid decode input");
  assert.equal(failures.failure("output", 4, key), "invalid decode input");
  assert.equal(failures.reason("output"), "invalid decode input");
  assert.equal(failures.failure("output", 5, key), null);
  assert.equal(failures.failure("another", 4, key), null);
  assert.equal(failures.failure("output", 4, failures.key({ fingerprint: "changed" }, parameters)), null);
  assert.equal(failures.reason("output"), null);
  failures.note("output", 4, key, "invalid decode input");
  assert.equal(failures.failure("output", 4, failures.key({ fingerprint: "original" }, { ...parameters, encoder: "h264_nvenc" })), null);
  failures.forget("output");
  assert.equal(failures.failure("output", 4, key), null);
});

test("incomplete media is not retried after publication refusal, while storage failures remain recoverable", () => {
  const ended = { ending: "publication-failed", code: 255, signal: "SIGTERM", publicationCode: "ERR_INCOMPLETE_MEDIA" };
  assert.equal(failedAdmittedInput(ended), true);
  assert.equal(failedAdmittedInput(ended, true), false);
  assert.equal(failedAdmittedInput({ ...ended, publicationCode: "ENOSPC" }), false);
  assert.equal(failedAdmittedInput({ ...ended, publicationCode: null }), false);
});

test("a piece of a longer input that failed is made again from an input holding it alone, and only that failure is final", () => {
  const failures = new InputFailures();
  // Run #314..#319 refused its piece 316 (field 2026-10-11, torrent-tv/meta#178).
  failures.note("output", 316, "stretch-314-319", "Closed piece #316 has incomplete media.", { pieces: 6 });
  assert.equal(failures.reason("output"), null, "production has not ended");
  assert.equal(failures.retrying("output"), true);
  // A run at the piece holds it alone; a run before it stops before it.
  assert.equal(failures.boundFor("output", 316, 945), 316);
  assert.equal(failures.boundFor("output", 314, 945), 315);
  assert.equal(failures.boundFor("output", 317, 945), 945);
  assert.equal(failures.boundFor("another", 316, 945), 945);
  // The input holding it alone is another input: admitting it clears the wait.
  assert.equal(failures.failure("output", 316, "alone-316"), null);
  assert.equal(failures.retrying("output"), false);
  // Its failure is final.
  failures.note("output", 316, "alone-316", "Closed piece #316 has incomplete media.", { pieces: 1 });
  assert.equal(failures.reason("output"), "Closed piece #316 has incomplete media.");
  assert.equal(failures.retrying("output"), false);
  assert.equal(failures.boundFor("output", 314, 945), 945);
});
