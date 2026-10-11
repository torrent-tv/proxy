/**
 * @file One owner of what a file says, and the torrent thread fetching only
 * what the map asks for.
 *
 * Which thread reads a container is not a rule here: it is decided by what it
 * gives the viewer, measured (torrent-tv/meta#183). What these checks hold is
 * what a thread placement once served as a proxy for. A container's readings
 * were once kept in two places — the torrent thread parsed the track table,
 * the media info and the keyframe index and carried each answer back, while
 * the main thread kept its own — and one fact came to be stored twice. So
 * there is ONE container orchestrator, wherever it runs; and the reads this
 * thread offers others never fetch, because only the viewers' priority map
 * tells the torrent what to download.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKER = path.join(ROOT, "services/torrent/worker");

/**
 * @param {string} name
 * @returns {string}
 */
function source(name) {
  return readFileSync(path.join(WORKER, name), "utf8");
}

/**
 * Every source file of the proxy itself, tests and dependencies left out.
 *
 * @param {string} directory
 * @returns {string[]}
 */
function sourcesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourcesUnder(full);
    return entry.name.endsWith(".js") ? [full] : [];
  });
}

test("a file's container readings have one owner", () => {
  // The orchestrator is the one place a container is built and its readings
  // kept; a second instance in any thread is the fact stored twice again.
  const building = [path.join(ROOT, "server.js"), ...sourcesUnder(path.join(ROOT, "services")), ...sourcesUnder(path.join(ROOT, "bin"))]
    .filter((file) => /new ContainerOrchestrator\(/.test(readFileSync(file, "utf8")))
    .map((file) => path.relative(ROOT, file).replaceAll("\\", "/"));

  assert.deepEqual(building, ["services/media/ContainerOrchestrator.js"]);
});

test("what the walk may read is answered as a list, not asked per cluster", () => {
  // A pass asks about every cluster of the file — hundreds on the field files,
  // every three seconds. One list per pass costs one message; the same answers
  // one at a time would cost hundreds of round trips for a walk that is meant
  // to be free when there is nothing new to find.
  const held = source("held-bytes.js");

  assert.match(held, /export function heldRangesOf\(torrent, fileIndex\)/);
  assert.match(held, /export async function readHeldBytes\(/);
});

test("the walk's read never fetches", () => {
  // The ordinary range read declares demand and steers the swarm, which is
  // right for a viewer waiting on a segment and wrong here: switching subtitles
  // on must not pull bytes the viewer is not waiting for.
  const held = source("held-bytes.js");

  assert.equal(held.includes("demandFor"), false);
  assert.equal(held.includes("readFragments"), false);
});

test("the torrent thread has no independent resume or whole-file warm commands", () => {
  const worker = source("worker.js");
  const commands = source("protocol.js");
  for (const name of ["WARM_POSITION", "FILL_FILE", "FILL_TORRENT"]) {
    assert.equal(worker.includes(`Command.${name}`), false);
    assert.equal(commands.includes(`${name}:`), false);
  }
});

test("the main thread can read a byte range of a file", () => {
  // What a container is built from wherever it runs today: one function,
  // `readRange(start, end)`, over the pieces in shared memory.
  assert.match(source("pool-adapter.js"), /async readRangeOf\(torrent, fileIndex, start, end\)/);
});

test("priority publication cannot announce unchanged bytes and retry its own read", () => {
  const worker = source("worker.js");
  const publication = worker.slice(worker.indexOf("case Command.PRIORITY_MAP:"), worker.indexOf("case Command.READ_RANGE:"));
  assert.doesNotMatch(publication, /announceArrivals/);
  assert.match(publication, /ensureArrivalsWired/);
  assert.match(worker, /torrent\.on\("verified"/);
  assert.match(worker, /torrent\.on\("piece-withdrawn"/);
});
