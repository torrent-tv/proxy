/**
 * @file The guard that makes a real torrent impossible is in force.
 *
 * `npm test` loads test/no-torrent/support/refuse-torrent.cjs with `--require`. If that ever
 * stops happening, these checks fail. Nothing here constructs WebTorrent before confirming
 * that the module loaded is the refusing class, so a missing guard is a failure and never a
 * started client. The static check lets this one file name WebTorrent for that reason.
 *
 * The guard is deliberately not imported here: importing it would switch it on for this
 * file and hide that `--require` had stopped loading it.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";

import WebTorrent from "webtorrent";

const REFUSED = Symbol.for("torrent-tv.refused-torrent");
const REFUSAL = /^a check in test\/no-torrent\/ tried to start a real torrent/;

test("WebTorrent is the refusing class, and constructing it throws", () => {
  assert.equal(WebTorrent[REFUSED], true, "webtorrent resolved to the library: the guard is not loaded");
  assert.throws(() => new WebTorrent(), { message: REFUSAL });
});

test("a worker thread a check creates gets the refusing class too", async () => {
  const code = `
    const { parentPort } = require("node:worker_threads");
    import("webtorrent").then(({ default: WebTorrent }) => {
      if (WebTorrent[Symbol.for("torrent-tv.refused-torrent")] !== true) {
        parentPort.postMessage("webtorrent resolved to the library: the guard is not loaded");
        return;
      }
      try { new WebTorrent(); parentPort.postMessage("constructed"); }
      catch (error) { parentPort.postMessage(error.message); }
    }, (error) => parentPort.postMessage(error.message));
  `;
  const worker = new Worker(code, { eval: true });
  const message = await new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
  await worker.terminate();
  assert.match(message, REFUSAL);
});

test("a DHT node, a tracker client and local peer discovery cannot be loaded", async () => {
  for (const name of ["bittorrent-dht", "bittorrent-tracker", "bittorrent-lsd", "torrent-discovery"]) {
    await assert.rejects(import(name), { message: new RegExp(`${REFUSAL.source}: it imported ${name}$`) });
  }
});
