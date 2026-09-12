/**
 * @file THE TWO ENDS OF A FILE ARE THE FILE'S, NOT A READ'S.
 *
 * A container keeps its directory at one end or the other: `ftyp` and an EBML
 * header at the front, and for an MP4 that was not written for streaming the
 * `moov` at the very back. Nothing can be read of such a file until they have
 * arrived, and they go on being wanted for as long as it is open — a player
 * asks for the file's shape again at every seek.
 *
 * Until 2.83.4 they were wanted by nobody. The prefetch that fetches them is an
 * ordinary read, and a read withdraws what it states the moment it finishes, so
 * the ends of an open film were held by nothing at all once the codec probe was
 * done.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { TorrentPool, stateFileEdges, withdrawFileEdges } from "../services/torrent-pool.js";
import { demandFor, forgetTorrent } from "../services/download/registry.js";
import { Urgency } from "../services/demand/index.js";

/** A torrent of two files, of which the second is the film. */
function torrentOf({ length = 1_000_000 } = {}) {
  return {
    infoHash: `hash-${Math.random().toString(36).slice(2)}`,
    pieceLength: 1024,
    files: [
      { offset: 0, length: 4096, name: "notes.nfo" },
      { offset: 4096, length, name: "film.mkv" }
    ],
    _selections: { _items: [] },
    _select() {},
    _deselect() {},
    critical() {}
  };
}

/**
 * @param {object} torrent
 * @returns {object[]}
 */
function edges(torrent) {
  return demandFor(torrent)
    .register.windows()
    .filter((one) => String(one.claimant).startsWith("file-edges:"));
}

test("one byte is claimed at each end, which is one piece at each end", () => {
  const torrent = torrentOf({ length: 1_000_000 });
  try {
    assert.equal(stateFileEdges(torrent, 1, Urgency.TAIL), true);

    const stated = edges(torrent);
    assert.equal(stated.length, 2);
    const head = stated.find((one) => String(one.claimant).endsWith(":head"));
    const tail = stated.find((one) => String(one.claimant).endsWith(":tail"));
    // File-relative, like everything else stated about a file: the claim says
    // "the first byte of this file" and "its last", and what a byte costs to
    // fetch — a whole piece — is the swarm's business and nobody else's.
    assert.deepEqual([head.byteStart, head.byteEnd], [0, 0]);
    assert.deepEqual([tail.byteStart, tail.byteEnd], [999_999, 999_999]);
    assert.equal(head.fileIndex, 1);
    assert.equal(tail.fileIndex, 1);
  } finally {
    forgetTorrent(torrent);
  }
});

test("while somebody is waiting for them they are urgent, and afterwards they are kept", () => {
  const torrent = torrentOf();
  try {
    // The playback plan cannot answer until the file has said what is in it,
    // and a person is watching a loading screen for as long as that takes.
    stateFileEdges(torrent, 1, Urgency.NEAR);
    assert.deepEqual(
      edges(torrent).map((one) => one.urgency),
      [Urgency.NEAR, Urgency.NEAR]
    );

    // Once it has answered, nobody is waiting — but a seek will want them
    // again, so they stay stated at the level of something nobody is waiting
    // for. Re-stating replaces; it does not pile a second claim on the first.
    stateFileEdges(torrent, 1, Urgency.TAIL);
    assert.equal(edges(torrent).length, 2);
    assert.deepEqual(
      edges(torrent).map((one) => one.urgency),
      [Urgency.TAIL, Urgency.TAIL]
    );
  } finally {
    forgetTorrent(torrent);
  }
});

test("each file of a torrent has its own ends", () => {
  const torrent = torrentOf();
  try {
    stateFileEdges(torrent, 0, Urgency.TAIL);
    stateFileEdges(torrent, 1, Urgency.NEAR);
    assert.equal(edges(torrent).length, 4);

    withdrawFileEdges(torrent, 0);
    assert.deepEqual(
      edges(torrent).map((one) => one.fileIndex),
      [1, 1]
    );
  } finally {
    forgetTorrent(torrent);
  }
});

test("a file of unknown length has no ends to claim", () => {
  const torrent = torrentOf();
  try {
    assert.equal(stateFileEdges(torrent, 7, Urgency.TAIL), false);
    assert.equal(stateFileEdges({ files: [{ length: 0 }] }, 0, Urgency.TAIL), false);
    assert.equal(edges(torrent).length, 0);
  } finally {
    forgetTorrent(torrent);
  }
});

test("a map with nothing in it takes the ends back too", () => {
  const torrent = torrentOf();
  const applyPriorityMap = TorrentPool.prototype.applyPriorityMap;
  try {
    stateFileEdges(torrent, 1, Urgency.TAIL);
    applyPriorityMap.call(null, torrent, 1, [{ from: 0, to: 600, priority: 100 }], 600);
    assert.equal(edges(torrent).length, 2);

    // Nobody wants this file any more, and its ends are kept only for as long
    // as it is open.
    applyPriorityMap.call(null, torrent, 1, [], 600);
    assert.equal(edges(torrent).length, 0);
    assert.deepEqual(demandFor(torrent).register.windows(), []);
  } finally {
    forgetTorrent(torrent);
  }
});

test("another file's departure leaves these ends alone", () => {
  const torrent = torrentOf();
  const applyPriorityMap = TorrentPool.prototype.applyPriorityMap;
  try {
    stateFileEdges(torrent, 0, Urgency.TAIL);
    stateFileEdges(torrent, 1, Urgency.TAIL);

    applyPriorityMap.call(null, torrent, 0, [], 600);

    assert.deepEqual(
      edges(torrent).map((one) => one.fileIndex),
      [1, 1]
    );
  } finally {
    forgetTorrent(torrent);
  }
});
