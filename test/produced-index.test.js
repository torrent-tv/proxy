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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from "node:fs";

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

function session() {
  const dirPath = mkdtempSync(path.join(os.tmpdir(), "produced-index-"));
  return {
    dirPath,
    run(number) {
      const dir = path.join(dirPath, `run-${number}`);
      mkdirSync(dir, { recursive: true });
      return {
        dir,
        write(index, contents) {
          writeFileSync(path.join(dir, nameOf(index)), contents);
          return path.join(dir, nameOf(index));
        },
        writeNamed(name, contents) {
          writeFileSync(path.join(dir, name), contents);
          return path.join(dir, name);
        }
      };
    },
    index: () => new ProducedIndex({ dirPath, segmentFormat }),
    remove: () => rmSync(dirPath, { recursive: true, force: true })
  };
}

test("a file with bytes in it is produced; one that was only opened is not", () => {
  const s = session();
  try {
    const run = s.run(1);
    run.write(1, "a piece");
    run.write(2, "");
    const index = s.index();

    assert.deepEqual([...index.segmentNumbers()], [1]);
    assert.equal(index.pathOf(nameOf(1)), path.join(run.dir, nameOf(1)));
    // The empty file exists and is not an answer — this is the pair of beliefs
    // that stopped playback for ten minutes on 2026-09-03, now one belief.
    assert.equal(index.pathOf(nameOf(2)), null);
  } finally {
    s.remove();
  }
});

test("the newest run's copy wins, whichever run was read last", () => {
  const s = session();
  try {
    const first = s.run(1);
    first.write(7, "old");
    const second = s.run(2);
    second.write(7, "new");
    const index = s.index();

    assert.equal(index.pathOf(nameOf(7)), path.join(second.dir, nameOf(7)));

    // Touching the OLDER run must not make it the answer: the rule is applied
    // when the question is asked, not when a directory happens to be read.
    first.write(8, "older still");
    assert.equal(index.pathOf(nameOf(7)), path.join(second.dir, nameOf(7)));
    assert.equal(index.pathOf(nameOf(8)), path.join(first.dir, nameOf(8)));
  } finally {
    s.remove();
  }
});

test("the union of every run is what the session holds", () => {
  const s = session();
  try {
    s.run(1).write(1, "x");
    s.run(2).write(2, "y");
    s.run(3).write(3, "z");
    const index = s.index();
    assert.deepEqual([...index.segmentNumbers()].sort((a, b) => a - b), [1, 2, 3]);
  } finally {
    s.remove();
  }
});

test("a file that is not a segment is found by name", () => {
  const s = session();
  try {
    const run = s.run(1);
    run.writeNamed("init.mp4", "header");
    const index = s.index();
    assert.equal(index.pathOf("init.mp4"), path.join(run.dir, "init.mp4"));
    assert.ok(index.fileNames().includes("init.mp4"));
  } finally {
    s.remove();
  }
});

test("a run whose directory is gone stops answering", () => {
  const s = session();
  try {
    const run = s.run(1);
    run.write(4, "piece");
    const index = s.index();
    assert.equal(index.segmentNumbers().size, 1);

    rmSync(run.dir, { recursive: true, force: true });
    assert.equal(index.segmentNumbers().size, 0);
    assert.equal(index.pathOf(nameOf(4)), null);
  } finally {
    s.remove();
  }
});

test("a file removed on purpose is not still an answer", () => {
  const s = session();
  try {
    const run = s.run(1);
    const written = run.write(9, "piece");
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

test("an unchanged run is not listed again", () => {
  const s = session();
  try {
    const run = s.run(1);
    run.write(1, "piece");
    const index = s.index();

    index.segmentNumbers();
    const afterFirst = index.directoryReads;
    assert.equal(afterFirst, 1, "the first question reads the run");

    for (let asked = 0; asked < 20; asked += 1) {
      index.segmentNumbers();
      index.pathOf(nameOf(1));
    }
    assert.equal(
      index.directoryReads,
      afterFirst,
      "forty more questions about a run that has not changed must read nothing"
    );

    run.write(2, "another piece");
    index.segmentNumbers();
    assert.equal(index.directoryReads, afterFirst + 1, "a run that gained a file is read once more");
  } finally {
    s.remove();
  }
});

test("a session directory that does not exist answers with nothing", () => {
  const index = new ProducedIndex({
    dirPath: path.join(os.tmpdir(), "produced-index-absent-0000"),
    segmentFormat
  });
  assert.deepEqual(index.runDirs(), []);
  assert.equal(index.pathOf(nameOf(1)), null);
  assert.deepEqual([...index.segmentNumbers()], []);
});
