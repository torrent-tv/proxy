/**
 * @file What encoding costs this machine, asked of the object that owns it.
 *
 * The arithmetic itself is exercised end to end by `auto-quality-step` and
 * `quality-variants`, which go through the session manager. What is pinned here
 * is the seam the move created: this object is given the host's readings as a
 * QUESTION rather than a copy, and it holds what an encoder taught it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EncodeCost } from "../services/encode/quality/EncodeCost.js";
import { startRunOn } from "./helpers/encode-run.js";
import { outputSpec } from "./helpers/output-spec.js";
import { runStateOf } from "../services/encode/encode-run-state.js";

/**
 * @param {object} [readings]
 * @returns {{ cost: EncodeCost, asked: () => number, host: { share: number } }}
 */
function costOn(readings = {}) {
  let asked = 0;
  const host = { share: 1 };
  const cost = new EncodeCost({
    outputs: {
      familyOf: (session) => readings.familyOf?.(session) ?? [],
      variantHeightOf: () => 0
    },
    host: () => {
      asked += 1;
      return {
        benchmark: readings.benchmark ?? null,
        decodeModel: null,
        contentionPenalties: null,
        availability: { known: true, share: host.share }
      };
    },
    runningEncoders: () => readings.runningEncoders?.() ?? 0,
    encodersRunningNow: () => 0,
    torrentCostSecFor: () => 0,
    boundBy: async () => readings.boundBy ?? "cpu",
    runsFor: (session) => [...(session.runs ?? [])],
    stateFor: (session) => runStateOf(session.runs),
    progressFor: (session) => session.progress ?? null
  });
  return { cost, asked: () => asked, host };
}

/**
 * A session with one run going, of the kind this file measures.
 *
 * @param {{ audioOnly?: boolean, transcodeVideo?: boolean, audioSourceTrackIndex?: number, key?: string }} [what]
 * @returns {object}
 */
function sessionProducing(what = {}) {
  const session = {
    id: "1111111122223333",
    state: "ready",
    spec: outputSpec({
      audioOnly: what.audioOnly === true,
      transcodeVideo: what.transcodeVideo === true,
      audioSourceTrackIndex: what.audioSourceTrackIndex ?? 0
    }),
    file: { key: what.key ?? "torrent:abc:0", name: "film.mkv" },
    output: { encodeWidth: 0, encodeHeight: 0, outputFps: 25, softwarePreset: null },
    progress: { processedSeconds: 0 },
    runs: new Set()
  };
  startRunOn(session, { from: 0, speedX: 1 });
  return session;
}

/**
 * Two readings of one run, far enough apart to be a speed.
 *
 * @param {EncodeCost} cost
 * @param {object} session
 * @param {number} speedX - Seconds of film produced per second of clock.
 * @returns {Promise<void>}
 */
async function watchItRun(cost, session, speedX) {
  session.progress.processedSeconds = 0;
  await cost.learnFrom(session);
  // The pair is a DELTA, and the first reading has nothing to be a delta from.
  // Backdated rather than waited for: the window a speed may be read over is
  // seconds, and a test that sleeps through it measures the clock.
  session.learnSample.takenAt -= 10_000;
  session.progress.processedSeconds = 10 * speedX;
  await cost.learnFrom(session);
}

test("the host is asked at the moment of the question, not when this was built", () => {
  // The share of the machine that is free is re-read every few seconds. Copied
  // into this object when it was made, every later rung would be priced against
  // a machine that has gone.
  const { cost, asked, host } = costOn();
  assert.equal(asked(), 0, "nothing is read until something is asked");

  cost.sustainableHeights({ heights: [1080], sourceWidth: 1920, sourceHeight: 1080, fps: 24, source: null, transcodeVideo: true, ownHeight: 0 });
  const first = asked();
  assert.ok(first > 0);

  host.share = 0.1;
  cost.sustainableHeights({ heights: [1080], sourceWidth: 1920, sourceHeight: 1080, fps: 24, source: null, transcodeVideo: true, ownHeight: 0 });
  assert.ok(asked() > first, "and read again on the next question");
});

test("with no benchmark to judge by, every height offered is kept", () => {
  // Nothing measured is not the same as nothing possible. Refusing here would
  // hide the whole ladder on a host whose startup measurement failed.
  const { cost } = costOn({ benchmark: null });
  const kept = cost.sustainableHeights({
    heights: [1080, 720, 480],
    sourceWidth: 1920,
    sourceHeight: 1080,
    fps: 24,
    source: null,
    transcodeVideo: true,
    ownHeight: 0
  });
  assert.deepEqual(kept, [1080, 720, 480]);
});

test("a rung measured below realtime is withdrawn, and a copied source height is not", () => {
  const { cost } = costOn({ benchmark: null });
  const kept = cost.sustainableHeights({
    heights: [1080, 480],
    sourceWidth: 1920,
    sourceHeight: 1080,
    fps: 24,
    source: null,
    // The base copies its picture, so the source height costs no encoder.
    transcodeVideo: false,
    ownHeight: 1080,
    measuredHeights: new Map([[480, 0.4]])
  });
  assert.deepEqual(kept, [1080], "the copy stays; the rung seen failing does not");
});

test("what an encoder taught this host is learned here, and held here", () => {
  // The three that learn were methods of the session manager, writing into maps
  // this object owned — one keeper, a different author, and the maps public for
  // it. Nothing outside can write a price now, and nothing outside needs to.
  const { cost } = costOn();

  assert.equal(typeof cost.learnFrom, "function");
  assert.equal(cost.copyCost, undefined, "the store is not the surface");
  assert.equal(cost.decodeCostFor("torrent:abc:0"), null, "and nothing is known until an encoder says so");
});

