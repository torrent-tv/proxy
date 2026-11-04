import assert from "node:assert/strict";
import test from "node:test";
import { scheduleStartupWork } from "../../services/viewer/startup-work.js";

const service = (key, unit, rate) => ({ key, unit, rate });

test("a known cache hit contributes zero remaining work", () => {
  const result = scheduleStartupWork([
    { id: "P2", kind: "work", state: "complete" },
    { id: "P3", kind: "work", state: "pending", remainingWork: { amount: 4, unit: "plan-fields" },
      service: service("proxy-main", "plan-fields", 2), dependsOn: ["P2"] }
  ]);

  assert.equal(result.reason, null);
  assert.equal(result.finishSeconds, 2);
  assert.equal(result.atoms[0].finishSeconds, 0);
});

test("missing source bytes use the matching measured byte service", () => {
  const result = scheduleStartupWork([
    { id: "W8", kind: "work", state: "pending", remainingWork: { amount: 300, unit: "bytes" },
      service: service("torrent:source", "bytes", 100) }
  ]);

  assert.equal(result.reason, null);
  assert.equal(result.finishSeconds, 3);
});

test("an inapplicable absent index is skipped while a required unknown index is named", () => {
  const skipped = scheduleStartupWork([
    { id: "P5", kind: "work", enabled: false, state: "pending" }
  ]);
  const required = scheduleStartupWork([
    { id: "P5", kind: "work", state: "pending", remainingWork: { amount: 1, unit: "index-bytes" } }
  ]);

  assert.equal(skipped.finishSeconds, 0);
  assert.equal(skipped.reason, null);
  assert.equal(required.finishSeconds, null);
  assert.equal(required.reason, "startup-work-service-unknown:P5");
  assert.deepEqual(required.unknownAtoms, ["P5"]);
});

test("a retry is extra work under the same original action", () => {
  const result = scheduleStartupWork([
    { id: "A2.1/attempt-0", actionId: "open-1", kind: "work", state: "complete" },
    { id: "A2.1/attempt-1", actionId: "open-1", kind: "work", state: "pending",
      remainingWork: { amount: 2, unit: "requests" }, service: service("browser-control", "requests", 1),
      dependsOn: ["A2.1/attempt-0"] }
  ]);

  assert.equal(result.finishSeconds, 2);
  assert.deepEqual(result.atoms.map(atom => atom.id), ["A2.1/attempt-0", "A2.1/attempt-1"]);
});

test("pending viewer permission is an external wait and has no numeric completion", () => {
  const result = scheduleStartupWork([
    { id: "A2.4.3", kind: "external-wait", state: "pending" }
  ]);

  assert.equal(result.finishSeconds, null);
  assert.equal(result.reason, "startup-external-wait:A2.4.3");
  assert.deepEqual(result.unknownAtoms, ["A2.4.3"]);
});

test("measured matching work and service are scheduled once with true predecessors", () => {
  const result = scheduleStartupWork([
    { id: "P2", kind: "work", state: "pending", remainingWork: { amount: 1, unit: "read-units" },
      service: service("file-read", "read-units", 2) },
    { id: "P3", kind: "work", state: "pending", remainingWork: { amount: 9, unit: "read-units" },
      service: service("file-read", "read-units", 2), dependsOn: ["P2"] },
    { id: "A12", kind: "envelope", children: ["P2", "P3"] }
  ]);

  assert.equal(result.reason, null);
  assert.ok(Math.abs(result.finishSeconds - 5) < 1e-9);
  assert.equal(result.atoms[2].state, "non-work");
});

test("one shared service cannot silently mix incompatible rate captures", () => {
  const result = scheduleStartupWork([
    { id: "P2", kind: "work", state: "pending", remainingWork: { amount: 1, unit: "read-units" },
      service: service("file-read", "read-units", 1) },
    { id: "P3", kind: "work", state: "pending", remainingWork: { amount: 9, unit: "read-units" },
      service: service("file-read", "read-units", 3), dependsOn: ["P2"] }
  ]);

  assert.equal(result.finishSeconds, null);
  assert.equal(result.reason, "startup-work-service-mismatch:P3");
  assert.deepEqual(result.unknownAtoms, ["P3"]);
});

test("missing opening records name the atoms whose work and service are unknown", () => {
  const result = scheduleStartupWork(null);

  assert.equal(result.finishSeconds, null);
  assert.equal(result.reason, "startup-work-records-unavailable");
  assert.ok(result.unknownAtoms.includes("A2.4.3"));
  assert.ok(result.unknownAtoms.includes("P5"));
});
