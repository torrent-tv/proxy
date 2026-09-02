/**
 * @file The one place that speaks to WebTorrent.
 *
 * Driven against a stub torrent shaped like the vendored 2.8.5: a selection
 * list it can be asked about, a bitfield saying what has arrived, and the
 * private `_select`/`_deselect` the real one exposes.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { DemandRegister } from "../services/demand/DemandRegister.js";
import { Urgency } from "../services/demand/Urgency.js";
import { SwarmSelection } from "../services/download/SwarmSelection.js";

const PIECE = 1024;

/**
 * @param {object} [params]
 * @param {number[]} [params.have] - Pieces that have arrived.
 * @param {number} [params.files] - How many files, each ten pieces long.
 * @returns {object}
 */
function stubTorrent({ have = [], files = 1 } = {}) {
  const arrived = new Set(have);
  const items = [];
  return {
    pieceLength: PIECE,
    store: null,
    files: Array.from({ length: files }, (unused, index) => ({
      offset: index * 10 * PIECE,
      length: 10 * PIECE
    })),
    bitfield: { get: (index) => arrived.has(index) },
    _critical: [],
    _selections: { _items: items },
    calls: { select: [], deselect: [], critical: [] },
    _select(from, to, priority, notify, isStream) {
      this.calls.select.push({ from, to, priority, isStream });
      items.push({ from, to, priority });
    },
    _deselect(from, to) {
      this.calls.deselect.push({ from, to });
      const at = items.findIndex((item) => item.from === from && item.to === to);
      if (at >= 0) {
        items.splice(at, 1);
      }
    },
    critical(from, to) {
      this.calls.critical.push({ from, to });
      for (let index = from; index <= to; index += 1) {
        this._critical[index] = true;
      }
    },
    /** Pretend the library dropped a satisfied selection, which it does. */
    forget(from, to) {
      const at = items.findIndex((item) => item.from === from && item.to === to);
      if (at >= 0) {
        items.splice(at, 1);
      }
    }
  };
}

test("nothing is asked of the swarm until somebody states a need", () => {
  const torrent = stubTorrent();
  const selection = new SwarmSelection({ torrent, register: new DemandRegister() });

  assert.deepEqual(selection.reconcile(), { stated: 0, withdrawn: 0 });
  assert.equal(torrent.calls.select.length, 0);
});

test("two viewers of one film are two instructions, and both are urgent", () => {
  const torrent = stubTorrent();
  const register = new DemandRegister();
  const selection = new SwarmSelection({ torrent, register });

  // One stopped at the start, one stopped further in. Both pictures are still.
  register.state({ claimant: "v1", fileIndex: 0, byteStart: 0, byteEnd: PIECE - 1, urgency: Urgency.BLOCKED });
  register.state({ claimant: "v2", fileIndex: 0, byteStart: 5 * PIECE, byteEnd: 6 * PIECE - 1, urgency: Urgency.BLOCKED });
  selection.reconcile();

  assert.deepEqual(torrent.calls.select, [
    { from: 0, to: 0, priority: 1, isStream: true },
    { from: 5, to: 5, priority: 1, isStream: true }
  ]);
  // Both may take a block from a slow peer, and the mark spans both.
  assert.deepEqual(torrent.calls.critical, [{ from: 0, to: 5 }]);
});

test("the same pieces wanted by two claimants are one instruction", () => {
  const torrent = stubTorrent();
  const register = new DemandRegister();
  const selection = new SwarmSelection({ torrent, register });

  // Picture and sound of one viewer read the same file and overlap.
  register.state({ claimant: "video", fileIndex: 0, byteStart: 0, byteEnd: PIECE - 1, urgency: Urgency.NEAR });
  register.state({ claimant: "audio", fileIndex: 0, byteStart: 0, byteEnd: PIECE - 1, urgency: Urgency.NEAR });
  const first = selection.reconcile();

  assert.equal(first.stated, 1, "one range, told once");
  assert.equal(torrent.calls.select.length, 1);
});

test("the speculative levels are withdrawn whole the moment something urgent is missing", () => {
  const torrent = stubTorrent({ have: [0] });
  const register = new DemandRegister();
  const selection = new SwarmSelection({ torrent, register });

  register.state({ claimant: "video", fileIndex: 0, byteStart: 0, byteEnd: PIECE - 1, urgency: Urgency.NEAR });
  register.state({ claimant: "fill", fileIndex: 0, byteStart: 5 * PIECE, byteEnd: 9 * PIECE - 1, urgency: Urgency.TAIL });
  selection.reconcile();

  assert.equal(selection.statedRanges().length, 2, "nothing urgent is missing, so the tail is stated");
  assert.ok(torrent.calls.select.some((call) => call.priority === 0), "and it is stated as zero");

  // The viewer moves on to a piece that has not arrived.
  register.state({ claimant: "video", fileIndex: 0, byteStart: PIECE, byteEnd: 2 * PIECE - 1, urgency: Urgency.NEAR });
  selection.reconcile();

  assert.deepEqual(
    selection.statedRanges().map((range) => range.priority),
    [1],
    "the tail is out of the download set entirely, not lowered — a peer with nothing urgent to give must not be able to fall through to it"
  );
  assert.ok(torrent.calls.deselect.length > 0);
});

