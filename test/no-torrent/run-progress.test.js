import test from "node:test";
import assert from "node:assert/strict";
import { RunProgress } from "../../services/encode/RunProgress.js";
import { EncodeOrchestrator } from "../../services/encode/EncodeOrchestrator.js";

function orchestrator() {
  return new EncodeOrchestrator({
    maxRunsFor: () => 2,
    makeRun: () => null,
    segmentSeconds: 4,
    logger: { info() {}, warn() {} }
  });
}

test("a run rebases ffmpeg's relative clock onto its own source position", () => {
  let now = 10;
  const progress = new RunProgress({ startSeconds: 600, totalSeconds: 1000, now: () => now });
  now = 20;
  progress.note({ processedSeconds: 12.5 });

  assert.deepEqual(progress.snapshot(), {
    processedSeconds: 612.5,
    startPositionSeconds: 600,
    totalSeconds: 1000,
    percent: 3.125,
    remainingSeconds: 387.5,
    updatedAt: 20
  });
});

test("two runs of one output retain separate clocks", () => {
  const made = orchestrator();
  const first = { from: 0, to: 49, isAlive: true, progress: new RunProgress({ startSeconds: 0 }) };
  const second = { from: 50, to: 99, isAlive: true, progress: new RunProgress({ startSeconds: 200 }) };
  first.progress.note({ processedSeconds: 40 });
  second.progress.note({ processedSeconds: 8, speed: "2.0x" });
  made.adopt("picture", first);
  made.adopt("picture", second);

  assert.equal(made.progressOf("picture", 20).processedSeconds, 40);
  assert.equal(made.progressOf("picture", 60).processedSeconds, 208);
});

test("the last run's progress remains available after it ends", () => {
  const made = orchestrator();
  const progress = new RunProgress({ startSeconds: 100 });
  progress.note({ processedSeconds: 5, speed: "1.5x" });
  const run = { from: 25, to: 30, isAlive: false, state: "ENDED_COMPLETE", progress };
  made.adopt("picture", run);
  made.noteEnded({
    address: "picture",
    run,
    ending: "complete",
    because: "the assigned stretch was completed",
    from: 25,
    to: 30,
    reached: 30,
    livedMs: 1000,
    normal: true,
    lastError: ""
  });

  assert.equal(made.progressOf("picture").processedSeconds, 105);
});
