import test from "node:test";
import assert from "node:assert/strict";
import { takeTurns } from "../../utils/take-turns.js";

// A fake clock: each step of the work costs one millisecond, and each turn the
// rest of the thread takes costs what the test says.
function sharedThread(othersPerTurn) {
  let clock = 0, turns = 0;
  const turn = takeTurns({ now: () => clock, nextTurn: async () => { turns += 1; clock += othersPerTurn(turns); } });
  return { turn, step: () => { clock += 1; }, turns: () => turns, clock: () => clock };
}

test("the work hands the thread back after as long as the rest of the thread took in its turn", async () => {
  const thread = sharedThread(() => 10);
  const handedBackAfter = [];
  let sinceLast = 0;
  for (let step = 0; step < 100; step++) {
    thread.step();
    sinceLast += 1;
    if (await thread.turn()) { handedBackAfter.push(sinceLast); sinceLast = 0; }
  }
  assert.equal(handedBackAfter[0], 1, "the first step measures the others' turn");
  assert.ok(handedBackAfter.slice(1).every(steps => steps === 10), `${handedBackAfter}`);
  assert.ok(thread.clock() <= 2 * 100 + 10, "the work takes at most about twice its own time");
});

test("on an idle thread the work is handed back often, at no cost", async () => {
  const thread = sharedThread(() => 0);
  for (let step = 0; step < 50; step++) {
    thread.step();
    await thread.turn();
  }
  assert.equal(thread.clock(), 50, "nothing else ran, so nothing was added");
});

test("a long turn of the rest of the thread gives the work a long turn after it", async () => {
  const thread = sharedThread(turns => turns === 2 ? 1500 : 1);
  const yields = [];
  for (let step = 0; step < 1600; step++) {
    thread.step();
    if (await thread.turn()) yields.push(step);
  }
  const afterLong = yields.findIndex(step => step > yields[1]);
  assert.ok(yields[afterLong] - yields[1] >= 1500, "after others took 1.5 s, the work runs as long before handing back");
});
