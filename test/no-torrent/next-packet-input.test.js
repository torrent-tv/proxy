import assert from "node:assert/strict";
import test from "node:test";
import { nextPacketInputs } from "../../services/encode/next-packet-input.js";

// r54, r55 (torrent-tv/meta#178): a soundtrack run fed packet by packet waited
// for its next input before ending the piece it held, and the picture stood.

function inputs(readyAt) {
  const taken = [];
  const released = [];
  const take = index => {
    taken.push(index);
    return readyAt.has(index) ? { index, release: () => released.push(index) } : null;
  };
  return { take, taken, released };
}

test("a run goes on only with an input already prepared, and begins the one after it", () => {
  const source = inputs(new Set([6, 7]));
  const following = nextPacketInputs({ take: source.take, canAppend: () => true, first: 6, last: 9 });
  assert.deepEqual(source.taken, [6], "the next input is begun when the run starts");
  const appended = [];
  assert.equal(following.next(index => appended.push(index)).index, 6);
  assert.equal(following.next(index => appended.push(index)).index, 7);
  assert.equal(following.next(), null, "#8 is not prepared: the run ends and publishes #7");
  assert.deepEqual(appended, [6, 7]);
  assert.deepEqual(source.taken, [6, 7, 8, 8]);
});

test("an input prepared ahead and not used is let go when the run ends", () => {
  const source = inputs(new Set([6]));
  const following = nextPacketInputs({ take: source.take, canAppend: () => true, first: 6, last: 9 });
  following.release();
  assert.deepEqual(source.released, [6]);
});

test("nothing is begun or taken past the run's last piece or a piece it may not make", () => {
  const source = inputs(new Set([6, 7]));
  const following = nextPacketInputs({ take: source.take, canAppend: index => index !== 7, first: 6, last: 6 });
  assert.equal(following.next().index, 6);
  assert.equal(following.next(), null);
  assert.deepEqual(source.taken, [6]);
});
