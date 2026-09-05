/**
 * @file A map per viewer, merged into one, in the order the work is taken.
 *
 * In seconds of film throughout: it is the only unit every term of the
 * arithmetic is already stated in, and the one two consumers with different
 * states can both be translated from.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mapForViewer, mergeMaps, inWorkingOrder } from "../services/priority/PriorityMap.js";

test("the rest of the track is still wanted, and wanted last", () => {
  const map = mapForViewer({ atSeconds: 0, durationSeconds: 1000, allowanceSeconds: 4, encodeSpeedX: 2 });

  assert.equal(map[map.length - 1].to, 1000, "the map reaches the end of the film");
  assert.ok(map[map.length - 1].priority > 0, "and the far end is still wanted");
  let previousEnd = 0;
  for (const zone of map) {
    assert.equal(zone.from, previousEnd, "no gaps and no overlaps");
    previousEnd = zone.to;
  }
});

test("two viewers merge to the highest priority per second, with no overlaps", () => {
  const first = mapForViewer({ atSeconds: 0, durationSeconds: 1000, allowanceSeconds: 8, encodeSpeedX: 2 });
  const second = mapForViewer({ atSeconds: 500, durationSeconds: 1000, allowanceSeconds: 8, encodeSpeedX: 2 });

  const merged = mergeMaps([first, second]);

  let previousEnd = merged[0].from;
  for (const zone of merged) {
    assert.equal(zone.from, previousEnd, "no gaps and no overlaps");
    previousEnd = zone.to;
  }
  const priorityAt = (at) => merged.find((zone) => at >= zone.from && at < zone.to)?.priority;
  assert.equal(priorityAt(0), priorityAt(500), "both viewers' own positions are equally urgent");
  assert.ok(priorityAt(500) > priorityAt(300), "a viewer at 500 outranks the far zone of the one at 0");
});

test("the second viewer's position is not buried under the first viewer's far zone", () => {
  // The case that used to leave a viewer opening the same film further in with
  // no encoder at all, because the first run claimed everything in front of it.
  const first = mapForViewer({ atSeconds: 0, durationSeconds: 4000, allowanceSeconds: 8, encodeSpeedX: 2 });
  const second = mapForViewer({ atSeconds: 2000, durationSeconds: 4000, allowanceSeconds: 8, encodeSpeedX: 2 });

  const order = inWorkingOrder(mergeMaps([first, second]));
  const firstTwo = order.slice(0, 2).map((zone) => zone.from);

  assert.ok(firstTwo.includes(0), "the first viewer's own position is taken first");
  assert.ok(firstTwo.includes(2000), "so is the second viewer's, before anything less urgent");
});

test("within one priority the earliest film goes first — that is where somebody is stopped", () => {
  const order = inWorkingOrder([
    { from: 900, to: 1000, priority: 2 },
    { from: 100, to: 200, priority: 2 },
    { from: 0, to: 10, priority: 3 }
  ]);

  assert.deepEqual(order.map((zone) => zone.from), [0, 100, 900]);
});

test("the nearer a viewer is to a second, the higher its number", () => {
  // The number is a reading of how far they still have to travel, and nothing
  // else. That is what makes two viewers comparable at all.
  const map = mapForViewer({ atSeconds: 300, durationSeconds: 3000, allowanceSeconds: 10 });
  const ahead = map.filter((zone) => zone.from >= 300);

  assert.equal(ahead[0].from, 300, "it starts where they are");
  assert.equal(ahead[0].to, 310, "and the first band is the measured allowance");
  for (let index = 1; index < ahead.length; index += 1) {
    assert.ok(ahead[index].priority < ahead[index - 1].priority, "further off is less urgent");
  }
});

test("the bands widen, so any film is described by a handful of them", () => {
  // Near the viewer the difference between now and ten seconds away decides
  // what is made first; twenty minutes out it changes nothing.
  const map = mapForViewer({ atSeconds: 0, durationSeconds: 3000, allowanceSeconds: 10 });

  assert.ok(map.length <= 12, `a fifty-minute film in ${map.length} bands`);
  assert.equal(map[0].to - map[0].from, 10);
  assert.equal(map[1].to - map[1].from, 20);
  assert.equal(map[2].to - map[2].from, 40);
});

test("what is behind a viewer is wanted, and wanted last", () => {
  const map = mapForViewer({ atSeconds: 300, durationSeconds: 3000, allowanceSeconds: 10 });
  const behind = map.find((zone) => zone.from === 0);

  assert.ok(behind, "it is still in the map");
  assert.equal(behind.to, 300);
  assert.ok(
    map.filter((zone) => zone.from >= 300).every((zone) => zone.priority > behind.priority),
    "and everything anybody is approaching outranks it"
  );
});

test("a viewer who has stopped the picture is going nowhere", () => {
  // Nothing is nearer to them than anything else, so nothing in the film is
  // wanted sooner than the rest — and the work goes to whoever is watching.
  const map = mapForViewer({
    atSeconds: 300,
    durationSeconds: 3000,
    allowanceSeconds: 10,
    playing: false
  });

  assert.equal(map.length, 1);
  assert.deepEqual({ from: map[0].from, to: map[0].to }, { from: 0, to: 3000 });
});
