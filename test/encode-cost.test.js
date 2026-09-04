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
import { EncodeCost } from "../services/quality/EncodeCost.js";

/**
 * @param {object} [readings]
 * @returns {{ cost: EncodeCost, asked: () => number, host: { share: number } }}
 */
function costOn(readings = {}) {
  let asked = 0;
  const host = { share: 1 };
  const cost = new EncodeCost({
    liveOutputs: { familyOf: () => [], variantHeightOf: () => 0 },
    host: () => {
      asked += 1;
      return {
        benchmark: readings.benchmark ?? null,
        decodeModel: null,
        contentionPenalties: null,
        availability: { known: true, share: host.share }
      };
    },
    audioCostKey: () => "audio",
    runningEncoders: () => 0,
    encodersRunningNow: () => 0,
    torrentCostSecFor: () => 0
  });
  return { cost, asked: () => asked, host };
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

test("what an encoder taught this host is held here, and nowhere else", () => {
  const { cost } = costOn();
  cost.copyCost.set("torrent:abc:0", { costSec: 0.125, readings: [8], version: 1 });
  assert.equal(cost.copyCost.get("torrent:abc:0").costSec, 0.125);
  assert.equal(cost.audioCost.size, 0);
  assert.equal(cost.decodeCost.size, 0);
});
