import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// torrent-tv/meta#284: encode/ is given the Matroska lookup, it does not import
// it. biome.json must carry no allow for codec-names.js, and no encode/ file
// may import it.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("biome.json has no allow for codec-names.js", () => {
  assert.equal(readFileSync(path.join(root, "biome.json"), "utf8").includes("codec-names"), false);
});

test("no file under services/encode imports codec-names.js", async () => {
  const { readdirSync } = await import("node:fs");
  const offenders = [];
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js") && readFileSync(full, "utf8").includes("codec-names")) {
        offenders.push(path.relative(root, full));
      }
    }
  };
  walk(path.join(root, "services/encode"));
  assert.deepEqual(offenders, []);
});
