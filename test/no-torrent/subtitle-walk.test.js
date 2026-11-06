/**
 * @file The subtitle walk (torrent-tv/meta#280, design.md §6.5 C): a held file
 * from a fake pool, the container built once, one walk at a time.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { SubtitleWalk } from "../../services/media/SubtitleWalk.js";
import { SubtitleOrchestrator } from "../../services/media/SubtitleOrchestrator.js";

const torrent = { pieceLength: 100, files: [{ name: "film.mkv", length: 1000 }, { name: "empty.srt", length: 0 }] };

function walk(overrides = {}) {
  const calls = { read: [], known: [], wanted: [], built: 0, lines: [], warnings: [] };
  let container = undefined;
  const ports = {
    torrents: {
      knownTorrent: sourceKey => { calls.known.push(sourceKey); return sourceKey === "src" ? torrent : null; },
      heldRangesOf: () => [[0, 999]],
      readHeldOf: (t, fileIndex, start, end) => { calls.read.push([fileIndex, start, end]); return Buffer.alloc(end - start + 1); }
    },
    containers: {
      known: () => container,
      containerFor: async () => { calls.built += 1; container = { tracks: [] }; return container; }
    },
    paramsFor: async request => ({ ...request, label: "film.mkv" }),
    wantedSeconds: (sourceKey, fileIndex) => { calls.wanted.push([sourceKey, fileIndex]); return [12, 600]; },
    publish: () => {},
    log: line => calls.lines.push(line),
    warn: line => calls.warnings.push(line),
    ...overrides
  };
  return { calls, subtitleWalk: new SubtitleWalk(ports) };
}

test("a held file reads through the pool and states its length, name and portion", async () => {
  const { calls, subtitleWalk } = walk();
  const file = await subtitleWalk.heldFileFor("src", 0);
  assert.equal(file.length, 1000);
  assert.equal(file.name, "film.mkv");
  assert.equal(file.portionBytes, 100);
  await file.readHeld(0, 9);
  assert.deepEqual(calls.read, [[0, 0, 9]]);
  assert.deepEqual(await file.heldRanges(), [[0, 999]]);
});

test("an unknown torrent or an empty file has no held file", async () => {
  const { subtitleWalk } = walk();
  assert.equal(await subtitleWalk.heldFileFor("other", 0), null);
  assert.equal(await subtitleWalk.heldFileFor("src", 1), null);
  assert.equal(await subtitleWalk.heldFileFor("src", 7), null);
});

test("a torrent handed in is used without asking the pool", async () => {
  const { calls, subtitleWalk } = walk();
  assert.ok(await subtitleWalk.heldFileFor("other", 0, torrent));
  assert.deepEqual(calls.known, []);
});

test("the container is built once, and the one already known is reused", async () => {
  const { calls, subtitleWalk } = walk();
  const file = await subtitleWalk.heldFileFor("src", 0);
  const first = await file.container();
  const second = await file.container();
  assert.equal(first, second);
  assert.equal(calls.built, 1);
});

test("where the viewers stand is asked of the port with the file's own address", async () => {
  const { calls, subtitleWalk } = walk();
  const file = await subtitleWalk.heldFileFor("src", 0);
  assert.deepEqual(file.wantedSeconds(), [12, 600]);
  assert.deepEqual(calls.wanted, [["src", 0]]);
});

test("the walk's orchestrator is built here", () => {
  assert.ok(walk().subtitleWalk.subtitles instanceof SubtitleOrchestrator);
});

test("one walk at a time, and one more after it however many were asked meanwhile", async () => {
  const { calls, subtitleWalk } = walk();
  const done = [subtitleWalk.pushFreshCues("src", 0), subtitleWalk.pushFreshCues("src", 0), subtitleWalk.pushFreshCues("src", 0)];
  await Promise.all(done);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.known.length, 2);
});

test("a walk that throws says so and does not reject", async () => {
  const { calls, subtitleWalk } = walk({ torrents: { knownTorrent: () => { throw new Error("gone"); } } });
  await subtitleWalk.pushFreshCues("sourcekey1234", 3);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.warnings, ["subtitle push sourceke:3 failed: gone"]);
});
