/**
 * @file Where a file's keyframes are is a fact of the file, not of a session.
 *
 * It is a property of immutable bytes, like the duration and the track list, so
 * a second reading could only agree. Two sessions created in the same moment
 * used to read it twice — which is what two viewers opening one film do,
 * measured 13 ms apart on 2026-09-03 — and the answer decides whether the
 * picture can be copied at all, so it has to be one answer.
 *
 * And it has to be one OBJECT, not one value: a session created while the read
 * is still running must see the answer when it lands. Held as a value it could
 * not, and the read that outran its budget was lost to every session already
 * made.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { KeyframeTables } from "../../services/media/KeyframeTables.js";
import { KeyframeTable } from "../../services/media/container/KeyframeTable.js";
import { Container } from "../../services/media/container/Container.js";

const QUIET = { info: () => {}, warn: () => {} };

/**
 * @param {(params: object) => Promise<object | null>} readTable
 * @param {number} [budgetMs]
 * @returns {KeyframeTables}
 */
function tables(readTable, budgetMs = 1_000) {
  return new KeyframeTables({ readTable, budgetMs, logger: QUIET });
}

const FILE = { sourceKey: "torrent:abc", fileIndex: 0, logName: "a.mkv" };

test("two askers at once make one read and join one wait", async () => {
  let reads = 0;
  let answer = null;
  const keyframes = tables(() => {
    reads += 1;
    return new Promise((resolve) => {
      answer = resolve;
    });
  });

  const first = keyframes.warm(FILE);
  const second = keyframes.warm(FILE);
  assert.equal(reads, 1, "the second asker joined the read already running");

  answer({ times: [0, 4, 8], tolerance: 0, format: "matroska" });
  await Promise.all([first, second]);
  assert.equal(reads, 1);
});

test("the answer is remembered for the file, so a later asker reads nothing", async () => {
  let reads = 0;
  const keyframes = tables(async () => {
    reads += 1;
    return { times: [0, 4, 8], tolerance: 0, format: "matroska" };
  });

  await keyframes.warm(FILE);
  await keyframes.warm(FILE);

  assert.equal(reads, 1);
});

test("two files of one torrent are two answers", async () => {
  const asked = [];
  const keyframes = tables(async ({ fileIndex }) => {
    asked.push(fileIndex);
    return { times: [0, 4], tolerance: 0, format: "matroska" };
  });

  await keyframes.warm({ sourceKey: "torrent:abc", fileIndex: 0, logName: "a.mkv" });
  await keyframes.warm({ sourceKey: "torrent:abc", fileIndex: 1, logName: "b.mkv" });

  assert.deepEqual(asked, [0, 1]);
});

test("a file with no readable index says so once, and keeps saying it", async () => {
  let reads = 0;
  const keyframes = tables(async () => {
    reads += 1;
    return null;
  });

  await keyframes.warm({ sourceKey: "torrent:abc", fileIndex: 0, logName: "a.ts" });
  await keyframes.warm({ sourceKey: "torrent:abc", fileIndex: 0, logName: "a.ts" });

  // "No index" is an answer about the file — it is what makes a copy of it
  // re-encode instead — and it must be the same answer for every viewer.
  assert.equal(reads, 1);
  const table = keyframes.of(FILE);
  assert.equal(table.answered, true, "something came back");
  assert.equal(table.readable, false, "and what came back was nothing");
});

test("a table read after a session was made still reaches it", async () => {
  let answer = null;
  const keyframes = tables(() => new Promise((resolve) => { answer = resolve; }), 30);

  const table = keyframes.of(FILE);
  const waiting = keyframes.within(FILE);
  assert.equal(table.answered, false);
  answer({ times: [0, 4, 8], tolerance: 0, format: "matroska" });
  assert.equal((await waiting).arrived, true);

  // The session is holding THIS object, so the late answer is in its hands
  // without anybody having gone round telling it.
  assert.equal(table.answered, true);
  assert.deepEqual(table.times, [0, 4, 8]);
  assert.equal(keyframes.of(FILE), table, "and the file still has one table, not two");
});

test("a read that threw is not an answer, and the next asker reads again", async () => {
  let reads = 0;
  const keyframes = tables(async () => {
    reads += 1;
    if (reads === 1) {
      // The bytes it needed had not arrived. That says nothing about the file,
      // and recording it as "no keyframes" would re-encode every picture of
      // this file for as long as the process lives.
      throw new Error("the head is not downloaded");
    }
    return { times: [0, 6], tolerance: 0, format: "matroska" };
  });

  await assert.rejects(() => keyframes.read(FILE), /the head is not downloaded/);
  assert.equal(keyframes.of(FILE).answered, false);

  await keyframes.warm(FILE);
  const table = keyframes.of(FILE);

  assert.equal(reads, 2, "it was read again rather than refused from a cached failure");
  assert.deepEqual(table.times, [0, 6]);
});

