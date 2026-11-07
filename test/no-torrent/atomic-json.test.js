/**
 * @file State files are written atomically (torrent-tv/meta#293).
 *
 * SEAMS THE IMPLEMENTATION MUST PROVIDE (the names these checks use):
 *
 * - `utils/atomic-json.js` exports `writeJsonAtomic(filePath, value, { fs })`:
 *   synchronous; serialises `value` as JSON, writes it to a temporary file
 *   beside `filePath`, then `renameSync`s that over `filePath`. `fs` is an
 *   optional object of overrides for `writeFileSync` / `renameSync` (and any
 *   other fs function it needs), merged over `node:fs`, so a check can stop the
 *   write between the two steps. It THROWS on failure (the caller decides what
 *   a failed save means) and never writes `filePath` itself.
 * - `LocalObservations` takes `writeJson(filePath, value)` in its constructor
 *   (encode may not import utils, so the shared function is passed in) and
 *   saves through it, never with its own `writeFileSync`.
 * - `CompletedFiles` (manifest.json), the `SegmentStore` key file (key.txt)
 *   and `installationId` (proxy-identity.json) create their final file by a
 *   rename only, whichever call they use; this is observed through `fs`
 *   (`helpers/recorded-writes.js`), not through an injected seam.
 *
 * Checks marked PINNING pass before and after the change.
 */

import test from "node:test";
import assert from "node:assert/strict";
import nodeFs, { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { LocalObservations } from "../../services/encode/LocalObservations.js";
import { CompletedFiles } from "../../services/storage/files/CompletedFiles.js";
import { SegmentStore } from "../../services/storage/segment-store/SegmentStore.js";
import { installationId } from "../../services/identity/installation-id.js";
import { outputSpec } from "./helpers/output-spec.js";
import { recordWrites, whyNotAtomic } from "./helpers/recorded-writes.js";
import { until } from "./helpers/wait.js";

const FINGERPRINT = Object.freeze({ ffmpeg: "8.1.2", x264: "core 164", cpu: "test", threads: 4, devices: {} });
const CONTENT = { codec: "h264", bitDepth: 8, width: 1280, height: 720, megabitsPerSecond: 5 };
const SPEC = outputSpec({ transcodeVideo: true, width: 1280, height: 720, preset: "veryfast" });

const tempDir = (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "atomic-json-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }));
  return dir;
};

const loadWriter = async () => (await import("../../utils/atomic-json.js")).writeJsonAtomic;

/** An fs whose rename dies, as a process killed between the two steps does. */
const killedBeforeRename = { renameSync() { throw new Error("killed before the rename"); } };

/** An fs whose temporary file is left half written. */
const killedMidWrite = {
  writeFileSync(file, data, ...rest) {
    nodeFs.writeFileSync(file, String(data).slice(0, 5), ...rest);
    throw new Error("killed mid write");
  }
};

test("writeJsonAtomic replaces a file with the new value and leaves nothing beside it", async (t) => {
  const writeJsonAtomic = await loadWriter();
  const dir = tempDir(t);
  const file = path.join(dir, "state.json");
  writeJsonAtomic(file, { n: 1 });
  writeJsonAtomic(file, { n: 2, list: ["a"] });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { n: 2, list: ["a"] });
  assert.deepEqual(readdirSync(dir), ["state.json"], "a temporary file was left behind");
});

test("writeJsonAtomic never writes the final file itself: it renames a temporary one over it", async (t) => {
  const writeJsonAtomic = await loadWriter();
  const dir = tempDir(t);
  const file = path.join(dir, "state.json");
  const calls = [];
  writeJsonAtomic(file, { n: 1 }, {
    fs: {
      writeFileSync: (target, ...rest) => { calls.push(["write", target]); return nodeFs.writeFileSync(target, ...rest); },
      renameSync: (from, target) => { calls.push(["rename", from, target]); return nodeFs.renameSync(from, target); }
    }
  });
  assert.ok(calls.every(([op, target]) => op !== "write" || target !== file), "the final file was written in place");
  const rename = calls.find(([op]) => op === "rename");
  assert.ok(rename && rename[2] === file, "no rename onto the final file");
  assert.notEqual(rename[1], file);
  assert.equal(path.dirname(rename[1]), dir, "the temporary file must be beside the final one (same filesystem)");
});

test("a write interrupted between the temporary file and the rename leaves the previous file readable", async (t) => {
  const writeJsonAtomic = await loadWriter();
  const dir = tempDir(t);
  const file = path.join(dir, "state.json");
  writeJsonAtomic(file, { version: 1, kept: true });
  assert.throws(() => writeJsonAtomic(file, { version: 1, kept: false }, { fs: killedBeforeRename }), /killed before the rename/);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { version: 1, kept: true });
});

test("a write interrupted in the middle of the temporary file leaves the previous file readable", async (t) => {
  const writeJsonAtomic = await loadWriter();
  const dir = tempDir(t);
  const file = path.join(dir, "state.json");
  writeJsonAtomic(file, { version: 1, kept: true });
  assert.throws(() => writeJsonAtomic(file, { version: 1, kept: false }, { fs: killedMidWrite }), /killed mid write/);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { version: 1, kept: true });
});

test("LocalObservations saves through the writer it is handed", (t) => {
  const dir = tempDir(t);
  const filePath = path.join(dir, "local-observations.json");
  const saved = [];
  const observations = new LocalObservations({ fingerprint: FINGERPRINT, filePath, writeJson: (file, value) => saved.push([file, value]) });
  observations.load([]);
  observations.noteEncode({ spec: SPEC, content: CONTENT, aloneSpeedX: 2, segmentKbps: null });
  assert.equal(saved.length, 1, "the save did not go through the injected writer");
  assert.equal(saved[0][0], filePath);
  assert.equal(saved[0][1].version, 1);
  assert.equal(Object.values(saved[0][1].entries.speed).flat().length, 1);
});

