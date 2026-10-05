import test from "node:test";
import assert from "node:assert/strict";
import { OutputCatalog } from "../../services/encode/output/OutputCatalog.js";

test("the catalog owns creation and access times", () => {
  let now = 100;
  const registry = new OutputCatalog({ now: () => now });
  const output = { id: "picture" };
  registry.set(output.id, output);

  now = 250;
  registry.touch(output);

  assert.equal(registry.startedAt(output), 100);
  assert.equal(registry.lastAccessedAt(output), 250);
  assert.equal("startedAt" in output, false);
  assert.equal("lastAccessedAt" in output, false);
});

test("expiry is decided from the catalog's access time", () => {
  let now = 100;
  const registry = new OutputCatalog({ now: () => now });
  registry.set("old", { id: "old" });
  now = 200;
  registry.set("fresh", { id: "fresh" });

  assert.deepEqual(registry.expiredBefore(150), ["old"]);
});

test("removal deletes both the output and its lifetime", () => {
  const registry = new OutputCatalog({ now: () => 100 });
  const output = { id: "picture" };
  registry.set(output.id, output);
  registry.delete(output.id);

  assert.equal(registry.get(output.id), undefined);
  assert.equal(registry.startedAt(output), null);
  assert.equal(registry.touch(output, 200), false);
});
