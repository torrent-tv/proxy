/**
 * @file A torrent that was destroyed must not be handed to a reader.
 *
 * The worker remembers each source as a promise, and only ever forgot one when
 * the ADD failed. But the pool destroys a torrent that has gone unread for a
 * quarter of an hour, and under disk pressure — clearing its own map, not this
 * one. The promise then went on resolving to a corpse: a destroyed torrent
 * keeps its object and loses its files.
 *
 * What that did to a viewer, measured 2026-08-06 on two sessions in a row: the
 * plan answered from cache in 23 ms, the session was created from cache in
 * 2 ms, nothing waited for metadata because everything believed the torrent was
 * known, and ffmpeg's first read died 130 ms in with `File 0 not found`. Every
 * request for the playlist then answered 500 until the viewer gave up.
 *
 * The rule under test is the whole fix: a handle that cannot be read from is
 * not returned, it is replaced.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { isUsableTorrentHandle } from "../services/torrent-worker/handle-state.js";

test("a live torrent is usable", () => {
  assert.equal(isUsableTorrentHandle({ destroyed: false, files: [{ name: "a.mkv" }] }), true);
});

test("a destroyed torrent is not, even while it still lists files", () => {
  assert.equal(
    isUsableTorrentHandle({ destroyed: true, files: [{ name: "a.mkv" }] }),
    false,
    "WebTorrent's own flag is the earliest signal that a handle is finished"
  );
});

test("a torrent with no files is not — that is what the reader actually hits", () => {
  assert.equal(
    isUsableTorrentHandle({ destroyed: false, files: [] }),
    false,
    "an empty file list is what produced `File 0 not found` in the field"
  );
  assert.equal(
    isUsableTorrentHandle({ destroyed: false }),
    false,
    "and a handle with no file list at all is the same case"
  );
});

test("nothing at all is not usable", () => {
  assert.equal(isUsableTorrentHandle(null), false);
  assert.equal(isUsableTorrentHandle(undefined), false);
});
