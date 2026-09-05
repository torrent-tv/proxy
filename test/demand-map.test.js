/**
 * @file A map per viewer, merged into one, in the order the work is taken.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mapForViewer, mergeMaps, inWorkingOrder } from "../services/encode/DemandMap.js";

test("a viewer's own position is the most urgent thing there is", () => {
  const map = mapForViewer({
    at: 10,
    segmentCount: 100,
    segmentSeconds: 4,
    cushionSeconds: 8,
    encodeSpeedX: 1
  });

  assert.equal(map[0].from, 10);
  assert.equal(map[0].to, 11, "8s of cushion is two 4s segments");
  for (const zone of map.slice(1)) {
    assert.ok(zone.priority < map[0].priority);
  }
});

test("the cushion comes from the measurement, not from a constant", () => {
  const thin = mapForViewer({ at: 0, segmentCount: 100, segmentSeconds: 4, cushionSeconds: 4, encodeSpeedX: 1 });
  const thick = mapForViewer({ at: 0, segmentCount: 100, segmentSeconds: 4, cushionSeconds: 40, encodeSpeedX: 1 });

  assert.equal(thin[0].to, 0);
  assert.equal(thick[0].to, 9, "a swarm that needs 40s of cushion gets ten segments of it");
});

test("a machine that cannot keep up must have more ready before the viewer sets off", () => {
  // 100 segments of 4s = 400s of film. At 0.25x the encoder loses three seconds
  // of film for every second played, so 300s — 75 segments — has to exist
  // before playback starts, or the viewer meets a spinner partway through.
  const slow = mapForViewer({ at: 0, segmentCount: 100, segmentSeconds: 4, cushionSeconds: 4, encodeSpeedX: 0.25 });
  const fast = mapForViewer({ at: 0, segmentCount: 100, segmentSeconds: 4, cushionSeconds: 4, encodeSpeedX: 2 });

  assert.equal(slow[0].to, 75, "300s of shortfall plus 4s of measured allowance");
  assert.equal(fast[0].to, 0, "above realtime only the measured allowance is needed");
  assert.ok(
    slow[0].to - slow[0].from > fast[0].to - fast[0].from,
    "the slower the machine, the more of the film must be made in advance"
  );
});

test("the rest of the track is still wanted, and wanted last", () => {
  const map = mapForViewer({ at: 0, segmentCount: 100, segmentSeconds: 4, cushionSeconds: 4, encodeSpeedX: 0.1 });

  const covered = map.reduce((sum, zone) => sum + (zone.to - zone.from + 1), 0);
  assert.equal(covered, 100, "every segment of the track appears exactly once");
  assert.equal(map[map.length - 1].to, 99);
  assert.ok(map[map.length - 1].priority > 0);
});

test("nothing is measured yet: the reachable zone is left out rather than guessed", () => {
  const map = mapForViewer({ at: 0, segmentCount: 100, segmentSeconds: 4, cushionSeconds: 4, encodeSpeedX: 0 });

  assert.equal(map.length, 2, "the cushion and the rest, with nothing invented between them");
});

test("two viewers merge to the highest priority per number, and every number appears once", () => {
  const first = mapForViewer({ at: 0, segmentCount: 100, segmentSeconds: 4, cushionSeconds: 8, encodeSpeedX: 1 });
  const second = mapForViewer({ at: 50, segmentCount: 100, segmentSeconds: 4, cushionSeconds: 8, encodeSpeedX: 1 });

  const merged = mergeMaps([first, second]);

  let previousEnd = -1;
  for (const zone of merged) {
    assert.equal(zone.from, previousEnd + 1, "no gaps and no overlaps");
    previousEnd = zone.to;
  }
  assert.equal(previousEnd, 99);

  const priorityAt = (index) => merged.find((zone) => index >= zone.from && index <= zone.to)?.priority;
  assert.equal(priorityAt(0), priorityAt(50), "both viewers' own positions are equally urgent");
  assert.ok(priorityAt(50) > priorityAt(30), "a viewer standing at 50 outranks the far zone of the one at 0");
});

test("the second viewer's position is not buried by the first viewer's low zone", () => {
  // The case that used to leave a viewer opening the same film further in with
  // no encoder at all: the first run claimed everything in front of it.
  const first = mapForViewer({ at: 0, segmentCount: 1000, segmentSeconds: 4, cushionSeconds: 8, encodeSpeedX: 1 });
  const second = mapForViewer({ at: 500, segmentCount: 1000, segmentSeconds: 4, cushionSeconds: 8, encodeSpeedX: 1 });

  const order = inWorkingOrder(mergeMaps([first, second]));

  const firstTwo = order.slice(0, 2).map((zone) => zone.from);
  assert.ok(firstTwo.includes(0), "the first viewer's own position is taken first");
  assert.ok(firstTwo.includes(500), "so is the second viewer's, before anything less urgent");
});

test("within one priority the lowest number goes first — that is where somebody is stopped", () => {
  const order = inWorkingOrder([
    { from: 90, to: 99, priority: 500 },
    { from: 10, to: 19, priority: 500 },
    { from: 0, to: 1, priority: 1000 }
  ]);

  assert.deepEqual(order.map((zone) => zone.from), [0, 10, 90]);
});
