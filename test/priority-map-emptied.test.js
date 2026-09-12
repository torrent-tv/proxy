/**
 * @file WHEN NOBODY WANTS A FILE ANY MORE, THE MAP SAYS SO.
 *
 * The map is the only statement of what is wanted, and until 2.83.4 it could
 * make only one of the two statements it exists for. A file whose viewers had
 * gone was deleted from the orchestrator's own memory and published nowhere, so
 * the bands it had stated on the swarm's behalf stood until the torrent itself
 * was removed — read from the demand register, a film nobody had watched for an
 * hour was indistinguishable from one being watched now.
 *
 * Two halves, and both are here: the side that builds the map has to say it,
 * and the side that receives it has to act on it without needing the file's
 * length, the torrent's list, or the torrent to exist at all.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PriorityOrchestrator } from "../services/priority/PriorityOrchestrator.js";
import { Viewers } from "../services/viewer/Viewers.js";
import { viewersOf } from "../services/viewer/Viewer.js";
import { TorrentPool } from "../services/torrent-pool.js";
import { demandFor, forgetTorrent } from "../services/download/registry.js";
import { Urgency } from "../services/demand/index.js";

const STALE_AFTER_MS = 60_000;

/**
 * A session, as much of one as the orchestrator reads.
 *
 * @param {{ id: string, fileIndex?: number }} params
 * @returns {object}
 */
function outputOf({ id, fileIndex = 0 }) {
  return {
    id,
    outputKey: `out:${id}`,
    sourceKey: "source-1",
    fileIndex,
    file: { key: `film-${fileIndex}`, durationSeconds: 600 }
  };
}

/**
 * The real orchestrator, with everything it publishes kept.
 *
 * @param {object[]} sessions
 * @returns {{ priority: PriorityOrchestrator, viewers: Viewers, published: object[], publish: (sessions?: object[]) => void }}
 */
function over(sessions) {
  const published = [];
  const viewers = new Viewers();
  const priority = new PriorityOrchestrator({
    publish: (one) => published.push(one),
    viewersOf: (session) => viewersOf(session),
    allowanceFor: () => 10
  });
  return {
    priority,
    viewers,
    published,
    publish: (live = sessions) =>
      priority.publishFor({ sessionGroups: [live], staleAfterMs: STALE_AFTER_MS })
  };
}

test("a file whose viewers have all gone is published as wanting nothing", () => {
  const picture = outputOf({ id: "pic" });
  const { viewers, published, publish } = over([picture]);
  const person = viewers.of(picture, "p");
  person.moveTo(300);
  publish();
  assert.ok(published.at(-1).zones.length > 0, "somebody is watching, so something is wanted");

  // They stop answering. The session is still there — it outlives them by half
  // an hour — so this is the case that used to say nothing at all.
  person.seen(Date.now() - STALE_AFTER_MS * 2);
  publish();

  const last = published.at(-1);
  assert.deepEqual(last.zones, []);
  assert.equal(last.sourceKey, "source-1");
  assert.equal(last.fileIndex, 0);
});

test("a file whose session has gone is published as wanting nothing, once", () => {
  const picture = outputOf({ id: "pic" });
  const { viewers, published, publish } = over([picture]);
  viewers.of(picture, "p").moveTo(300);
  publish();
  const said = published.length;

  // The session is disposed: it is not among the live ones any more.
  publish([]);
  assert.deepEqual(published.at(-1).zones, []);
  assert.equal(published.length, said + 1);

  // And it is not repeated on every pass afterwards — the file is gone from
  // this class's memory, and a departure is said once.
  publish([]);
  publish([]);
  assert.equal(published.length, said + 1);
});

test("an unchanged map is still not republished", () => {
  const picture = outputOf({ id: "pic" });
  const { viewers, published, publish } = over([picture]);
  viewers.of(picture, "p").moveTo(300);
  publish();
  const said = published.length;
  publish();
  publish();
  assert.equal(published.length, said, "the downloading rebuilds its requests on every one");
});

/** A torrent that is nothing but one file of a known length. */
function torrentOf({ length = 1_000_000 } = {}) {
  return {
    infoHash: `hash-${Math.random().toString(36).slice(2)}`,
    pieceLength: 1024,
    files: [{ offset: 0, length, name: "film.mkv" }],
    _selections: { _items: [] },
    _select() {},
    _deselect() {},
    critical() {}
  };
}

const applyPriorityMap = TorrentPool.prototype.applyPriorityMap;

/**
 * @param {object} torrent
 * @returns {object[]}
 */
function stated(torrent) {
  return demandFor(torrent)
    .register.windows()
    .filter((one) => String(one.claimant).startsWith("priority-map:"));
}

test("a map with nothing in it withdraws everything that file had stated", () => {
  const torrent = torrentOf();
  try {
    applyPriorityMap.call(null, torrent, 0, [
      { from: 0, to: 100, priority: 100 },
      { from: 100, to: 600, priority: 50 }
    ], 600);
    assert.equal(stated(torrent).length, 2);

    applyPriorityMap.call(null, torrent, 0, [], 600);
    assert.equal(stated(torrent).length, 0);
  } finally {
    forgetTorrent(torrent);
  }
});

test("it withdraws that file's bands and nobody else's", () => {
  const torrent = torrentOf();
  try {
    const { register } = demandFor(torrent);
    applyPriorityMap.call(null, torrent, 0, [{ from: 0, to: 600, priority: 100 }], 600);
    // A read stopped on a piece right now, which only a read can say, and the
    // background fill, which the pool states for itself. Neither is the map's
    // to withdraw.
    register.state({
      claimant: "read-7:blocked",
      fileIndex: 0,
      byteStart: 0,
      byteEnd: 999,
      urgency: Urgency.BLOCKED
    });
    register.state({
      claimant: "background-fill:0",
      fileIndex: 0,
      byteStart: 1000,
      byteEnd: 9999,
      urgency: Urgency.TAIL
    });

    applyPriorityMap.call(null, torrent, 0, [], 600);

    assert.equal(stated(torrent).length, 0);
    assert.deepEqual(
      register.windows().map((one) => one.claimant).sort(),
      ["background-fill:0", "read-7:blocked"]
    );
  } finally {
    forgetTorrent(torrent);
  }
});

test("a departure is answered even when nothing else about the file is known", () => {
  // The length, the duration and the torrent's own list are what the ordinary
  // path needs to turn seconds into bytes. A departure needs none of them, and
  // it arrives exactly when they are going away: the map that says it is
  // published as the last viewer leaves.
  const torrent = torrentOf();
  try {
    applyPriorityMap.call(null, torrent, 0, [{ from: 0, to: 600, priority: 100 }], 600);
    assert.equal(stated(torrent).length, 1);

    torrent.files = [];
    applyPriorityMap.call(null, torrent, 0, [], 0);
    assert.equal(stated(torrent).length, 0);
  } finally {
    forgetTorrent(torrent);
  }
});
