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

test("a viewer's own position is the most urgent thing there is", () => {
  const map = mapForViewer({
    atSeconds: 100,
    durationSeconds: 1000,
    allowanceSeconds: 8,
    encodeSpeedX: 2
  });

  assert.equal(map[0].from, 100);
  assert.equal(map[0].to, 108, "above realtime, only the measured allowance");
  for (const zone of map.slice(1)) {
    assert.ok(zone.priority < map[0].priority);
  }
});

test("a machine that cannot keep up needs more encoders, not a longer first zone", () => {
  // An encoder starting where the viewer stands stays ahead of them for
  // `held x s / (1 - s)`, so the SLOWER the machine the shorter that is — and
  // the film is held by more encoders rather than by one working further.
  const slow = mapForViewer({
    atSeconds: 0,
    durationSeconds: 1000,
    allowanceSeconds: 10,
    encodeSpeedX: 0.25
  });
  const quicker = mapForViewer({
    atSeconds: 0,
    durationSeconds: 1000,
    allowanceSeconds: 10,
    encodeSpeedX: 0.5
  });

  assert.ok(
    slow[0].to - slow[0].from < quicker[0].to - quicker[0].from,
    "the slower machine holds the viewer for less"
  );
  assert.ok(slow.length > quicker.length, "so more encoders are needed to hold the film");
});

test("the first zone is exactly what one encoder can hold", () => {
  // `held x s / (1 - s)`: ten seconds held at half speed is ten seconds held,
  // and the encoder is caught exactly there. A longer first zone would stall
  // the viewer inside it; a shorter one would start the next encoder nearer,
  // where its own bound is tighter.
  const map = mapForViewer({
    atSeconds: 0,
    durationSeconds: 100,
    allowanceSeconds: 10,
    encodeSpeedX: 0.5
  });

  assert.equal(map[0].to, 10);
  assert.equal(map[1].to, 30, "the next holds three times as long, because they arrive later");
  assert.equal(map[2].to, 70);
});

test("a viewer holding nothing is told the whole of it is urgent", () => {
  // With nothing held, no partition holds them: the first encoder stays ahead
  // for zero seconds. Slicing the film into equal slivers would pretend
  // otherwise.
  const map = mapForViewer({
    atSeconds: 0,
    durationSeconds: 1000,
    allowanceSeconds: 0,
    encodeSpeedX: 0.25
  });

  assert.equal(map.length, 1);
  assert.equal(map[0].to, 1000);
});

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

test("nothing is measured yet: the middle zone is left out rather than invented", () => {
  const map = mapForViewer({ atSeconds: 0, durationSeconds: 100, allowanceSeconds: 4, encodeSpeedX: 0 });

  assert.equal(map.length, 2, "what must be ready, and the rest");
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
