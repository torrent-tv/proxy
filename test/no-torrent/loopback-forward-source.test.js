/**
 * @file One place forwards relayed requests to the proxy's own HTTP server, and
 * the tunnel relay is gone (torrent-tv/meta#281, AC-1 and AC-3).
 *
 * These read the source as the acceptance greps do — the raw text, comments
 * included — so a second copy of the forwarding cannot come back unnoticed.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { codeOf, jsFilesUnder, sourceOf } from "./helpers/source-text.js";

/** Files under `directory` whose raw text contains `needle`, named from `directory`. */
function filesContaining(directory, needle) {
  return jsFilesUnder(directory)
    .filter((file) => sourceOf(file).includes(needle))
    .map((file) => file.slice(file.lastIndexOf(`${path.sep}${directory}${path.sep}`) + 1));
}

test("under services/transport only the loopback forwarder and the registry API call fetch", () => {
  const callers = jsFilesUnder("services/transport")
    .filter((file) => sourceOf(file).includes("fetch("))
    .map((file) => path.basename(file))
    .sort();

  assert.deepEqual(callers, ["loopback-forward.js", "registry-api.js"]);
});

test("nothing under services relays a tunnel request", () => {
  assert.deepEqual(filesContaining("services", "relay("), []);
  assert.deepEqual(filesContaining("services", "handleRelayRequest"), []);
});

test("the loopback forwarder holds requests with no header or body timeout", () => {
  const code = codeOf(sourceOf("services/transport/loopback-forward.js"));

  assert.match(code, /headersTimeout:\s*0\b/);
  assert.match(code, /bodyTimeout:\s*0\b/);
});
