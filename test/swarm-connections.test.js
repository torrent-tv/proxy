/**
 * @file How many connections a torrent keeps when it wants nothing.
 *
 * WebTorrent declares a limit and enforces it on one path only: `maxConns` is
 * checked in `_drain`, which governs peers WE dial, while `_addIncomingPeer`
 * checks that the torrent is neither destroyed nor paused and registers the
 * peer. A proxy with its port mapped is reachable, so on a popular torrent
 * connections arrive and are never turned away — field 2026-09-11: 249
 * connected at the start of one viewing, 596 at the end, 15 862 more queued, on
 * a file that had been complete for three quarters of an hour.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { connectionsToClose } from "../services/torrent-pool.js";

/**
 * @param {number} count
 * @param {number} delivered - How many of them have delivered a byte.
 * @returns {Array<{ downloaded: number, id: number }>}
 */
const wires = (count, delivered) =>
  Array.from({ length: count }, (unused, id) => ({ id, downloaded: id < delivered ? 4096 : 0 }));

test("a torrent still short of something keeps every connection it has", () => {
  // The one that has delivered nothing so far may be the one that delivers
  // next, and while a viewer is waiting that is worth more than a socket.
  assert.deepEqual(
    connectionsToClose({ wires: wires(600, 12), allowed: 55, wantsBytes: true }),
    []
  );
});

test("nothing is closed before it is known whether anything is missing", () => {
  // `null` is "not measured", and a measurement that has not been taken is not
  // permission to act.
  assert.deepEqual(
    connectionsToClose({ wires: wires(600, 12), allowed: 55, wantsBytes: null }),
    []
  );
});

test("a torrent short of nothing lets go of what delivered nothing", () => {
  const open = wires(600, 12);
  const going = connectionsToClose({ wires: open, allowed: 55, wantsBytes: false });

  assert.equal(going.length, 545, "it is over by 545 and that is how many go");
  assert.ok(
    going.every((wire) => wire.downloaded === 0),
    "a connection that delivered something was closed"
  );
  assert.equal(open.length - going.length, 55, "what is left is what this client would dial up to");
});

test("connections that all delivered are never closed, however many there are", () => {
  // The bound is on connections doing nothing, not on connections. A swarm
  // where every peer is feeding us is not a problem to solve.
  assert.deepEqual(
    connectionsToClose({ wires: wires(600, 600), allowed: 55, wantsBytes: false }),
    []
  );
});

test("under the limit nothing is closed at all", () => {
  assert.deepEqual(
    connectionsToClose({ wires: wires(40, 0), allowed: 55, wantsBytes: false }),
    []
  );
});
