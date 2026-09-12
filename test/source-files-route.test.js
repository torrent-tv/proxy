/**
 * @file WHAT THE BROWSER IS TOLD IS IN A TORRENT.
 *
 * This is the one place the product answers it. The browser used to answer it
 * as well — a list of video extensions in its parser and a second, shorter pair
 * inside its picker — and the three had already diverged: measured 2026-09-12,
 * `.dat` was offered there as video and not counted here, which also decides
 * whether a sidecar whose name matches nothing can belong to the only video
 * present.
 *
 * So the shape of this answer is a contract with the page, and the page shows
 * what it is given without looking at a name.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { handleApiSourceFilesGet } from "../routes/api/sources/files/get.js";

/**
 * A request, a reply and the torrent behind them.
 *
 * @param {Array<{ path: string, length: number }>} files
 * @returns {{ req: object, reply: object, sent: { body: object | null, code: number }, deps: object }}
 */
function harness(files) {
  const sent = { body: null, code: 200 };
  const reply = {
    code(value) {
      sent.code = value;
      return reply;
    },
    send(body) {
      sent.body = body;
      return reply;
    }
  };
  const deps = {
    sourceRegistry: { get: () => ({ sourceType: "magnet", source: "magnet:?xt=urn:btih:abc" }) },
    torrentPool: {
      async getTorrent() {
        return { name: "Drifters", infoHash: "abc", files };
      }
    }
  };
  return { req: { params: { sourceKey: "key" }, query: {} }, reply, sent, deps };
}

test("the files come back in reading order, each saying what it is", () => {
  const { req, reply, sent, deps } = harness([
    { path: "Drifters/ep 10.mkv", length: 9 },
    { path: "Drifters/ep 2.mkv", length: 9 },
    { path: "Drifters/Rus Sound/ep 2.mka", length: 2 },
    { path: "Drifters/notes.nfo", length: 1 }
  ]);

  return handleApiSourceFilesGet(req, reply, deps).then(() => {
    assert.equal(sent.code, 200);
    assert.deepEqual(
      sent.body.files.map((file) => [file.relativePath, file.kind]),
      [
        // Runs of digits compare as numbers, so 2 comes before 10; the torrent's
        // own order is whatever the tool that made it chose.
        ["ep 2.mkv", "video"],
        ["ep 10.mkv", "video"],
        ["notes.nfo", "other"],
        ["Rus Sound/ep 2.mka", "audio"]
      ]
    );
    // Relative to the torrent root: WebTorrent prefixes its own name to every
    // path, and stripping it here means one rule in the product rather than two
    // that can disagree.
    assert.ok(sent.body.files.every((file) => !file.relativePath.startsWith("Drifters/")));
  });
});

test("each picture is named with what belongs to it, by index", () => {
  const { req, reply, sent, deps } = harness([
    { path: "Drifters/ep 1.mkv", length: 9 },
    { path: "Drifters/Rus Sound/ep 1.mka", length: 2 },
    { path: "Drifters/Sub/ep 1.ass", length: 1 },
    { path: "Drifters/ep 2.mkv", length: 9 }
  ]);

  return handleApiSourceFilesGet(req, reply, deps).then(() => {
    assert.deepEqual(sent.body.items, [
      { fileIndex: 0, audio: [1], subtitles: [2], images: [] },
      { fileIndex: 3, audio: [], subtitles: [], images: [] }
    ]);
    // The files themselves are in the list above; saying them twice is how two
    // copies of one fact start.
    assert.ok(sent.body.items.every((item) => item.audio.every((one) => Number.isInteger(one))));
  });
});

test("a torrent whose metadata has not arrived says so and lists nothing", () => {
  const { req, reply, sent, deps } = harness([]);

  return handleApiSourceFilesGet(req, reply, deps).then(() => {
    assert.deepEqual(sent.body.files, []);
    assert.deepEqual(sent.body.items, []);
    assert.equal(sent.body.name, "Drifters");
  });
});
