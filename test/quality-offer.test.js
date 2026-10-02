/**
 * @file Which heights are on the menu, and when that answer may be reused.
 *
 * The arithmetic is `EncodeCost` and is checked next door. What is checked here
 * is the part that is not arithmetic: whose answer it is, what may never be
 * withdrawn, and the cache — which is the whole reason this is an object, and
 * which had no check of any kind while it lived in the session manager.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EncodeCost } from "../services/encode/quality/EncodeCost.js";
import { QualityOffer } from "../services/encode/quality/QualityOffer.js";
import { startRunOn } from "./helpers/encode-run.js";
import { outputSpec } from "./helpers/output-spec.js";
import { runStateOf } from "../services/encode/encode-run-state.js";
import { qualityStateOf } from "../services/encode/quality/OutputQualityState.js";

/**
 * A session with one run going.
 *
 * @returns {object}
 */
function sessionProducing() {
  const session = {
    id: "1111111122223333",
    state: "ready",
    spec: outputSpec(),
    file: { key: "torrent:abc:0", name: "film.mkv", width: 1920, height: 1080 },
    output: { encodeWidth: 0, encodeHeight: 0, outputFps: 25, softwarePreset: null },
    progress: { processedSeconds: 0 },
    runs: new Set()
  };
  startRunOn(session, { from: 0, speedX: 1 });
  return session;
}

/**
 * A picture, and the offer's cache in play.
 *
 * @param {object} [supply]
 * @returns {{ offer: QualityOffer, picture: object, computed: () => number, supply: object }}
 */
function offerOver(
  supply = { requiredSpeed: null, megabytesPerSecond: null, costPerMegabyte: null },
  occupancyKnownFor = () => true
) {
  const picture = sessionProducing();
  const outputs = {
    familyOf: () => [picture],
    pictureOf: () => picture,
    variantHeightOf: () => 0,
    sessionsOn: () => []
  };
  const cost = new EncodeCost({
    outputs,
    host: () => ({ benchmark: null, decodeModel: null, contentionPenalties: null, availability: null }),
    runningEncoders: () => 0,
    encodersRunningNow: () => 0,
    torrentCostSecFor: () => 0,
    runsFor: (session) => [...(session.runs ?? [])],
    stateFor: (session) => runStateOf(session.runs),
    workSampleFor: (session) => session.work ?? null
  });
  let computed = 0;
  const real = cost.sustainableHeights.bind(cost);
  cost.sustainableHeights = (params) => {
    computed += 1;
    return real(params);
  };
  const offer = new QualityOffer({
    encodeCost: cost,
    outputs,
    stateFor: (session) => runStateOf(session.runs),
    heightsOnScreen: () => [],
    supplyFor: () => supply,
    occupancyKnownFor
  });
  return { offer, picture, computed: () => computed, supply };
}

test("the pool gets no positive answer while another occupied output has no measured cost", () => {
  const { offer } = offerOver(undefined, () => false);

  assert.equal(
    offer.predictOfferedHeights({ width: 1920, height: 1080, fps: 25, bitrateKbps: 5000 }),
    null
  );
});

test("the offer is computed once and then answered from the cache", () => {
  // It is asked on the path that serves every playlist, every init and every
  // segment. Recomputing it each time is the arithmetic of the whole ladder per
  // request, and its refusal line written for the life of the film.
  const { offer, picture, computed } = offerOver();

  offer.offeredHeightsFor(picture);
  offer.offeredHeightsFor(picture);

  assert.equal(computed(), 1);
});

test("what the swarm is doing is part of what identifies that cached answer", () => {
  // The bar rises when the reader meets interruptions and the torrent's price
  // moves every few seconds. Left out of the key, a menu computed while nothing
  // was known about the swarm would stand for the whole film — offering steps
  // supply cannot support, and passing every route guard on the way.
  const supply = { requiredSpeed: null, megabytesPerSecond: null, costPerMegabyte: null };
  const { offer, picture, computed } = offerOver(supply);
  offer.offeredHeightsFor(picture);

  supply.requiredSpeed = 6.12;
  offer.offeredHeightsFor(picture);
  assert.equal(computed(), 2, "the bar this file's own interruptions demand moved");

  supply.megabytesPerSecond = 1.4;
  offer.offeredHeightsFor(picture);
  assert.equal(computed(), 3, "and so did what a viewer draws through it");

  supply.costPerMegabyte = 0.05;
  offer.offeredHeightsFor(picture);
  assert.equal(computed(), 4, "and what a megabyte costs this process");
});

test("and so is what each running encode was last seen doing", () => {
  // It is an input twice over — it withdraws a step measured below realtime,
  // and it prices every running picture in the committed total. On a COPIED
  // picture nothing else in the key ever moves, so without this the menu would
  // be pinned to what was computed before anything had been measured.
  const { offer, picture, computed } = offerOver();
  offer.offeredHeightsFor(picture);

  qualityStateOf(picture).lastAloneSpeed = 0.4;
  offer.offeredHeightsFor(picture);

  assert.equal(computed(), 2);
});

test("a step asking for the family's answer does not keep it as its own", () => {
  // A step is a session of its own and knows only its own encode: asked while
  // the viewer watches 240p, the 240p session priced the 1080p step as a
  // re-encode — because ITS video is re-encoded — and refused it on a host that
  // had been serving that very height by COPY minutes earlier. Only the picture
  // knows what the family can do with the source, so the picture answers; and
  // the answer must not then be filed on the asker, whose own flags are what
  // made the wrong answer possible in the first place.
  const { offer, picture } = offerOver();
  const step = sessionProducing();
  step.id = "9999999988887777";
  step.spec = outputSpec({ transcodeVideo: true });

  const answer = offer.offeredHeightsFor(step);

  assert.ok(Array.isArray(answer), "the step is still answered — its viewer is watching it");
  assert.equal(qualityStateOf(step).offeredHeightsCache, undefined, "and nothing is filed on the asker");
  assert.equal(
    qualityStateOf(picture).offeredHeightsCache,
    undefined,
    "nor on the picture, whose own key was never the one this answer was computed against"
  );
});
