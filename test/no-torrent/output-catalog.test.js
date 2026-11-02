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

test("wait history identity is shared until the last session of an output ends", () => {
  const started = [];
  const ended = [];
  const registry = new OutputCatalog({
    waitIdentityStarted: (address, identity) => started.push([address, identity]),
    waitIdentityEnded: (address, identity) => ended.push([address, identity])
  });
  const one = { id: "one", outputKey: "out:1080" };
  const two = { id: "two", outputKey: "out:1080" };
  registry.set(one.id, one);
  const identity = registry.waitIdentity(one.id);
  registry.set(two.id, two);
  assert.equal(registry.waitIdentity(two.id), identity);
  assert.equal(started.length, 1);

  registry.delete(one.id);
  assert.equal(ended.length, 0, "another live session still owns the output identity");
  registry.delete(two.id);
  assert.deepEqual(ended, [["out:1080", identity]]);

  const reopened = { id: "reopened", outputKey: "out:1080" };
  registry.set(reopened.id, reopened);
  assert.notEqual(registry.waitIdentity(reopened.id), identity);
  registry.clear();
  assert.equal(ended.length, 2, "clear releases the remaining active identity");
});
