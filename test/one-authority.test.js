/**
 * @file One place decides which encoders exist.
 *
 * Not a check of behaviour but of shape, and it is here because the shape is
 * what failed. Three separate places used to decide where an encoder should
 * work and whether it should go on living, and they disagreed on every pass:
 * measured in the field on 2026-09-05, 684 starts and 660 stops in 482 seconds,
 * of which 294 were one place killing what another had just decided to keep,
 * while the viewer's own segment went unmade for 32.3 seconds.
 *
 * Every rule below is one that was broken then. A reader who needs to add a
 * fourth place should read this file first and then not.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {string} relative
 * @returns {string}
 */
function source(relative) {
  return readFileSync(path.join(HERE, "..", relative), "utf8");
}

/**
 * Lines of code, without comments or blanks: a rule about what the code does
 * must not be answered by what a comment says about it.
 *
 * @param {string} text
 * @returns {string[]}
 */
function statements(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"));
}

test("an encoder is stopped for scheduling reasons in exactly one place", () => {
  // The orchestrator decides; nobody else may. What is left in the session
  // manager is teardown — the session is going away and its encoders with it —
  // which is not a decision about which encoders should exist.
  const orchestrator = statements(source("services/orchestrators/EncodeOrchestrator.js"));
  const stopsInOrchestrator = orchestrator.filter((line) => line.includes("run.stop("));
  assert.equal(stopsInOrchestrator.length, 1, "the orchestrator stops runs in one place");

  const manager = statements(source("services/hls-session-manager.js"));
  const stopsInManager = manager.filter((line) => line.includes(".stop("));
  assert.equal(
    stopsInManager.length,
    2,
    "the session manager stops runs only when a session is torn down: " +
      stopsInManager.join(" / ")
  );
});

test("nothing outside the encoding layer starts an encoder", () => {
  // A run is built in one place. Two places building them is how a start came
  // to kill what the plan had decided to keep — the killing lived in the
  // building.
  const manager = statements(source("services/hls-session-manager.js"));
  const builds = manager.filter((line) => line.includes("new EncodeRun("));
  assert.equal(builds.length, 1, "one place builds an encoder");
});

test("starting an encoder stops nothing", () => {
  // The rule that broke it: the start path looked for a live run whose own
  // start was not below the new one's and killed it. It is not enough that the
  // line is gone — the words it was written with must not come back.
  const manager = source("services/hls-session-manager.js");
  assert.equal(
    manager.includes("previousRun"),
    false,
    "there is no such thing as the previous run: a session holds several"
  );
  assert.equal(manager.includes("a new run is taking its place"), false);
});

test("a seek moves the viewer and nothing else", () => {
  // It used to do eleven things and write the position into five places. What
  // follows from a viewer moving is the map's business, and the orchestrators
  // read the map.
  const manager = source("services/hls-session-manager.js");
  const seek = manager.slice(
    manager.indexOf("requestSeek(sessionId, positionSeconds"),
    manager.indexOf("requestSeek(sessionId, positionSeconds") + 2000
  );
  const body = seek.slice(0, seek.indexOf("\n  }\n"));
  assert.equal(body.includes("#startEncodeRun"), false, "a seek starts no encoder");
  assert.equal(body.includes("setTimeout"), false, "and waits for nothing");
});

test("how far an encoder may work is answered once", () => {
  // The plan computes the stretch and it reaches ffmpeg. A second computation
  // somewhere else is what made the first one pointless: it was passed and then
  // dropped by a parameter list that did not name it.
  const orchestrator = source("services/orchestrators/EncodeOrchestrator.js");
  assert.ok(orchestrator.includes("makeRun({ address, from, to })"), "the stretch is handed over");
});
