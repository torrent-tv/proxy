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
  assert.match(
    orchestrator,
    /makeRun\(\{ address, from, to, because \}\)/,
    "the stretch is handed over, and so are the plan's own words for why"
  );
});

test("only the plan places an encoder", () => {
  // The count is the whole of this item. There were eight other places: the
  // first run of a session, a viewer joining it further in, a rung or a
  // soundtrack being warmed, one being switched to, a hardware encoder falling
  // back to software, an input coming back, a cut table correcting itself, and
  // a settled seek. Each of them chose a position by a rule of its own, and the
  // plan — which is arithmetic over what is made, what is being made and what is
  // wanted — was left to compare its answer against theirs.
  const manager = source("services/hls-session-manager.js");
  const starts = [...manager.matchAll(/this\.#startEncodeRun\(/g)].length;
  assert.equal(starts, 1, "one caller, and it is the one the plan asks through");
  assert.match(
    manager,
    /#makeRunAt\(address, from, to, because\)[\s\S]{0,3000}this\.#startEncodeRun\(base, from, because, \{ to \}\)/,
    "and that caller is what the plan is given to build runs with"
  );
});

test("nobody stops an encoder for being unwatched", () => {
  // Whether an encoder is still wanted is the same question as where one should
  // be, and the plan answers it: an output with nobody on it has a priority map
  // with nothing in it. Answered here as well, it was answered twice by two
  // rules — and since a viewer moving between steps announces itself, the plan
  // started again what this class had just killed, several times a second.
  const manager = source("services/hls-session-manager.js");
  assert.equal(
    manager.includes("no viewer is watching"),
    false,
    "a rung nobody is on is a fact, not an act"
  );
  assert.equal(manager.includes("no viewer is listening to audio track"), false);
  assert.equal(
    manager.includes("warmed for a switch the viewer did not make"),
    false,
    "an abandoned warm-up is a viewer leaving an output"
  );
  assert.equal(manager.includes("prepared for a track change the viewer did not make"), false);
});

test("the seek settle machinery is gone, whole", () => {
  // A viewer's position is applied the moment they state it. The settle was a
  // second debounce on a signal the browser had already debounced, and every
  // millisecond of it was dead time in front of the viewer; the cooldown behind
  // it existed because segment REQUESTS once steered the encoder.
  const manager = source("services/hls-session-manager.js");
  for (const gone of [
    "seekSettleTimer",
    "seekTarget",
    "seekFirstFarAt",
    "SEEK_SETTLE_MS",
    "SEEK_SETTLE_MAX_MS",
    "RESTART_COOLDOWN_MS",
    "SEEK_BACKOFF_SEGMENTS",
    "#fireSettledSeek",
    "#seekSession"
  ]) {
    assert.equal(manager.includes(gone), false, `${gone} is gone`);
  }
});

test("where a soundtrack begins is read off the table, not handed in", () => {
  // The instant a number really begins is a fact of the FILE's cutting, held in
  // the live table every session of the file shares. Passed as an argument by
  // the one caller that had measured it, only a run started by that caller ever
  // had it, and a run the plan placed at the same number landed apart again.
  const manager = source("services/hls-session-manager.js");
  assert.match(
    manager,
    /const positionSecondsOverride = session\.audioOnly === true\s*\n?\s*\? trueStartOf\(session\.timeline, startIndex\)/,
    "derived where the run is built"
  );
  assert.equal(
    manager.includes("this.#startEncodeRun(member, index, trueStart)"),
    false,
    "and not carried in from the correction that measured it"
  );
});

test("a changed bitrate cap stops the encoder carrying the old one and nothing more", () => {
  // An argument list is fixed when a process starts, so a run carrying the
  // previous cap cannot be told about the new one — that is what is known here.
  // Where the replacement stands is a different question, and the old answer to
  // it was neither where a viewer is nor a gap in the material: it was the
  // segment the process being replaced happened to have reached.
  const manager = source("services/hls-session-manager.js");
  assert.equal(manager.includes("#restartAtViewer"), false, "the second answer is gone");
  assert.match(
    manager,
    /#reencodeAtNewRate\(session\) \{\s*\n\s*this\.#stopEncodeRun\(session, "its bitrate cap changed"\);\s*\n\s*this\.planEncodersSoon\(\);\s*\n\s*\}/,
    "stopped, and then decided again"
  );
});

test("each output is handed its own priority map, and the plan is what reads it", () => {
  // The map is one fact asked at two scopes, and both are right for what asks
  // them: the swarm is asked for bytes of a FILE, which every output of it
  // reads, and encoders are placed per OUTPUT, which a person watching 480p
  // wants nothing of at 1080p.
  const manager = source("services/hls-session-manager.js");
  assert.match(
    manager,
    /notePriorityMap\([\s\S]{0,200}mapForOutput\(address\)/,
    "the encoding reads the output's own map"
  );
  assert.equal(
    manager.includes("this.priority.mapFor("),
    false,
    "and never the whole film's, which wanted an encoder on every output of it"
  );
});
