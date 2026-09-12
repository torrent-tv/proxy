/**
 * @file An output whose input is away gets no encoders until it may.
 *
 * A run whose input has gone is not alive, so the plan reads the stretch it held
 * as free and places another run there at once — which dies the same way,
 * because nothing about the state has changed. A delay existed for exactly this,
 * doubling from 2 s to 15 s, and it was timed against the DEAD RUN, which the
 * plan never consults. Field 2026-09-12: 2432 ffmpeg starts in 23 minutes, one
 * every 0.57 s, for 61 minutes, against a delay that had reached its ceiling
 * long before; the flood also turned the log over twice and destroyed the
 * record of how the failure began.
 *
 * The delay lives beside the decision it governs now, and these check that it
 * binds.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { EncodeRun } from "../services/encode/EncodeRun.js";
import { ENCODE_EXIT } from "../services/encode/encode-exit.js";
import { SoftwareEncoder } from "../services/encode/SoftwareEncoder.js";
import { EncodeOrchestrator } from "../services/orchestrators/EncodeOrchestrator.js";

const PICTURE = "torrent:abc:fmt=fmp4:grid=kf@0:video-only:v=0/copy";

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = 1;
  }

  kill(signal) {
    this.emit("exit", null, signal);
  }
}

/** An orchestrator whose clock the test moves, and a count of what it started. */
function orchestrator() {
  const lines = [];
  let clock = 1_000;
  let started = 0;
  let asked = 0;
  /** @type {EncodeOrchestrator} */
  let made;
  /** @type {{ run: EncodeRun, process: FakeProcess }[]} */
  const runs = [];
  made = new EncodeOrchestrator({
    maxRunsFor: () => 1,
    segmentSeconds: 4,
    startingSpeedFor: () => 2,
    refetchSecPerFilmSecond: () => 0.25,
    now: () => clock,
    planSoon: () => { asked += 1; },
    logger: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
    makeRun: ({ address, from, to }) => {
      started += 1;
      const process_ = new FakeProcess();
      const run = new EncodeRun({
        address,
        encoder: new SoftwareEncoder(),
        from,
        to,
        buildArgs: () => ["-i", "in", "out"],
        spawn: () => process_,
        logger: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
        now: () => clock,
        onEnded: (ended) => made.noteEnded(ended)
      });
      runs.push({ run, process: process_ });
      return run;
    }
  });
  made.setSegmentCount(PICTURE, 1000);
  made.noteStartupCosts({ killCostSec: 0, firstByteWaitSec: 0.12 });

  const wants = () => made.notePriorityMap(PICTURE, [
    { from: 0, to: 20, priority: 1, withinSeconds: 0 }
  ]);

  return {
    made,
    lines,
    wants,
    runs,
    startedCount: () => started,
    askedToPlanAgain: () => asked,
    advance: (ms) => { clock += ms; },
    /** End the newest run the way a torrent going away ends one. */
    loseTheInput: () => {
      const newest = runs[runs.length - 1];
      made.noteEnded({
        address: PICTURE,
        run: newest.run,
        from: newest.run.from,
        to: newest.run.to,
        ending: ENCODE_EXIT.INPUT_LOST,
        because: "the torrent went away"
      });
    }
  };
}

test("nothing is placed on an output whose input has just gone", () => {
  const stand = orchestrator();
  stand.wants();
  stand.made.reconcile();
  assert.equal(stand.startedCount(), 1, "one encoder for the one thing wanted");

  stand.loseTheInput();
  // The plan is asked again by every event there is — a request, a report, a
  // piece — and in the field that was about twice a second.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    stand.made.reconcile();
  }
  assert.equal(
    stand.startedCount(),
    1,
    "twenty decisions while the input is away must not be twenty processes"
  );
});

test("once the wait is over the plan places again", () => {
  const stand = orchestrator();
  stand.wants();
  stand.made.reconcile();
  stand.loseTheInput();
  stand.made.reconcile();
  assert.equal(stand.startedCount(), 1);

  // The first wait is the base delay; anything past it lets the plan act.
  stand.advance(2_001);
  stand.made.reconcile();
  assert.equal(stand.startedCount(), 2, "the data may be back, and that is worth one attempt");
});

