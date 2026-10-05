/**
 * The worker's memory line says how many torrents and uTP connections it still
 * holds. On 2026-10-04 a heap snapshot found 957 uTP sockets whose close never
 * came back and 595 destroyed torrents they kept alive; none of it was in any
 * figure printed. No torrent and no socket are made here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { describeHeldObjects } from "../../services/torrent/worker/held-objects.js";
import { destroyedTorrents, noteTorrentDestroyed } from "../../services/torrent/destroyed-torrents.js";

test("the clause names live torrents, destroyed ones not yet collected, and uTP", () => {
  assert.equal(
    describeHeldObjects({
      liveTorrents: 1,
      destroyed: { total: 671, notCollected: 595 },
      utp: { sockets: 958, connections: 964, closing: 580 }
    }),
    "torrents 1 live, 595 destroyed and not collected (671 destroyed in all); " +
      "uTP 958 socket(s), 964 connection(s), 580 destroyed and still closing"
  );
});

test("without a uTP module that counts, the clause says only what it knows", () => {
  assert.equal(
    describeHeldObjects({ liveTorrents: 0, destroyed: { total: 0, notCollected: 0 }, utp: null }),
    "torrents 0 live, 0 destroyed and not collected (0 destroyed in all)"
  );
});

test("a destroyed torrent is counted once however often it is said", () => {
  const before = destroyedTorrents();
  const torrent = {};
  noteTorrentDestroyed(torrent);
  noteTorrentDestroyed(torrent);
  noteTorrentDestroyed(null);
  const after = destroyedTorrents();
  assert.equal(after.total - before.total, 1);
  assert.equal(after.notCollected - before.notCollected, 1);
});
