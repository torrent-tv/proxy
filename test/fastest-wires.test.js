/**
 * @file Choosing who is asked for the piece a reader is blocked on.
 *
 * The measurement behind it (2026-08-17): a fivefold bandwidth surplus and 47
 * blocking waits in two minutes, on pieces a median of five peers already had.
 * A block belongs to one wire, so the read ends when the SLOWEST holder
 * delivers — which makes "who holds it" the thing worth deciding.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { askFastestWiresFor, canPlaceRequests, wiresForPiece } from "../services/torrent-worker/fastest-wires.js";

/**
 * @param {{ speed: number, has?: boolean, choking?: boolean, destroyed?: boolean }} options
 * @returns {object}
 */
function wire({ speed, has = true, choking = false, destroyed = false }) {
  return {
    destroyed,
    peerChoking: choking,
    peerPieces: { get: () => has },
    downloadSpeed: () => speed
  };
}

/**
 * @param {object[]} wires
 * @returns {{ torrent: object, asked: Array<{ speed: number, hotswap: boolean }> }}
 */
function torrentWith(wires, { refuse = false } = {}) {
  /** @type {Array<{ speed: number, hotswap: boolean }>} */
  const asked = [];
  const torrent = {
    wires,
    _request(target, _index, hotswap) {
      asked.push({ speed: target.downloadSpeed(), hotswap });
      return !refuse;
    }
  };
  return { torrent, asked };
}

test("the fastest holders are asked first", () => {
  const { torrent, asked } = torrentWith([
    wire({ speed: 100_000 }),
    wire({ speed: 900_000 }),
    wire({ speed: 400_000 })
  ]);

  const result = askFastestWiresFor(torrent, 42);

  assert.deepEqual(
    asked.map((entry) => entry.speed),
    [900_000, 400_000, 100_000],
    "fastest first — the read ends when the slowest holder delivers"
  );
  assert.equal(result.asked, 3);
  assert.equal(result.fastestBytesPerSecond, 900_000);
});

test("hotswap is always on, because that is the whole point", () => {
  // The reader is blocked precisely because every block is reserved and one of
  // them sits with a slow wire. Without hotswap the library answers "nothing to
  // reserve" and the lever does nothing at all.
  const { torrent, asked } = torrentWith([wire({ speed: 10 })]);
  askFastestWiresFor(torrent, 7);
  assert.deepEqual(asked.map((entry) => entry.hotswap), [true]);
});

test("a wire that cannot deliver is not asked", () => {
  const { torrent, asked } = torrentWith([
    wire({ speed: 900_000, choking: true }),
    wire({ speed: 800_000, has: false }),
    wire({ speed: 700_000, destroyed: true }),
    wire({ speed: 1_000 })
  ]);

  const result = askFastestWiresFor(torrent, 3);

  assert.equal(asked.length, 1, "a choking, an absent and a dead wire are all unusable");
  assert.equal(result.considered, 1);
});

test("a refusal is counted as a refusal", () => {
  // The library refuses when a wire's pipeline is full or nothing can be
  // reserved even with hotswap. That is information: the piece is waiting on
  // the wire, not on the picker.
  const { torrent } = torrentWith([wire({ speed: 500 }), wire({ speed: 400 })], { refuse: true });
  const result = askFastestWiresFor(torrent, 11);
  assert.equal(result.asked, 0);
  assert.equal(result.considered, 2);
});

test("a build without the request entry is reported, not silently skipped", () => {
  assert.equal(canPlaceRequests({ wires: [] }), false);
  assert.equal(canPlaceRequests({ wires: [], _request: () => true }), true);
  const result = askFastestWiresFor({ wires: [wire({ speed: 1 })] }, 1);
  assert.deepEqual(result, { asked: 0, considered: 0, fastestBytesPerSecond: 0 });
});

test("a wire that cannot say how fast it is ranks last rather than throwing", () => {
  const mute = wire({ speed: 0 });
  mute.downloadSpeed = () => {
    throw new Error("destroyed");
  };
  const ranked = wiresForPiece({ wires: [mute, wire({ speed: 5 })] }, 0);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].downloadSpeed(), 5);
});

test("a throw from the library is raised, never swallowed", () => {
  const torrent = {
    wires: [wire({ speed: 1 })],
    _request() {
      throw new Error("internal");
    }
  };
  assert.throws(() => askFastestWiresFor(torrent, 5), /could not place a request for piece 5/);
});