test("the wait doubles while the input stays away, and is capped", () => {
  const stand = orchestrator();
  stand.wants();
  stand.made.reconcile();

  const waits = [];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    stand.loseTheInput();
    // Find the shortest advance that lets the plan act again, by stepping to
    // just before and just after the boundary rather than reading a private.
    let waited = 0;
    const step = 250;
    for (;;) {
      const before = stand.startedCount();
      stand.made.reconcile();
      if (stand.startedCount() > before) {
        break;
      }
      stand.advance(step);
      waited += step;
      assert.ok(waited < 60_000, "a wait must not be unbounded");
    }
    waits.push(waited);
  }

  for (let at = 1; at < waits.length; at += 1) {
    assert.ok(
      waits[at] >= waits[at - 1],
      `the wait must not shrink while the input stays away: ${JSON.stringify(waits)}`
    );
  }
  assert.ok(
    waits[waits.length - 1] <= 15_000,
    `and it must stop growing: ${JSON.stringify(waits)}`
  );
  assert.ok(
    waits[waits.length - 1] > waits[0],
    `and it must actually have grown: ${JSON.stringify(waits)}`
  );
});

test("a wake-up is asked for, because no event arrives while the data is away", async () => {
  const stand = orchestrator();
  stand.wants();
  stand.made.reconcile();
  stand.loseTheInput();
  // The wake-up runs on the real clock — the orchestrator's injected `now` is
  // what the DECISION reads, and a timer is not a decision. So this waits for
  // the condition, with a deadline only as a backstop; a fixed pause here would
  // measure the machine.
  const deadline = Date.now() + 10_000;
  while (stand.askedToPlanAgain() === 0) {
    if (Date.now() > deadline) {
      assert.fail("nothing about the state changes while the input is missing, so the plan must be recalled");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(stand.askedToPlanAgain() >= 1);
});

test("an ending that is not about the input clears the wait", () => {
  const stand = orchestrator();
  stand.wants();
  stand.made.reconcile();
  stand.loseTheInput();
  stand.made.reconcile();
  assert.equal(stand.startedCount(), 1, "held back, as it should be");

  stand.advance(2_001);
  stand.made.reconcile();
  assert.equal(stand.startedCount(), 2);

  // This one PRODUCED and was then stopped: a segment came out of the input, so
  // the input was plainly there and the next attempt starts from no delay.
  const newest = stand.runs[stand.runs.length - 1];
  stand.made.noteEnded({
    address: PICTURE,
    run: newest.run,
    from: newest.run.from,
    to: newest.run.to,
    reached: newest.run.from,
    firstOutputMs: 120,
    ending: ENCODE_EXIT.STOPPED,
    because: "we asked it to"
  });
  stand.made.reconcile();
  assert.equal(stand.startedCount(), 3, "a file that has just produced is not suspect");
});

test("an ending that produced NOTHING does not lift the wait", () => {
  const stand = orchestrator();
  stand.wants();
  stand.made.reconcile();
  stand.loseTheInput();

  // At the moment of failure several runs end at once. One of them ending
  // without having made anything proves nothing about the input, and lifting
  // the wait on it is the storm again with an extra step.
  const newest = stand.runs[stand.runs.length - 1];
  stand.made.noteEnded({
    address: PICTURE,
    run: newest.run,
    from: newest.run.from,
    to: newest.run.to,
    reached: newest.run.from - 1,
    firstOutputMs: null,
    ending: ENCODE_EXIT.GONE,
    because: "it is no longer running, and it did not say so"
  });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    stand.made.reconcile();
  }
  assert.equal(stand.startedCount(), 1, "an ending with nothing produced is no evidence");
});

test("the wait is said out loud, with the attempt and how long", () => {
  const stand = orchestrator();
  stand.wants();
  stand.made.reconcile();
  stand.loseTheInput();
  assert.ok(
    stand.lines.some((line) => /its input was not there \(attempt 1\)/.test(line)),
    `the reason nothing is being placed must be readable: ${JSON.stringify(stand.lines.slice(-4))}`
  );
});
