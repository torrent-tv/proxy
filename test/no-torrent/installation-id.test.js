import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { installationId } from "../../services/identity/installation-id.js";
import { logger } from "../../utils/logger.js";

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

test("an unwritable state directory warns once and keeps the minted id for the process lifetime", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "proxy-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // A path below a regular file cannot be created, even by root (mkdirSync throws ENOTDIR).
  const blocker = path.join(root, "blocker");
  writeFileSync(blocker, "not a directory");
  const stateDir = path.join(blocker, "state");
  const warn = mock.method(logger, "warn", () => {});
  t.after(() => warn.mock.restore());

  let calls = 0;
  const makeId = () => `minted-${++calls}`;
  let first;
  assert.doesNotThrow(() => { first = installationId({ stateDir, makeId }); });
  assert.equal(first, "minted-1");
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /proxy-identity|state/i);

  assert.equal(installationId({ stateDir, makeId }), first);
  assert.equal(calls, 1, "the second call must reuse the id minted in this process");
  assert.equal(warn.mock.callCount(), 1, "the warning is logged once, not on every call");
});