test("a selection the library drops once satisfied is stated again", () => {
  const torrent = stubTorrent();
  const register = new DemandRegister();
  const selection = new SwarmSelection({ torrent, register });

  register.state({ claimant: "video", fileIndex: 0, byteStart: 0, byteEnd: PIECE - 1, urgency: Urgency.NEAR });
  selection.reconcile();
  assert.equal(torrent.calls.select.length, 1);

  // Nothing changed: no second instruction.
  selection.reconcile();
  assert.equal(torrent.calls.select.length, 1);

  // WebTorrent removes a selection once every piece in it has arrived, and says
  // nothing about having done so. The window is still wanted.
  torrent.forget(0, 0);
  selection.reconcile();
  assert.equal(torrent.calls.select.length, 2, "stated again, because the library had let it go");
});

test("a claimant that withdraws takes its instruction with it", () => {
  const torrent = stubTorrent();
  const register = new DemandRegister();
  const selection = new SwarmSelection({ torrent, register });

  register.state({ claimant: "video", fileIndex: 0, byteStart: 0, byteEnd: PIECE - 1, urgency: Urgency.BLOCKED });
  selection.reconcile();
  register.withdraw("video");
  const after = selection.reconcile();

  assert.equal(after.withdrawn, 1);
  assert.equal(selection.statedRanges().length, 0);
  // And the displacement mark goes with it: WebTorrent never clears it itself,
  // so a reader walking a film would leave every piece of it marked.
  assert.equal(torrent._critical.some((marked) => marked === true), false);
});

test("a window is bounded by its own file, so it cannot claim the next one", () => {
  const torrent = stubTorrent({ files: 3 });
  const register = new DemandRegister();
  const selection = new SwarmSelection({ torrent, register });

  // Asking past the end of file 1. File 1 occupies pieces 10-19.
  register.state({
    claimant: "video", fileIndex: 1, byteStart: 0, byteEnd: 100 * PIECE, urgency: Urgency.NEAR
  });
  selection.reconcile();

  assert.deepEqual(torrent.calls.select, [{ from: 10, to: 19, priority: 1, isStream: true }]);
});

test("releasing everything leaves the library holding nothing of ours", () => {
  const torrent = stubTorrent();
  const register = new DemandRegister();
  const selection = new SwarmSelection({ torrent, register });

  register.state({ claimant: "video", fileIndex: 0, byteStart: 0, byteEnd: 3 * PIECE, urgency: Urgency.BLOCKED });
  selection.reconcile();
  selection.releaseAll();

  assert.equal(torrent._selections._items.length, 0);
  assert.equal(selection.statedRanges().length, 0);
  assert.equal(torrent._critical.some((marked) => marked === true), false);
});

test("the store is told what will be read soon, from the same stated needs", () => {
  const torrent = stubTorrent();
  const protectedBy = new Map();
  torrent.store = {
    protectRange: (claimant, from, to) => protectedBy.set(claimant, `${from}-${to}`),
    releaseProtection: (claimant) => protectedBy.delete(claimant)
  };
  const register = new DemandRegister();
  const selection = new SwarmSelection({ torrent, register, findStore: () => torrent.store });

  register.state({ claimant: "video", fileIndex: 0, byteStart: 0, byteEnd: PIECE - 1, urgency: Urgency.NEAR });
  register.state({ claimant: "fill", fileIndex: 0, byteStart: 5 * PIECE, byteEnd: 9 * PIECE - 1, urgency: Urgency.TAIL });
  selection.reconcile();

  // One statement, two views of it. Until 2026-09-02 a reader said the same
  // thing twice — once to the store for memory, once to the torrent for
  // download — and a third piece of code read the first to rebuild the second.
  assert.equal(protectedBy.get("video"), "0-0");
  // But only the urgent levels: memory holds what will be READ soon, and the
  // tail is fetched speculatively. Protecting it would push out a piece the
  // decoder is about to want.
  assert.equal(protectedBy.has("fill"), false);

  register.withdraw("video");
  selection.reconcile();
  assert.equal(protectedBy.size, 0, "a reader that withdrew still held memory");
});
