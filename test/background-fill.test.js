/**
 * Fetching a file nobody is playing yet, without taking anything from the
 * viewer.
 *
 * The ordering these checks pin is the whole point of the thing: what plays now
 * comes first, the other soundtracks and subtitle files next, and reading the
 * film far ahead last. The middle tier stays below the first by standing aside
 * whenever a reader on the torrent is inside a wait.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { fillFileInBackground, fillIsRunning } from "../services/torrent-worker/background-fill.js";

/**
 * A file whose reads resolve when the test says so, recording what was asked
 * for.
 *
 * @param {{ length: number, name?: string }} params
 */
function fakeFile({ length, name = "dub.mka" }) {
  const reads = [];
  return {
    name,
    length,
    reads,
    createReadStream({ start, end }) {
      const stream = new EventEmitter();
      stream.destroy = () => {};
      reads.push({ start, end });
      // Deliver on the next turn, so a test can observe the read in flight.
      queueMicrotask(() => {
        stream.emit("data", Buffer.alloc(end - start + 1));
        stream.emit("end");
      });
      return stream;
    }
  };
}

/**
 * @param {() => boolean} until
 * @param {number} [limit]
 */
async function waitFor(until, limit = 2000) {
  const deadline = Date.now() + limit;
  while (!until()) {
    if (Date.now() > deadline) {
      throw new Error("condition was never reached");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a file is walked whole, a piece at a time", async () => {
  const file = fakeFile({ length: 10 });
  const torrent = { infoHash: "aaa", pieceLength: 4, files: [file] };

  const started = fillFileInBackground(torrent, 0, "source-a", { chunkBytes: 4 });

  assert.equal(started, true);
  await waitFor(() => !fillIsRunning("source-a", 0));
  // 0-3, 4-7, 8-9: the last chunk is short because the file ends, and its end
  // is the last byte rather than one past it.
  assert.deepEqual(file.reads, [
    { start: 0, end: 3 },
    { start: 4, end: 7 },
    { start: 8, end: 9 }
  ]);
});

test("one fill per file, however many times it is asked for", async () => {
  const file = fakeFile({ length: 8 });
  const torrent = { infoHash: "bbb", pieceLength: 4, files: [file] };

  const first = fillFileInBackground(torrent, 0, "source-b", { chunkBytes: 4 });
  const second = fillFileInBackground(torrent, 0, "source-b", { chunkBytes: 4 });

  assert.equal(first, true);
  assert.equal(second, false, "the second call does not start a second walk");
  await waitFor(() => !fillIsRunning("source-b", 0));
  assert.equal(file.reads.length, 2, "the file was walked once");
});

test("a file that is gone is not read, and does not throw", async () => {
  const torrent = { infoHash: "ccc", pieceLength: 4, files: [] };

  const started = fillFileInBackground(torrent, 0, "source-c", { chunkBytes: 4 });

  assert.equal(started, false);
  assert.equal(fillIsRunning("source-c", 0), false);
});

test("a read that returns nothing stops the walk instead of spinning", async () => {
  const file = {
    name: "dub.mka",
    length: 100,
    reads: [],
    createReadStream({ start, end }) {
      const stream = new EventEmitter();
      stream.destroy = () => {};
      this.reads.push({ start, end });
      queueMicrotask(() => stream.emit("error", new Error("gone")));
      return stream;
    }
  };
  const torrent = { infoHash: "ddd", pieceLength: 10, files: [file] };

  fillFileInBackground(torrent, 0, "source-d", { chunkBytes: 10 });

  await waitFor(() => !fillIsRunning("source-d", 0));
  assert.equal(file.reads.length, 1, "it gave up after the first failed read");
});

test("it stands aside while the viewer's own reading is blocked", async () => {
  const file = fakeFile({ length: 8 });
  const torrent = { infoHash: "eee", pieceLength: 4, files: [file] };
  let blocked = true;

  fillFileInBackground(torrent, 0, "source-e", { chunkBytes: 4, isBlocked: () => blocked });

  // The picture is starving, so nothing is asked of the swarm on the
  // soundtrack's behalf — however long that lasts.
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(file.reads, [], "not one read while a reader is inside a wait");

  blocked = false;
  await waitFor(() => !fillIsRunning("source-e", 0));
  assert.equal(file.reads.length, 2, "and it resumes once the room is there");
});

test("the gate is re-asked before every chunk, not once at the start", async () => {
  const file = fakeFile({ length: 12 });
  const torrent = { infoHash: "fff", pieceLength: 4, files: [file] };
  // Starve the viewer again the moment the first chunk has been read, and stay
  // that way until the test lifts it.
  let starvedAfterFirstChunk = false;
  let lifted = false;
  const isBlocked = () => {
    if (file.reads.length >= 1 && !lifted) {
      starvedAfterFirstChunk = true;
    }
    return starvedAfterFirstChunk && !lifted;
  };

  fillFileInBackground(torrent, 0, "source-f", { chunkBytes: 4, isBlocked });

  await waitFor(() => file.reads.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(file.reads.length, 1, "a torrent healthy a moment ago is not evidence about now");

  lifted = true;
  await waitFor(() => !fillIsRunning("source-f", 0));
  assert.equal(file.reads.length, 3);
});
