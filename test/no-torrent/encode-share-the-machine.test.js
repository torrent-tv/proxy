/**
 * @file Who gets the processor first, over every output at once.
 *
 * Runs are run-shaped values, so nothing spawns ffmpeg and nothing depends on
 * whether this platform can suspend a process. What is checked is the rule:
 * an encoder making something less urgent than what another encoder is making
 * anywhere stands still, and goes on once nothing more urgent is being made
 * (torrent-tv/meta#166: a copied soundtrack at 38 minutes while its picture,
 * re-encoded below realtime, was at five and the viewer stalled).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EncodeOrchestrator, compareUrgency } from "../../services/encode/EncodeOrchestrator.js";

const PICTURE = "torrent:abc:fmt=mpegts:grid=even@0:video-only:v=0/enc/libx264/720x400@24/superfast";
const SOUND = "torrent:abc:fmt=mpegts:grid=even@0:audio-only:a=0/0/copy";
const OTHER = "torrent:def:fmt=mpegts:grid=even@0:video-only:v=0/enc/libx264/1280x720@24/superfast";

function orchestrator() {
  const lines = [];
  const made = new EncodeOrchestrator({
    maxRunsFor: () => 2,
    segmentSeconds: 4,
    killCostSec: 0,
    firstByteWaitSec: 0.12,
    startingSpeedFor: () => 1,
    now: () => 1000,
    logger: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
    makeRun: () => null
  });
  return { made, lines };
}

/** A run-shaped encoder that records being paused and let go. */
function run(head) {
  return {
    id: `run-${head}`, from: head, to: head + 100, head, speedX: 1, isAlive: true, isStopping: false,
    isSuspended: false, events: [],
    pause(reason) { this.isSuspended = true; this.events.push(`pause: ${reason}`); return true; },
    resume(reason) { this.isSuspended = false; this.events.push(`resume: ${reason}`); return true; },
    stop() { this.isAlive = false; },
    noteProduced() {}
  };
}

/** One viewer's map in an output's own numbering: urgent at the start, then falling priority. */
function viewerMap(at) {
  return [
    { from: at, to: at + 2, priority: 100, withinSeconds: 0, urgent: true },
    { from: at + 3, to: at + 6, priority: 99, withinSeconds: 12, urgent: false },
    { from: at + 7, to: at + 14, priority: 98, withinSeconds: 28, urgent: false },
    { from: at + 15, to: at + 499, priority: 94, withinSeconds: 60, urgent: false }
  ];
}

