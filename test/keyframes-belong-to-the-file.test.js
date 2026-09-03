/**
 * @file Where a file's keyframes are is a fact of the file, not of a session.
 *
 * It is a property of immutable bytes, like the duration and the track list, so
 * a second reading could only agree. Two sessions created in the same moment
 * used to read it twice — which is what two viewers opening one film do,
 * measured 13 ms apart on 2026-09-03 — and the answer decides whether the
 * picture can be copied at all, so it has to be one answer.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { HlsSessionManager } from "../services/hls-session-manager.js";
import { Container } from "../services/container/Container.js";

/**
 * @returns {HlsSessionManager}
 */
function manager() {
  return new HlsSessionManager({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090
  });
}

test("two sessions asking at once make one read and join one wait", async () => {
  const session = manager();
  let reads = 0;
  let answer = null;
  session.getContainerKeyframes = () => {
    reads += 1;
    return new Promise((resolve) => {
      answer = resolve;
    });
  };

  const first = session.warmKeyframeIndex({ sourceKey: "torrent:abc", fileIndex: 0, logName: "a.mkv" });
  const second = session.warmKeyframeIndex({ sourceKey: "torrent:abc", fileIndex: 0, logName: "a.mkv" });
  assert.equal(reads, 1, "the second asker joined the read already running");

  answer({ times: [0, 4, 8], tolerance: 0 });
  await Promise.all([first, second]);
  assert.equal(reads, 1);
});

test("the answer is remembered for the file, so a later session reads nothing", async () => {
  const session = manager();
  let reads = 0;
  session.getContainerKeyframes = async () => {
    reads += 1;
    return { times: [0, 4, 8], tolerance: 0 };
  };

  await session.warmKeyframeIndex({ sourceKey: "torrent:abc", fileIndex: 0, logName: "a.mkv" });
  await session.warmKeyframeIndex({ sourceKey: "torrent:abc", fileIndex: 0, logName: "a.mkv" });

  assert.equal(reads, 1);
});

test("two files of one torrent are two answers", async () => {
  const session = manager();
  const asked = [];
  session.getContainerKeyframes = async ({ fileIndex }) => {
    asked.push(fileIndex);
    return { times: [0, 4], tolerance: 0 };
  };

  await session.warmKeyframeIndex({ sourceKey: "torrent:abc", fileIndex: 0, logName: "a.mkv" });
  await session.warmKeyframeIndex({ sourceKey: "torrent:abc", fileIndex: 1, logName: "b.mkv" });

  assert.deepEqual(asked, [0, 1]);
});

test("a file with no readable index says so once, and keeps saying it", async () => {
  const session = manager();
  let reads = 0;
  session.getContainerKeyframes = async () => {
    reads += 1;
    return null;
  };

  await session.warmKeyframeIndex({ sourceKey: "torrent:abc", fileIndex: 0, logName: "a.ts" });
  await session.warmKeyframeIndex({ sourceKey: "torrent:abc", fileIndex: 0, logName: "a.ts" });

  // "No index" is an answer about the file — it is what makes a copy of it
  // re-encode instead — and it must be the same answer for every viewer.
  assert.equal(reads, 1);
});

test("a container reads its own table once", async () => {
  let parses = 0;
  class OneTable extends Container {
    async parseKeyframeIndex() {
      parses += 1;
      return { times: [0, 2, 4], tolerance: 0 };
    }
  }
  const container = new OneTable({ readRange: async () => null, fileSize: 10 });

  const [first, second] = await Promise.all([
    container.readKeyframeIndex(),
    container.readKeyframeIndex()
  ]);
  await container.readKeyframeIndex();

  assert.equal(parses, 1);
  assert.deepEqual(first, second);
});

test("a read that threw is not remembered as an answer", async () => {
  let parses = 0;
  class Late extends Container {
    async parseKeyframeIndex() {
      parses += 1;
      if (parses === 1) {
        // The bytes it needed had not arrived yet, which is not a statement
        // about the file.
        throw new Error("nothing to read there yet");
      }
      return { times: [0, 2], tolerance: 0 };
    }
  }
  const container = new Late({ readRange: async () => null, fileSize: 10 });

  await assert.rejects(() => container.readKeyframeIndex());
  const second = await container.readKeyframeIndex();

  assert.equal(parses, 2);
  assert.deepEqual(second.times, [0, 2]);
});