test("a copy is priced from what it was seen doing", async () => {
  const { cost } = costOn();
  const session = sessionProducing({ transcodeVideo: false });

  await watchItRun(cost, session, 8);

  assert.equal(cost.copyVersionFor("torrent:abc:0"), 1, "the price is published, so every offer recomputes");
  assert.equal(
    session.lastAloneSpeed.toFixed(2),
    "8.00",
    "and what it did with the machine to itself is on the session, which withdraws a step seen failing"
  );
});

test("a reading taken while the swarm is short is not filed as the price of this host", async () => {
  // A run starved of torrent data reports a speed that measures the swarm. Filed
  // as a price it reads as more work per second than the machine has, and every
  // quality step is then refused on the download's account.
  const { cost } = costOn({ boundBy: "download" });
  const session = sessionProducing({ transcodeVideo: false });

  await watchItRun(cost, session, 0.3);

  assert.equal(cost.copyVersionFor("torrent:abc:0"), 0, "nothing was learned about the machine");
  assert.equal(session.lastAloneSpeed, undefined, "and nothing claims this rung was seen failing");
});

test("a picture's reading taken beside another encoder is not filed", async () => {
  // It contains that other encoder's work, and the budget ADDS the same work
  // again when it predicts — so the price is counted twice and grows with every
  // reading. Measured in the field 2026-08-15: copying, whose truth is 7.9x, was
  // learned as 2.03x, and the quality menu collapsed to one height.
  const { cost } = costOn({ runningEncoders: () => 2 });
  const session = sessionProducing({ transcodeVideo: false });

  await watchItRun(cost, session, 8);

  assert.equal(cost.copyVersionFor("torrent:abc:0"), 0);
});

test("one reading is not a speed", async () => {
  const { cost } = costOn();
  const session = sessionProducing({ transcodeVideo: false });
  session.progress.processedSeconds = 40;

  await cost.learnFrom(session);

  assert.equal(cost.copyVersionFor("torrent:abc:0"), 0, "a delta needs two readings of one run");
  assert.ok(session.learnSample, "and the first is kept to be the other half of the next");
});

test("a pair that straddles a restart measures the seek, not the host", async () => {
  const { cost } = costOn();
  const session = sessionProducing({ transcodeVideo: false });
  await cost.learnFrom(session);
  session.learnSample.takenAt -= 10_000;
  // A new run, at another place in the film: twenty minutes of film against five
  // seconds of clock is a seek, and filed as a price it admits every step there
  // is.
  session.runs = new Set();
  startRunOn(session, { from: 300, speedX: 1 });
  session.progress.processedSeconds = 1200;

  await cost.learnFrom(session);

  assert.equal(cost.copyVersionFor("torrent:abc:0"), 0);
});

test("two soundtracks of one file are priced apart", async () => {
  // The key names the TRACK, not the file. A dub and the original run at
  // different speeds — different codecs, different channel counts — and one key
  // for both files each over the other's readings.
  const { cost } = costOn();
  const first = sessionProducing({ audioOnly: true });
  const second = sessionProducing({ audioOnly: true, audioSourceTrackIndex: 1 });

  await watchItRun(cost, first, 40);

  assert.equal(cost.audioVersionFor(first), 1);
  assert.equal(cost.audioVersionFor(second), 0, "the other track has been told nothing about itself");
});

test("a soundtrack's own share is what is left after everything else running is paid for", async () => {
  // A rendition runs for exactly as long as the picture it accompanies, so
  // "alone" is a state it is never in and the price stayed unmeasured for ever.
  // Its share is recovered by subtracting what the machine is already known to
  // be spending — which is only possible once that other work HAS a price.
  const picture = sessionProducing({ transcodeVideo: false });
  const sound = sessionProducing({ audioOnly: true });
  let running = 1;
  const { cost } = costOn({
    runningEncoders: () => running,
    familyOf: () => [picture, sound]
  });

  // The picture alone first, so copying has a price: 8x, i.e. 0.125 s/s.
  await watchItRun(cost, picture, 8);
  assert.equal(cost.copyVersionFor("torrent:abc:0"), 1);

  // Now the pair. The reading off the soundtrack contains both, at 4x — 0.25 s/s
  // together — so the sound's own share is 0.25 − 0.125 = 0.125 s/s.
  running = 2;
  await watchItRun(cost, sound, 4);

  assert.equal(cost.audioVersionFor(sound), 1, "the soundtrack has a price at last");
  // What was filed, read back the way the product reads it: the sum of what
  // everything OTHER than the picture is costing. Charged the whole reading
  // instead of its own share, a soundtrack is priced at twice the truth and
  // refuses quality steps the host could hold.
  running = 1;
  assert.equal(
    cost.pricedConcurrentCost(picture).toFixed(3),
    "0.125",
    "0.25 s/s together, less the 0.125 s/s the copy was already known to cost"
  );
});

test("nothing is attributed to a soundtrack while something running has no price", async () => {
  const picture = sessionProducing({ transcodeVideo: true });
  const sound = sessionProducing({ audioOnly: true });
  const { cost } = costOn({
    runningEncoders: () => 2,
    // A re-encoded picture with no benchmark to price it by and no speed of its
    // own: unpriced work, which would otherwise land in the soundtrack's account
    // and refuse quality steps on it.
    familyOf: () => [picture, sound]
  });

  await watchItRun(cost, sound, 4);

  assert.equal(cost.audioVersionFor(sound), 0);
});
