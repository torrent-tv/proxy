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

test("a piece under its served name is finished, and the last one too", (t) => {
  const { store, root } = storeInATempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const dir = store.directoryFor(KEY);
  store.useFormat(KEY, fmp4Format);
  writeSegment(dir, 0);
  writeSegment(dir, 1);
  writeSegment(dir, 2);

  // It was "the NEXT number exists", which left the last piece of every run
  // unprovable for ever and — the moment two runs share an output — declared a
  // half-written file finished because somebody else had written the one after
  // it. The name is the proof now, so all three count.
  assert.deepEqual(store.provenNumbers(KEY), [0, 1, 2]);
});

test("a piece still being written is not a piece, and its name says so", (t) => {
  const { store, root } = storeInATempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const dir = store.directoryFor(KEY);
  store.useFormat(KEY, fmp4Format);
  writeSegment(dir, 0);
  // What ffmpeg is writing into right now, tagged with the run that opened it.
  writeFileSync(path.join(dir, "making-0-00001.mp4"), Buffer.alloc(64));

  assert.deepEqual(store.provenNumbers(KEY), [0]);
  assert.equal(store.isClosed(KEY, 1), false);
  assert.equal(store.pathOf(KEY, 1), null);

  // And closing it is one rename, after which it is servable.
  assert.equal(store.publish(KEY, "making-0-00001.mp4", fmp4Format), "segment-00001.mp4");
  assert.equal(store.isClosed(KEY, 1), true);
});

test("a file of no bytes is not a segment, whatever it is called", (t) => {
  const { store, root } = storeInATempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const dir = store.directoryFor(KEY);
  store.useFormat(KEY, fmp4Format);
  writeSegment(dir, 0);
  writeSegment(dir, 1);
  writeSegment(dir, 2, 0);

  // A file of no bytes under a served name cannot arise from this proxy any
  // more — a piece takes that name only on being closed — but a killed process
  // can leave one, and taking it for a segment once closed the only hole in the
  // numbering and convinced the look-ahead the encoder had produced it.
  assert.equal(store.pathOf(KEY, 2), null);
  assert.deepEqual(store.provenNumbers(KEY), [0, 1]);
});

test("clearing up after one run leaves every other run's work alone", (t) => {
  const { store, root } = storeInATempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const dir = store.directoryFor(KEY);
  store.useFormat(KEY, fmp4Format);
  // Two live runs, each with a piece open, plus finished pieces of both.
  writeSegment(dir, 0);
  writeSegment(dir, 100);
  writeFileSync(path.join(dir, "making-0-00001.mp4"), Buffer.alloc(64));
  writeFileSync(path.join(dir, "making-100-00101.mp4"), Buffer.alloc(64));

  // The run that began at #0 ends. Its own unfinished piece goes and nothing
  // else does — which the old rule could not manage: it took the highest SERVED
  // name inside the ended run's stretch and judged its bytes, so with the
  // naming rule above it would have removed #0, a piece that run had closed.
  assert.equal(store.clearUpAfter(KEY, 0), 1);
  assert.deepEqual(store.provenNumbers(KEY), [0, 100]);
  assert.equal(
    readdirSync(dir).includes("making-100-00101.mp4"),
    true,
    "the other run is still writing its own"
  );
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

test("what survived a kill is taken back whole, minus what was still being written", (t) => {
  const { store, root } = storeInATempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const dir = path.join(root, directoryNameFor(KEY));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "key.txt"), `${KEY}
`);
  for (let index = 0; index <= 5; index += 1) {
    writeSegment(dir, index);
  }
  // The piece the kernel interrupted. It never had a served name, so it cannot
  // be mistaken for one — which is what the old rule could only guess at, by
  // always throwing the highest number away.
  writeFileSync(path.join(dir, "making-0-00006.mp4"), Buffer.alloc(64));

  const taken = store.adoptWhatSurvived(() => fmp4Format);

  assert.equal(taken.adopted, 1);
  assert.equal(taken.unprovenRemoved, 1, "the one under a working name");
  // All six kept rather than five: the highest served name used to be thrown
  // away because nothing could prove it, and on the copy branch that is a piece
  // whose bytes depend only on the source and cost a short machine to remake.
  assert.deepEqual(store.provenNumbers(KEY), [0, 1, 2, 3, 4, 5]);
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
