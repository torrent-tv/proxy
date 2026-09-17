/**
 * @file The torrent thread serves bytes. It does not read what a file says.
 *
 * Both halves of that were true of the design and only one was true of the
 * code: pieces have lived in shared memory since the reader was rewritten, and
 * the torrent thread ALSO parsed containers — the track table, the media info
 * and the keyframe index — and carried each answer back over the channel.
 *
 * The stated reason was "the main thread cannot open a read stream on one of
 * its files". That is true of WebTorrent's own API and not of the bytes: a
 * container is built from one function, `readRange(start, end)`, and the read
 * that serves every segment already waits for what has not arrived and steers
 * the swarm toward it. What the split cost was three commands, a second
 * `ContainerOrchestrator` in that thread, and — because an answer then had to
 * be carried across — the question of where each such answer is KEPT, which is
 * how one fact came to be stored twice.
 *
 * These checks are structural because the property is structural: there is no
 * input that makes a parse happen in the wrong thread, only an import.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../services/torrent/worker");

/**
 * @param {string} name
 * @returns {string}
 */
function source(name) {
  return readFileSync(path.join(WORKER, name), "utf8");
}

test("no command asks the torrent thread what a file declares", () => {
  const protocol = source("protocol.js");

  for (const gone of [
    "CONTAINER_TRACKS",
    "CONTAINER_MEDIA_INFO",
    "CONTAINER_KEYFRAMES",
    "SUBTITLE_TRACKS",
    "SUBTITLE_CUES"
  ]) {
    assert.equal(
      protocol.includes(gone),
      false,
      `${gone} is a question about the FILE, and it is answered where the sessions are`
    );
  }
});

test("nothing in that thread reaches into the media layer at all", () => {
  // The last one to was the subtitle cue walk, and it moved with the rest: it
  // is handed which ranges of a file are downloaded whole and how to read one
  // of those, and it has no use for a torrent beyond that. What stayed behind
  // is the two things only this thread can answer — the bitfield as a list of
  // ranges, and a store read that never fetches (`held-bytes.js`).
  const reaching = readdirSync(WORKER)
    .filter((name) => name.endsWith(".js"))
    .filter((name) => /from "(?:\.\.\/)+media\//.test(source(name)));

  assert.deepEqual(reaching, []);
});

test("what the walk may read is answered as a list, not asked per cluster", () => {
  // A pass asks about every cluster of the file — hundreds on the field files,
  // every three seconds. One list per pass costs one message; the same answers
  // one at a time would cost hundreds of round trips for a walk that is meant
  // to be free when there is nothing new to find.
  const held = source("held-bytes.js");

  assert.match(held, /export function heldRangesOf\(torrent, fileIndex\)/);
  assert.match(held, /export function readHeldBytes\(/);
});

test("the walk's read never fetches", () => {
  // The ordinary range read declares demand and steers the swarm, which is
  // right for a viewer waiting on a segment and wrong here: switching subtitles
  // on must not pull bytes the viewer is not waiting for.
  const held = source("held-bytes.js");

  assert.equal(held.includes("demandFor"), false);
  assert.equal(held.includes("readFragments"), false);
});

test("the resume warm is TOLD how long the file runs", () => {
  // It used to read the container itself to find out, which is what a file
  // states about itself. What is left here is the part that really is the
  // torrent's: a position in seconds becomes a byte offset, and that region is
  // pulled off the swarm.
  const warm = source("resume-warm.js");

  assert.match(warm, /options\.durationSeconds/);
  assert.equal(warm.includes("containerOrchestrator"), false);
  assert.equal(warm.includes("ContainerFactory"), false);
});

test("the main thread can read a byte range of a file", () => {
  // The one thing the move needed, and the whole of what a container is built
  // from. Without it the parse has nowhere to get its bytes and the commands
  // come back.
  assert.match(source("pool-adapter.js"), /async readRangeOf\(torrent, fileIndex, start, end\)/);
});
