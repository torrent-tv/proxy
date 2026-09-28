import assert from "node:assert/strict";
import test from "node:test";
import { createSourceRegistry } from "../store/source-registry.js";

const infoHash = "0123456789abcdef0123456789abcdef01234567";

test("magnet links for one torrent share a source key", async () => {
  const registry = createSourceRegistry();
  const first = `magnet:?xt=urn:btih:${infoHash}&dn=First+name&tr=udp%3A%2F%2Ftracker.one%3A80`;
  const second = `magnet:?xt=urn:btih:${infoHash}&dn=Different+name&tr=udp%3A%2F%2Ftracker.two%3A80`;

  const firstKey = await registry.upsert("magnet", first);
  const secondKey = await registry.upsert("magnet", second);

  assert.equal(firstKey, `torrent:${infoHash}`);
  assert.equal(secondKey, firstKey);
  assert.equal(registry.get(firstKey)?.source, second);
});