test("a save interrupted before the rename leaves the previous local-observations.json readable by load()", (t) => {
  // The writer is written out here, so this check is about what LocalObservations
  // does with the writer it is given and not about utils/atomic-json.js.
  const writeJsonAtomic = (file, value, { interrupt = false } = {}) => {
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, JSON.stringify(value));
    if (interrupt) throw new Error("killed before the rename");
    nodeFs.renameSync(temporary, file);
  };
  const dir = tempDir(t);
  const filePath = path.join(dir, "local-observations.json");
  const warnings = [];
  const logger = { info: () => {}, warn: (line) => warnings.push(line) };

  const first = new LocalObservations({ fingerprint: FINGERPRINT, filePath, logger, writeJson: (file, value) => writeJsonAtomic(file, value) });
  first.load([]);
  first.noteEncode({ spec: SPEC, content: CONTENT, aloneSpeedX: 2, segmentKbps: null });
  const before = readFileSync(filePath, "utf8");

  const interrupted = new LocalObservations({
    fingerprint: FINGERPRINT,
    filePath,
    logger,
    writeJson: (file, value) => writeJsonAtomic(file, value, { interrupt: true })
  });
  interrupted.load([interrupted.modeKeyOf(SPEC).split("|")[0]]);
  interrupted.noteEncode({ spec: SPEC, content: CONTENT, aloneSpeedX: 5, segmentKbps: null });

  assert.equal(readFileSync(filePath, "utf8"), before, "the interrupted save changed the file");
  assert.equal(warnings.length, 1, "a failed save is a warning, not a crash and not silence");

  const restarted = new LocalObservations({ fingerprint: FINGERPRINT, filePath, logger });
  restarted.load([restarted.modeKeyOf(SPEC).split("|")[0]]);
  assert.equal(restarted.slowestAloneSpeed(SPEC, CONTENT), 2, "what was learned before the interruption is gone");
});

test("PINNING: LocalObservations without a file path saves nothing, and with one reads back what a restart finds", (t) => {
  const dir = tempDir(t);
  let calls = 0;
  const memoryOnly = new LocalObservations({ fingerprint: FINGERPRINT, filePath: "", writeJson: () => { calls += 1; } });
  memoryOnly.load([]);
  memoryOnly.noteEncode({ spec: SPEC, content: CONTENT, aloneSpeedX: 2, segmentKbps: null });
  assert.equal(calls, 0);

  const filePath = path.join(dir, "local-observations.json");
  const write = (file, value) => writeFileSync(file, JSON.stringify(value));
  const first = new LocalObservations({ fingerprint: FINGERPRINT, filePath, writeJson: write });
  first.load([]);
  first.noteEncode({ spec: SPEC, content: CONTENT, aloneSpeedX: 3, segmentKbps: null });
  const second = new LocalObservations({ fingerprint: FINGERPRINT, filePath, writeJson: write });
  second.load([second.modeKeyOf(SPEC).split("|")[0]]);
  assert.equal(second.slowestAloneSpeed(SPEC, CONTENT), 3);
});

test("the CompletedFiles manifest appears by a rename, never written in place", async (t) => {
  const root = tempDir(t);
  const infoHash = "abcdef0123456789abcdef0123456789abcdef01";
  const manifest = path.join(root, infoHash, "manifest.json");
  const { records, restore } = recordWrites(root);
  try {
    const files = new CompletedFiles({ root });
    const bytes = Buffer.from("a small film");
    await files.keep({ infoHash, fileIndex: 0, length: bytes.length, name: "film.mkv", open: () => Readable.from([bytes]) });
    await until(() => { try { readFileSync(manifest); return true; } catch { return false; } }, "the manifest to appear", { limitMs: 2_000 });
  } finally {
    restore();
  }
  assert.deepEqual(JSON.parse(readFileSync(manifest, "utf8")), { 0: { length: 12, name: "film.mkv" } });
  assert.equal(whyNotAtomic(records, manifest), null);
});

test("the SegmentStore key file appears by a rename, never written in place, and still names the key", (t) => {
  const root = tempDir(t);
  const key = "torrent:abc:fmt=fmp4:grid=kf@0:video-only:v=0/copy";
  const store = new SegmentStore({ root });
  t.after(() => store.dropAll("the check is over"));
  const { records, restore } = recordWrites(root);
  let dir;
  try {
    dir = store.directoryFor(key);
  } finally {
    restore();
  }
  const keyFile = path.join(dir, "key.txt");
  assert.ok(readFileSync(keyFile, "utf8").includes(key), "the key file no longer says what the directory is");
  assert.equal(whyNotAtomic(records, keyFile), null);
});

test("PINNING: the installation id is saved by a rename, survives a restart, and is not rewritten when unchanged", (t) => {
  const stateDir = tempDir(t);
  const file = path.join(stateDir, "proxy-identity.json");
  const { records, restore } = recordWrites(stateDir);
  try {
    assert.equal(installationId({ stateDir, makeId: () => "first-id" }), "first-id");
    assert.equal(installationId({ stateDir, makeId: () => "unexpected-id" }), "first-id");
  } finally {
    restore();
  }
  assert.equal(whyNotAtomic(records, file), null);
  assert.equal(records.filter((record) => record.op === "rename" && record.target === file).length, 1);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { id: "first-id" });
  assert.deepEqual(readdirSync(stateDir), ["proxy-identity.json"]);
});
