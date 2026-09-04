/**
 * @file One store of segments, addressed by what they are, and what it makes of
 * what a killed process left behind.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { directoryNameFor, SegmentStore } from "../services/encode/SegmentStore.js";
import { fmp4Format } from "../services/segment-formats/fmp4.js";

/**
 * @returns {{ store: SegmentStore, root: string, lines: string[] }}
 */
function storeInATempRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "segment-store-"));
  const lines = [];
  const store = new SegmentStore({
    root,
    logger: { info: (line) => lines.push(line), warn: (line) => lines.push(line) }
  });
  return { store, root, lines };
}

/**
 * @param {string} dir
 * @param {number} index
 * @param {number} bytes
 */
function writeSegment(dir, index, bytes = 16) {
  writeFileSync(path.join(dir, fmp4Format.segmentFileName(index)), Buffer.alloc(bytes));
}

const KEY = "torrent:abc:fmt=fmp4:grid=kf@0:video-only:v=0/copy";

test("two viewers of one output are given the same directory", (t) => {
  const { store, root } = storeInATempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // Which viewer asked never enters it — the address is what the segments are.
  assert.equal(store.directoryFor(KEY), store.directoryFor(KEY));
  assert.notEqual(store.directoryFor(KEY), store.directoryFor(`${KEY}:other`));
});

test("the directory says what it holds, so a later process can tell", (t) => {
  const { store, root } = storeInATempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const dir = store.directoryFor(KEY);
  const names = readdirSync(dir);
  assert.deepEqual(names, ["key.txt"]);
});

test("a segment is proven closed by the existence of the next one", (t) => {
  const { store, root } = storeInATempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const dir = store.directoryFor(KEY);
  store.useFormat(KEY, fmp4Format);
  writeSegment(dir, 0);
  writeSegment(dir, 1);
  writeSegment(dir, 2);

  // The `segment` muxer writes no temporary file, so a file that exists may
  // still be growing; only a run that has moved past it proves otherwise.
  assert.deepEqual(store.provenNumbers(KEY), [0, 1]);
  assert.equal(store.unprovenNumber(KEY), 2);
});

test("a file of no bytes is not a segment, whatever it is called", (t) => {
  const { store, root } = storeInATempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const dir = store.directoryFor(KEY);
  store.useFormat(KEY, fmp4Format);
  writeSegment(dir, 0);
  writeSegment(dir, 1);
  writeSegment(dir, 2, 0);

  // What a run killed the moment after opening its next piece leaves behind.
  // Counted as a segment once, it closed the only hole in the numbering and
  // convinced the look-ahead the encoder had produced it.
  assert.equal(store.pathOf(KEY, 2), null);
  assert.deepEqual(store.provenNumbers(KEY), [0]);
});

test("a directory that has not moved is not read again", (t) => {
  const { store, root } = storeInATempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const dir = store.directoryFor(KEY);
  store.useFormat(KEY, fmp4Format);
  writeSegment(dir, 0);
  writeSegment(dir, 1);

  const first = store.refresh(KEY);
  const second = store.refresh(KEY);
  assert.equal(first, second, "the same reading is handed back, not a fresh listing");
});

test("what a killed process left is found, named and counted", (t) => {
  const { store, root, lines } = storeInATempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const dir = path.join(root, directoryNameFor(KEY));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "key.txt"), `${KEY}\n`);
  writeSegment(dir, 0);
  writeSegment(dir, 1);
  const orphan = path.join(root, "0123456789abcdef");
  mkdirSync(orphan, { recursive: true });
  writeSegment(orphan, 0);

  const swept = store.sweep();
  assert.equal(swept.directories, 2);
  assert.equal(swept.unidentified, 1, "the one with no key file cannot be matched to a request");
  assert.equal(swept.segments, 3);
  assert.match(lines.join("\n"), /startup sweep/);
  assert.match(lines.join("\n"), /ended\s+without anything recording why/);
});

test("what survived a kill is taken back, minus the piece nothing proves", (t) => {
  const { store, root } = storeInATempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const dir = path.join(root, directoryNameFor(KEY));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "key.txt"), `${KEY}\n`);
  for (let index = 0; index <= 5; index += 1) {
    writeSegment(dir, index);
  }

  const taken = store.adoptWhatSurvived(() => fmp4Format);

  assert.equal(taken.adopted, 1);
  assert.equal(taken.unprovenRemoved, 1, "the highest number was being written when the run died");
  // Five kept rather than six thrown away: a copied segment's bytes depend only
  // on the source, and re-encoding them costs a machine already short of it.
  assert.deepEqual(store.provenNumbers(KEY), [0, 1, 2, 3, 4]);
  assert.equal(store.pathOf(KEY, 5), null);
});

test("a directory that cannot name itself is thrown away rather than served", (t) => {
  const { store, root } = storeInATempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const orphan = path.join(root, "0123456789abcdef");
  mkdirSync(orphan, { recursive: true });
  writeSegment(orphan, 0);

  const taken = store.adoptWhatSurvived(() => fmp4Format);

  assert.equal(taken.adopted, 0);
  assert.equal(taken.dropped, 1);
  assert.equal(readdirSync(root).length, 0);
});

test("an output this proxy can no longer serve is thrown away too", (t) => {
  const { store, root } = storeInATempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const dir = path.join(root, directoryNameFor(KEY));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "key.txt"), `${KEY}\n`);
  writeSegment(dir, 0);

  const taken = store.adoptWhatSurvived(() => null);

  assert.equal(taken.dropped, 1);
  assert.equal(readdirSync(root).length, 0);
});

test("what the store weighs is reported, and dropping one output frees it", (t) => {
  const { store, root } = storeInATempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const dir = store.directoryFor(KEY);
  store.useFormat(KEY, fmp4Format);
  writeSegment(dir, 0, 1000);
  writeSegment(dir, 1, 1000);

  assert.equal(store.stats().bytes, 2000);
  store.drop(KEY, "nobody is watching it");
  assert.equal(store.stats().outputs, 0);
});
