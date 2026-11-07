/**
 * @file The state directory is resolved once, by the CLI (torrent-tv/meta#293).
 *
 * `--state-dir` says its default is beside the installed proxy, but only
 * `LocalObservations` fell back to that, through a `PROXY_ROOT` fallback in
 * `services/server/wire-outputs.js`; every other consumer read an empty value
 * as "off". The rule now: `bin/cli.js` turns the option into ONE value (the
 * default beside the installed proxy, or explicitly none) and passes that value
 * on. A consumer that is handed none does nothing with it.
 *
 * SEAM: none new. `wireOutputs({ stateDir })` is handed the resolved value;
 * "" means none and writes nothing anywhere. `bin/cli.js` reads
 * `options.stateDir` in exactly one place (the resolution).
 *
 * The fallback check is OBSERVED through `fs`: writes to a file named
 * `local-observations.json` anywhere are recorded and swallowed, so a failing
 * run cannot leave one inside the checkout.
 *
 * PINNING (pass before and after): a named state directory keeps receiving
 * local-observations.json, which is the path the Home Assistant addon uses.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { wireOutputs } from "../../services/server/wire-outputs.js";
import { outputSpec } from "./helpers/output-spec.js";
import { jsFilesUnder, sourceOf } from "./helpers/source-text.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(HERE, "..", "..");
const FINGERPRINT = Object.freeze({ ffmpeg: "8.1.2", x264: "core 164", cpu: "test", threads: 4, devices: {} });
const CONTENT = { codec: "h264", bitDepth: 8, width: 1280, height: 720, megabitsPerSecond: 5 };
const OBSERVATIONS = "local-observations.json";

/** The files named local-observations.json that were written to, and where; none reach the disk. */
function swallowObservationWrites() {
  const targets = [];
  const mine = (target) => typeof target === "string" && path.basename(target).startsWith(OBSERVATIONS);
  const original = { writeFileSync: fs.writeFileSync, renameSync: fs.renameSync };
  fs.writeFileSync = function (target, ...rest) {
    if (mine(target)) { targets.push(path.resolve(target)); return undefined; }
    return original.writeFileSync.call(this, target, ...rest);
  };
  fs.renameSync = function (from, target) {
    if (mine(target)) { targets.push(path.resolve(target)); return undefined; }
    return original.renameSync.call(this, from, target);
  };
  syncBuiltinESMExports();
  return {
    targets,
    restore() {
      fs.writeFileSync = original.writeFileSync;
      fs.renameSync = original.renameSync;
      syncBuiltinESMExports();
    }
  };
}

/** Wire the output graph with a fake calibration, note one encode, and say where it was kept. */
function whereOneEncodeIsKept(wiring) {
  const writes = swallowObservationWrites();
  try {
    const parts = wireOutputs({
      enabled: true,
      ffmpegBin: "ffmpeg",
      localBindHost: "127.0.0.1",
      localPort: 9090,
      calibration: { fingerprint: FINGERPRINT, kinds: () => [], modesFor: () => [] },
      ...wiring
    });
    assert.ok(parts.localObservations, "the observations were not wired");
    parts.localObservations.noteEncode({
      spec: outputSpec({ transcodeVideo: true, width: 1280, height: 720, preset: "veryfast" }),
      content: CONTENT,
      aloneSpeedX: 2,
      segmentKbps: null
    });
  } finally {
    writes.restore();
  }
  return writes.targets;
}

test("handed no state directory, wireOutputs keeps its observations nowhere: no fallback to the proxy's own directory", () => {
  assert.deepEqual(whereOneEncodeIsKept({ stateDir: "" }), []);
});

test("PINNING: handed a state directory, wireOutputs keeps local-observations.json there", () => {
  const stateDir = path.join(os.tmpdir(), "state-dir-resolved-once-addon");
  const targets = whereOneEncodeIsKept({ stateDir });
  assert.ok(targets.length > 0, "nothing was kept");
  assert.ok(targets.every((target) => path.dirname(target) === stateDir), JSON.stringify(targets));
});

test("services/server names PROXY_ROOT nowhere", () => {
  const found = jsFilesUnder("services/server").flatMap((file) =>
    sourceOf(file).split("\n").flatMap((line, index) => (line.includes("PROXY_ROOT") ? [`${path.relative(PROXY, file)}:${index + 1}`] : []))
  );
  assert.deepEqual(found, [], "PROXY_ROOT is still read by a consumer in services/server");
});

test("the CLI reads options.stateDir once, where it resolves it, and the consumers read the resolved value", () => {
  const lines = sourceOf(path.join("bin", "cli.js")).split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => !line.trim().startsWith("//") && line.includes("options.stateDir"));
  assert.ok(lines.length <= 1, `options.stateDir is read in ${lines.length} places: ${lines.map(({ number }) => number).join(", ")}`);
  assert.equal(lines.length, 1, "the option is never resolved");
});
