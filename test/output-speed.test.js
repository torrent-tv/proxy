/**
 * @file How fast this machine produces one output.
 *
 * The figure every decision in the encoding layer rests on: where an encoder
 * goes and how many run are both worked out from arrivals, and an arrival is a
 * distance divided by this. There must therefore ALWAYS be an answer, and each
 * of the three that can be given is a measurement rather than a guess.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EncodeCost } from "../services/quality/EncodeCost.js";
import { LiveOutputs } from "../services/output/LiveOutputs.js";

const PICTURE = "torrent:abc:fmt=fmp4:grid=kf@0:video-only:v=0/copy";

/**
 * @param {object[]} sessions
 * @param {{ copySpeedX?: number | null, benchmark?: object[] | null }} host
 */
function costOf(sessions, host = {}) {
  const sessionsById = new Map(sessions.map((session, index) => [String(index), session]));
  return new EncodeCost({
    liveOutputs: new LiveOutputs({ sessionsById }),
    host: () => ({
      benchmark: host.benchmark ?? null,
      decodeModel: null,
      contentionPenalties: null,
      copySpeedX: host.copySpeedX ?? null,
      availability: null
    }),
    audioCostKey: () => "",
    runningEncoders: () => 0,
    encodersRunningNow: () => 0,
    torrentCostSecFor: () => 0
  });
}

test("a run on this output outranks every prediction", () => {
  // It is this machine, this material and these settings. Nothing said before
  // the fact beats something seen happening.
  const cost = costOf(
    [{ outputKey: PICTURE, state: "ready", transcodeVideo: false, lastAloneSpeed: 9.5 }],
    { copySpeedX: 600 }
  );
  assert.equal(cost.speedForOutput(PICTURE), 9.5);
});

test("a copied picture is priced by the startup copy measurement", () => {
  // The branch that had no figure at all until it was measured: copying neither
  // decodes nor encodes, so neither the preset benchmark nor the decode model
  // describes it, and a copied output was planned with no speed until its own
  // run had been running long enough to report one.
  const cost = costOf(
    [{ outputKey: PICTURE, state: "ready", transcodeVideo: false, lastAloneSpeed: null }],
    { copySpeedX: 602 }
  );
  assert.equal(cost.speedForOutput(PICTURE), 602);
});

test("the fastest reading wins where several sessions produce one output", () => {
  // Two sessions whose output parameters agree ARE one output, so what either
  // of them measured about this machine is true of the other.
  const cost = costOf([
    { outputKey: PICTURE, state: "ready", transcodeVideo: false, lastAloneSpeed: 4 },
    { outputKey: PICTURE, state: "ready", transcodeVideo: false, lastAloneSpeed: 7 }
  ]);
  assert.equal(cost.speedForOutput(PICTURE), 7);
});

test("a disposed session says nothing about what the machine is doing", () => {
  const cost = costOf(
    [{ outputKey: PICTURE, state: "disposed", transcodeVideo: false, lastAloneSpeed: 4 }],
    { copySpeedX: 602 }
  );
  assert.equal(cost.speedForOutput(PICTURE), 0, "no live session, so nothing to say");
});

test("another output's reading is not borrowed", () => {
  // Two outputs are two different pieces of work — a picture re-encoded to 480p
  // and the same picture copied are not the same speed.
  const cost = costOf([
    { outputKey: "other", state: "ready", transcodeVideo: false, lastAloneSpeed: 40 }
  ]);
  assert.equal(cost.speedForOutput(PICTURE), 0);
});
