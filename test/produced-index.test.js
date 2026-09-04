/**
 * @file The session's one statement of what it has produced.
 *
 * Every check builds real directories and real files, because what is under
 * test is exactly the reading of them: which run's copy wins, what an empty
 * file counts as, and whether a directory that has not changed is read again.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from "node:fs";

import { ProducedIndex } from "../services/produced-index.js";

/** The naming the fMP4 format uses, reduced to what the index asks of it. */
const segmentFormat = {
  isSegmentFileName: (name) => /^segment-\d{5}\.mp4$/.test(name),
  segmentIndexFromName: (name) => {
    const match = /^segment-(\d{5})\.mp4$/.exec(name);
    return match ? Number(match[1]) : -1;
  }
};

const nameOf = (index) => `segment-${String(index).padStart(5, "0")}.mp4`;

function output() {
  const dirPath = mkdtempSync(path.join(os.tmpdir(), "produced-index-"));
  return {
    dirPath,
    write(index, contents) {
      writeFileSync(path.join(dirPath, nameOf(index)), contents);
      return path.join(dirPath, nameOf(index));
    },
    writeNamed(name, contents) {
      writeFileSync(path.join(dirPath, name), contents);
      return path.join(dirPath, name);
    },
    index: () => new ProducedIndex({ dirPath, segmentFormat }),
    remove: () => rmSync(dirPath, { recursive: true, force: true })
  };
}

test("a file with bytes in it is produced; one that was only opened is not", () => {
  const s = output();
  try {
    s.write(1, "a piece");
    s.write(2, "");
    const index = s.index();

    assert.deepEqual([...index.segmentNumbers()], [1]);
    assert.equal(index.pathOf(nameOf(1)), path.join(s.dirPath, nameOf(1)));
    // The empty file exists and is not an answer — this is the pair of beliefs
    // that stopped playback for ten minutes on 2026-09-03, now one belief.
    assert.equal(index.pathOf(nameOf(2)), null);
  } finally {
    s.remove();
  }
});



test("a file that is not a segment is found by name", () => {
  const s = output();
  try {
    s.writeNamed("init.mp4", "header");
    const index = s.index();
    assert.equal(index.pathOf("init.mp4"), path.join(s.dirPath, "init.mp4"));
    assert.ok(index.fileNames().includes("init.mp4"));
  } finally {
    s.remove();
  }
});

test("a directory that is gone stops answering", () => {
  const s = output();
  try {
    s.write(4, "piece");
    const index = s.index();
    assert.equal(index.segmentNumbers().size, 1);

    rmSync(s.dirPath, { recursive: true, force: true });
    assert.equal(index.segmentNumbers().size, 0);
    assert.equal(index.pathOf(nameOf(4)), null);
  } finally {
    s.remove();
  }
});

test("a file removed on purpose is not still an answer", () => {
  const s = output();
  try {
    const written = s.write(9, "piece");
    const index = s.index();
    assert.equal(index.pathOf(nameOf(9)), written);

    unlinkSync(written);
    // The directory's own time has moved, but a caller that deletes and asks in
    // the same tick must not be told the file is there.
    index.invalidate();
    assert.equal(index.pathOf(nameOf(9)), null);
  } finally {
    s.remove();
  }
});

test("an unchanged directory is not listed again", () => {
  const s = output();
  try {
    s.write(1, "piece");
    const index = s.index();

    index.segmentNumbers();
    assert.equal(index.directoryReads, 1, "the first question reads what is there and no more");

    for (let asked = 0; asked < 20; asked += 1) {
      index.segmentNumbers();
      index.pathOf(nameOf(1));
    }
    assert.equal(
      index.directoryReads,
      1,
      "forty more questions about a directory that has not changed must read nothing"
    );

    s.write(2, "another piece");
    index.segmentNumbers();
    assert.equal(index.directoryReads, 2, "a directory that gained a file is read once more");
  } finally {
    s.remove();
  }
});

test("an output directory that does not exist answers with nothing", () => {
  const index = new ProducedIndex({
    dirPath: path.join(os.tmpdir(), "produced-index-absent-0000"),
    segmentFormat
  });
  assert.equal(index.pathOf(nameOf(1)), null);
  assert.deepEqual([...index.segmentNumbers()], []);
});