test("an encoder ahead of what another output is urgently making stands still, and goes on once that is made", () => {
  const { made } = orchestrator();
  made.notePriorityMap(PICTURE, viewerMap(0));
  made.notePriorityMap(SOUND, viewerMap(0));
  const picture = run(1);
  const sound = run(200);
  made.adopt(PICTURE, picture);
  made.adopt(SOUND, sound);

  made.shareTheMachine();
  assert.equal(picture.isSuspended, false, "what the viewer needs before playback can continue is never paused");
  assert.equal(sound.isSuspended, true, "the soundtrack far ahead waits");
  assert.match(sound.events[0], /#200 of .*audio-only.* is wanted less urgently than #1 of .*video-only/);

  // The picture's urgent stretch is made and it moves into the next band:
  // still more urgent than the soundtrack's, which goes on waiting.
  picture.head = 4;
  made.shareTheMachine();
  assert.equal(sound.isSuspended, true);

  // The picture reaches the soundtrack's band: they share the machine.
  picture.head = 30;
  made.shareTheMachine();
  assert.equal(sound.isSuspended, false, "an encoder in the same band as the most urgent one goes on");
  assert.match(sound.events.at(-1), /^resume: nothing more urgent than #200/);
  assert.equal(picture.isSuspended, false);
});

test("two viewers each short of their own minimum share the machine", () => {
  const { made } = orchestrator();
  made.notePriorityMap(PICTURE, viewerMap(0));
  made.notePriorityMap(OTHER, [{ from: 50, to: 52, priority: 97, withinSeconds: 0, urgent: true }]);
  const first = run(0);
  const second = run(51);
  made.adopt(PICTURE, first);
  made.adopt(OTHER, second);
  made.shareTheMachine();
  assert.equal(first.isSuspended, false);
  assert.equal(second.isSuspended, false, "urgent work at a lower priority is not paused for urgent work elsewhere");
});

test("the most urgent encoder is never paused, so something is always being made", () => {
  const { made } = orchestrator();
  made.notePriorityMap(SOUND, viewerMap(0));
  const sound = run(200);
  made.adopt(SOUND, sound);
  // Nothing more urgent runs anywhere: the soundtrack far ahead is the leader.
  made.shareTheMachine();
  assert.equal(sound.isSuspended, false);
  // A paused run is let go when the run that held it back has ended.
  made.notePriorityMap(PICTURE, viewerMap(0));
  const picture = run(1);
  made.adopt(PICTURE, picture);
  made.shareTheMachine();
  assert.equal(sound.isSuspended, true);
  picture.isAlive = false;
  made.shareTheMachine();
  assert.equal(sound.isSuspended, false, "with the urgent encoder gone, nothing holds the soundtrack back");
});

test("everything needed before playback can continue is one band; priority orders only what can wait", () => {
  assert.equal(compareUrgency({ urgent: true, priority: 100 }, { urgent: true, priority: 97 }), 0);
  assert.ok(compareUrgency({ urgent: true, priority: 1 }, { urgent: false, priority: 100 }) < 0);
  assert.ok(compareUrgency({ urgent: false, priority: 98 }, { urgent: false, priority: 94 }) < 0);
  assert.equal(compareUrgency({ urgent: false, priority: 94 }, { urgent: false, priority: 94 }), 0);
});

test("an encoder is not started behind what is being made elsewhere, and is started once that is made", () => {
  const lines = [];
  const started = [];
  const made = new EncodeOrchestrator({
    maxRunsFor: () => 1,
    segmentSeconds: 4,
    killCostSec: 0,
    firstByteWaitSec: 0.12,
    startingSpeedFor: () => 1,
    now: () => 1000,
    logger: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
    makeRun: ({ address, from, to }) => {
      const one = { ...run(from), to };
      started.push({ address, from, run: one });
      return one;
    }
  });
  for (const address of [PICTURE, SOUND]) {
    made.setSegmentCount(address, 500);
    made.notePriorityMap(address, viewerMap(0));
  }
  made.noteAlreadyMade(SOUND, Array.from({ length: 200 }, (_, index) => index));
  const picture = run(1);
  made.adopt(PICTURE, picture);

  made.reconcile();
  assert.equal(started.filter((one) => one.address === SOUND).length, 0, "the soundtrack's far stretch is not started");
  assert.ok(lines.some((line) => /#200 of .*audio-only.* waits — #1 of .*video-only.* is wanted more urgently/.test(line)), lines.join("\n"));

  // The picture has made its urgent stretch and the next bands, and stands
  // in the soundtrack's band.
  made.noteAlreadyMade(PICTURE, Array.from({ length: 30 }, (_, index) => index));
  for (const one of [picture, ...started.filter((entry) => entry.address === PICTURE).map((entry) => entry.run)]) one.head = 30;
  made.reconcile();
  assert.deepEqual(started.filter((one) => one.address === SOUND).map((one) => one.from), [200],
    "once the picture is in the soundtrack's band, the soundtrack is placed");
});

test("an encoder paused and let go can be paused again", async () => {
  const { EventEmitter } = await import("node:events");
  const { EncodeRun } = await import("../../services/encode/EncodeRun.js");
  const { SoftwareEncoder } = await import("../../services/encode/SoftwareEncoder.js");
  class Process extends EventEmitter {
    constructor() {
      super();
      this.pid = 1;
      this.stdout = new EventEmitter();
      this.stdio = [null, this.stdout, null, new EventEmitter()];
      this.signals = [];
    }

    kill(signal) {
      this.signals.push(signal);
      return true;
    }
  }
  const lines = [];
  const process_ = new Process();
  const encoder = new EncodeRun({
    address: SOUND, encoder: new SoftwareEncoder(), from: 0, to: 9,
    buildArgs: () => ["-i", "in", "out"], spawn: () => process_,
    logger: { info: (line) => lines.push(line), warn: (line) => lines.push(line) }, now: () => 1000
  });
  assert.equal(encoder.pause("first"), true);
  assert.equal(encoder.isSuspended, true);
  assert.equal(encoder.resume("let go"), true);
  assert.equal(encoder.isSuspended, false, "a resumed encoder is producing again, not still suspended");
  assert.equal(encoder.pause("second"), true, "and it can be paused once more");
  assert.deepEqual(process_.signals, ["SIGSTOP", "SIGCONT", "SIGSTOP"]);
  assert.ok(!lines.some((line) => /no such edge/.test(line)), lines.join("\n"));
});
