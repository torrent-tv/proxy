/**
 * @file The places preparations hold on the machine are read off the viewers'
 * own records (roadmap item 97, step 13): a step being warmed and a move to
 * another limit of the height on screen are one list, and a place ends with
 * the record — or the viewer — that holds it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Viewers } from "../../services/viewer/Viewers.js";
import { outputsBeingPrepared } from "../../services/viewer/choices.js";

const PICTURE = { id: "1111111122223333", outputKey: "picture" };

test("a warmed step and a move between limits are one list of places", () => {
  const viewers = new Viewers();
  const warming = viewers.of(PICTURE, "viewer-a");
  warming.warmingVariantId = "2222222233334444";
  const moving = viewers.of(PICTURE, "viewer-b");
  moving.sameHeightSwitch = { outputId: "3333333344445555", outputKey: "limit", askedHeights: [720] };
  assert.deepEqual([...outputsBeingPrepared(viewers)].sort(), ["2222222233334444", "3333333344445555"]);
});

test("one output prepared for two viewers is one place", () => {
  const viewers = new Viewers();
  viewers.of(PICTURE, "viewer-a").warmingVariantId = "2222222233334444";
  viewers.of(PICTURE, "viewer-b").sameHeightSwitch = { outputId: "2222222233334444", outputKey: "step" };
  assert.equal(outputsBeingPrepared(viewers).size, 1);
});

test("a place ends with its record, and with the viewer", () => {
  const viewers = new Viewers();
  const viewer = viewers.of(PICTURE, "viewer-a");
  viewer.warmingVariantId = "2222222233334444";
  viewer.warmingVariantId = null;
  assert.equal(outputsBeingPrepared(viewers).size, 0, "the record cleared");
  viewers.of(PICTURE, "viewer-b").warmingVariantId = "2222222233334444";
  viewers.hasGone("viewer-b");
  assert.equal(outputsBeingPrepared(viewers).size, 0, "the viewer gone");
});