test("the packet probe never displaces a fuller table", () => {
  const keyframes = tables(async () => ({ times: [0, 2, 4, 6, 8], tolerance: 0, format: "matroska" }));
  keyframes.learn(FILE, { times: [0, 2, 4, 6, 8], format: "matroska" });

  // Measured 2026-08-02: a packet scan found 77 keyframes in 45 s without
  // finishing, against all 570 in 0.8 s from the container's own index.
  keyframes.learn(FILE, { times: [0, 8], format: "packet probe" });

  const table = keyframes.of(FILE);
  assert.deepEqual(table.times, [0, 2, 4, 6, 8]);
  assert.equal(table.format, "matroska");
});

test("the packet probe IS the answer where no container index exists", () => {
  const keyframes = tables(async () => null);
  keyframes.learn(FILE, { times: null, format: "mpegts" });
  assert.equal(keyframes.of(FILE).readable, false);

  keyframes.learn(FILE, { times: [0, 3, 6], format: "packet probe" });

  assert.deepEqual(keyframes.of(FILE).times, [0, 3, 6]);
});

test("a registry with no reader says nothing about the file rather than lying about it", async () => {
  const keyframes = new KeyframeTables({ logger: QUIET });

  await keyframes.warm(FILE);
  const table = keyframes.of(FILE);

  assert.equal(table.readable, false, "there is no table, so a picture of this file is re-encoded");
  assert.equal(
    table.answered,
    false,
    "and nothing has ANSWERED — a proxy wired without a reader is not a statement about anybody's bytes"
  );
});

test("a table nobody holds is dropped, and one still being read is not", async () => {
  let answer = null;
  const keyframes = tables(() => new Promise((resolve) => { answer = resolve; }));
  const held = keyframes.of({ sourceKey: "torrent:abc", fileIndex: 0 });
  const dropped = keyframes.of({ sourceKey: "torrent:abc", fileIndex: 1 });
  void keyframes.warm({ sourceKey: "torrent:abc", fileIndex: 2, logName: "c.mkv" });
  const reading = keyframes.of({ sourceKey: "torrent:abc", fileIndex: 2 });

  keyframes.forgetUnused(new Set([held]));

  assert.equal(keyframes.of({ sourceKey: "torrent:abc", fileIndex: 0 }), held);
  assert.notEqual(keyframes.of({ sourceKey: "torrent:abc", fileIndex: 1 }), dropped);
  assert.equal(
    keyframes.of({ sourceKey: "torrent:abc", fileIndex: 2 }),
    reading,
    "dropping a file whose read is in flight loses the answer and pays the whole wait again"
  );
  answer(null);
});

test("the container reads and does not remember — one fact, one store", async () => {
  // It used to keep the answer, which made this table the one fact in the proxy
  // stored twice: here, and in the file's own `KeyframeTable`. Traced
  // 2026-09-15, this copy had no reader: nothing in the torrent thread asks
  // where a file's keyframes are, and the one path to it ends at
  // `KeyframeTables` on the other side of the channel.
  let parses = 0;
  class Counting extends Container {
    async parseKeyframeIndex() {
      parses += 1;
      return { times: [0, 2, 4], tolerance: 0 };
    }
  }
  const container = new Counting({ readRange: async () => null, fileSize: 10 });

  await container.readKeyframeIndex();
  await container.readKeyframeIndex();

  assert.equal(parses, 2, "a container that keeps the answer is a second owner of it");
});

test("reading once per file is the table registry's job, and it also bounds the wait", async () => {
  // Where the guarantee went. It is not merely moved: this is the only place
  // that can ALSO stop a viewer waiting for ever while letting the read finish,
  // which a container cannot — it does not know there is a viewer.
  let parses = 0;
  class Counting extends Container {
    async parseKeyframeIndex() {
      parses += 1;
      return { times: [0, 2, 4], tolerance: 0 };
    }
  }
  const container = new Counting({ readRange: async () => null, fileSize: 10 });
  const keyframes = tables(() => container.readKeyframeIndex());

  await Promise.all([keyframes.read(FILE), keyframes.read(FILE)]);
  await keyframes.read(FILE);

  assert.equal(parses, 1);
  assert.deepEqual(keyframes.of(FILE).times, [0, 2, 4]);
});

test("answered and readable are two questions, and a bag of fields cannot tell them apart", () => {
  const table = new KeyframeTable();
  assert.equal(table.answered, false);
  assert.equal(table.readable, false);
  assert.equal(table.format, "not yet read");

  table.learn({ times: null, format: "mpegts" });

  assert.equal(table.answered, true, "the container came back");
  assert.equal(table.readable, false, "with no keyframes, which is permanent for this file");
  assert.equal(table.format, "mpegts", "and the refusal can name what it is refusing");
});

test("a container that says a copy loses the picture order is carried through, and not overruled", async () => {
  // AVI states decoding order only; an H.264 picture in it may reorder (torrent-tv/meta#151).
  const keyframes = tables(async () => ({ times: [0, 2, 4], tolerance: 0, copyable: false, format: "avi" }));
  await keyframes.warm(FILE);
  const table = keyframes.of(FILE);
  assert.equal(table.readable, true);
  assert.equal(table.copyable, false);
  table.learn({ times: [0, 2, 4, 6], format: "packets" });
  assert.equal(table.copyable, false, "a fuller reading that says nothing keeps the container's statement");
  assert.equal(new KeyframeTable().learn({ times: [0, 2] }).copyable, true, "a table that says nothing is copyable");
});
