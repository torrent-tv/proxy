import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { jsFilesUnder, sourceOf } from "./helpers/source-text.js";

// torrent-tv/meta#284: encode/ is given the Matroska lookup, it does not import
// it. biome.json must carry no allow for codec-names.js, and no encode/ file
// may import it.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("biome.json has no allow for codec-names.js", () => {
  assert.equal(sourceOf("biome.json").includes("codec-names"), false);
});

test("no file under services/encode imports codec-names.js", () => {
  const offenders = jsFilesUnder("services/encode")
    .filter((file) => sourceOf(file).includes("codec-names"))
    .map((file) => path.relative(root, file));
  assert.deepEqual(offenders, []);
});
