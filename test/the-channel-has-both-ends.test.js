/**
 * @file Every call across the thread boundary has something to land on.
 *
 * The boundary is three files that have to agree, and nothing made them:
 * `protocol.js` names the commands, `worker.js` answers them, `client.js` asks,
 * and `pool-adapter.js` is what the main thread calls. A mismatch anywhere in
 * that chain is invisible to every other check in this repository, because a
 * unit test of either end alone passes and the failure needs a real worker.
 *
 * It was not hypothetical. Removing three commands on 2026-09-15 took an
 * unrelated neighbour with them — `client.fillFile`, which the adapter went on
 * calling — and left two adapter methods calling commands that no longer
 * existed. One of those two is the browser's own subtitle request, and it did
 * not even throw where anybody would see it: the orchestrator caught the error
 * and answered an EMPTY document, which is indistinguishable from a file that
 * genuinely holds no cues. That is the exact failure the whole subtitle path is
 * written to avoid, and it would have reached the field.
 *
 * These are structural because the property is: there is no input that makes a
 * call land on a method that is not there.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../services/torrent-worker");

/**
 * @param {string} name
 * @returns {string}
 */
function source(name) {
  return readFileSync(path.join(WORKER, name), "utf8");
}

/**
 * Names a file defines at the top level of a class: methods, and fields it
 * assigns to itself. Both are callable or readable from outside.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
function membersOf(text) {
  const names = new Set();
  for (const match of text.matchAll(/^\s{2}(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([a-zA-Z#][a-zA-Z0-9]*)\s*[(=]/gm)) {
    names.add(match[1]);
  }
  // Fields a constructor or a method assigns rather than declares.
  for (const match of text.matchAll(/this\.([a-zA-Z][a-zA-Z0-9]*)\s*=/g)) {
    names.add(match[1]);
  }
  return names;
}

test("every client method the adapter calls exists", () => {
  const have = membersOf(source("client.js"));
  const used = [...source("pool-adapter.js").matchAll(/#client\.([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1]);

  assert.deepEqual([...new Set(used)].filter((name) => !have.has(name)), []);
});

test("every command the client sends is answered by the worker", () => {
  const protocol = source("protocol.js");
  const answered = new Set([...source("worker.js").matchAll(/case Command\.([A-Z_]+):/g)].map((m) => m[1]));
  const sent = [...source("client.js").matchAll(/Command\.([A-Z_]+)/g)].map((m) => m[1]);

  const unanswered = [...new Set(sent)].filter((name) => !answered.has(name));
  assert.deepEqual(unanswered, [], "a command nobody answers waits for a reply that never comes");

  const undeclared = [...new Set(sent)].filter((name) => !protocol.includes(`  ${name}:`));
  assert.deepEqual(undeclared, [], "and one the protocol does not name is `undefined` on the wire");
});

test("every event the worker posts is received somewhere on the main thread", () => {
  // TWO receivers, and they answer different shapes. `channel.js` matches the
  // replies to a request by its id — a result, an error, a chunk of a body —
  // while `client.js` has a `case` for each event that belongs to nobody's
  // request. An event handled by neither is a fact announced into silence.
  const receiving = `${source("client.js")}
${source("channel.js")}`;
  const handled = new Set([
    ...[...receiving.matchAll(/case Event\.([A-Z_]+):/g)].map((m) => m[1]),
    ...[...receiving.matchAll(/message\.type === Event\.([A-Z_]+)/g)].map((m) => m[1])
  ]);
  const posted = [...source("worker.js").matchAll(/type:\s*Event\.([A-Z_]+)/g)].map((m) => m[1]);

  assert.deepEqual([...new Set(posted)].filter((name) => !handled.has(name)), []);
});
