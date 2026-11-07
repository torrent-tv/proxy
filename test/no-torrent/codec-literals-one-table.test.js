import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// torrent-tv/meta#284 acceptance 2:
//   grep -rn '"V_MPEG4/ISO/AVC"\|"hvc1"' services
// lists only codec-names.js and the container parsers. "Container parsers" is
// services/media/container/ (reads Matroska and MP4 headers) and
// services/encode/segment-formats/ (reads and writes MP4 boxes, where hvc1 is a
// sample-entry type, not a codec name being translated).
const services = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../services");
const allowed = file => file === "media/tracks/codec-names.js"
  || file.startsWith("media/container/") || file.startsWith("encode/segment-formats/");

function* sources(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* sources(full);
    else if (entry.name.endsWith(".js")) yield full;
  }
}

test("codec id literals live in codec-names.js and the container parsers only", () => {
  const offenders = [];
  for (const file of sources(services)) {
    const relative = path.relative(services, file).split(path.sep).join("/");
    if (allowed(relative)) continue;
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
      if (line.includes('"V_MPEG4/ISO/AVC"') || line.includes('"hvc1"')) offenders.push(`${relative}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});
