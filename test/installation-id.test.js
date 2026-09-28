import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { installationId } from "../services/identity/installation-id.js";

test("an installation id is reused from its state directory", (t) => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "proxy-identity-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));

  assert.equal(installationId({ stateDir, makeId: () => "first-id" }), "first-id");
  assert.equal(installationId({ stateDir, makeId: () => "unexpected-id" }), "first-id");
  assert.deepEqual(JSON.parse(readFileSync(path.join(stateDir, "proxy-identity.json"), "utf8")), { id: "first-id" });
});

test("an explicit id takes precedence and becomes the saved installation id", (t) => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "proxy-identity-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));

  assert.equal(installationId({ stateDir, explicitId: " configured-id " }), "configured-id");
  assert.equal(installationId({ stateDir, makeId: () => "unexpected-id" }), "configured-id");
});

test("without a state directory the default id stays ephemeral", () => {
  let calls = 0;
  const makeId = () => `id-${++calls}`;

  assert.equal(installationId({ makeId }), "id-1");
  assert.equal(installationId({ makeId }), "id-2");
});

test("a damaged saved identity is reported instead of silently replaced", (t) => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "proxy-identity-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  writeFileSync(path.join(stateDir, "proxy-identity.json"), "{}\n");

  assert.throws(() => installationId({ stateDir, makeId: () => "replacement" }), /Invalid proxy identity file/);
});
