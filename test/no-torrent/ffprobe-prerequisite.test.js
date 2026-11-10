/**
 * @file What a check that needs a real ffprobe does when the host has none that
 * qualifies: it is skipped with a reason that names the missing prerequisite, and
 * where `CI` is set it fails instead, so a CI runner cannot hide a regression of
 * the ffprobe selection behind a skip.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { decideFfprobe } from "./helpers/ffprobe-binary.js";

const LINE = "ffprobe: no usable binary: bundled /m/ffprobe (version n4.4.1) lacks section stream_side_data";
const CHOSEN = { source: "PATH", binary: "ffprobe", version: "6.1.1" };

test("a chosen binary is used, whether or not CI is set", () => {
  assert.deepEqual(decideFfprobe({ chosen: CHOSEN, missing: null, env: {} }), { binary: "ffprobe" });
  assert.deepEqual(decideFfprobe({ chosen: CHOSEN, missing: null, env: { CI: "true" } }), { binary: "ffprobe" });
});

test("without a qualifying binary and without CI the check is skipped with a reason naming the prerequisite and the selection's line", () => {
  const decision = decideFfprobe({ chosen: null, missing: LINE, env: {} });
  assert.ok(typeof decision.skip === "string");
  assert.ok(decision.skip.includes("missing prerequisite"));
  assert.ok(decision.skip.includes("stream_side_data"));
  assert.ok(decision.skip.includes(LINE));
});

test("without a qualifying binary and with CI set the check fails instead of being skipped", () => {
  assert.throws(() => decideFfprobe({ chosen: null, missing: LINE, env: { CI: "true" } }), /missing prerequisite.*not skipped where CI is set/s);
});

test("an empty CI variable is not CI", () => {
  assert.ok("skip" in decideFfprobe({ chosen: null, missing: LINE, env: { CI: "" } }));
});
