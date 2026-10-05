/**
 * @file Paths a module builds from its own location still name what they meant.
 *
 * A file that joins `..` onto its own directory is right only at the depth it
 * was written at. Moving files into their components (2.87.0) left the gdb
 * script of the usrsctp reader pointing one directory short, and no check
 * noticed: the path is read only when a wedge is diagnosed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { CALIBRATION_DIR } from "../../services/encode/hwaccel.js";
import { PROXY_ROOT } from "../../services/encode/quality/HostTimings.js";
import { SCTPSTATE_SCRIPT_PATH } from "../../services/transport/usrsctp-state.js";

test("the calibration clips are where the benchmark looks", () => {
  assert.ok(existsSync(CALIBRATION_DIR), CALIBRATION_DIR);
});

test("the usrsctp state script is where the reader looks", () => {
  assert.ok(existsSync(SCTPSTATE_SCRIPT_PATH), SCTPSTATE_SCRIPT_PATH);
});

test("the default place for host timings is the proxy's own directory", () => {
  assert.ok(existsSync(path.join(PROXY_ROOT, "package.json")), PROXY_ROOT);
});
