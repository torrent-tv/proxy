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
