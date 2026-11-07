/**
 * @file `viewerRelationsFor` (production, `services/viewer/choices.js`) and `helpers/renditions.js`
 * (torrent-tv/meta#309).
 *
 * The Renditions host has a part that is only the viewers' records asked by name — what a person
 * watches, has chosen, is being warmed for, was last given. It was written out in
 * `wire-outputs.js` and copied into three checks, and the copies drifted: none had
 * `stepBeingWarmedSinceOf`, `outputStillNeeded` or `sameHeightSwitchOf` as production has them. It is
 * now ONE function over a `Viewers`, used by production and by the helper. Whether a migrated file
 * still asserts what it did is the existing checks staying green plus the guard in
 * `shared-test-helpers-guard.test.js`; this file states what the shared part answers.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Renditions } from "../../services/encode/Renditions.js";
import { viewerRelationsFor } from "../../services/viewer/choices.js";
import { Viewers } from "../../services/viewer/Viewers.js";
import { renditionsHost } from "./helpers/renditions.js";

const PROXY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (...parts) => readFileSync(path.join(PROXY, ...parts), "latin1");

/** Every port of the Renditions host that is the viewers' records and nothing else. */
const VIEWER_RELATIONS = [
  "viewerCountOn", "outputStillNeeded", "consumersOn", "presentOn", "qualityModeOf", "linkMbpsOf", "audioChoiceOf",
  "chooseAudioTrack", "stepOnScreenOf", "noteStepOnScreen", "stepBeingWarmedOf", "stepBeingWarmedSinceOf",
  "noteStepBeingWarmed", "audioBeingWarmedOf", "noteAudioBeingWarmed", "watches", "placeOn", "generationOfRequest",
  "givenOutputOf", "noteGivenOutput", "chosenOutputOf", "chooseOutput", "noteServingVerdict", "heightsChosenAs",
  "highestGivenSegmentOf", "sameHeightSwitchOf", "noteSameHeightSwitch", "switchingOnto", "switchingFrom",
  "bufferedSecondsOf"
];

test("viewerRelationsFor(viewers) names every viewer relation of the Renditions host, each a function", () => {
  const relations = viewerRelationsFor(new Viewers());
  assert.deepEqual(VIEWER_RELATIONS.filter((name) => typeof relations[name] !== "function"), []);
});

test("viewerRelationsFor answers over the viewers it was given and no others", () => {
  const viewersA = new Viewers();
  const viewersB = new Viewers();
  const output = { id: "out-1", outputKey: "k1" };
  const a = viewerRelationsFor(viewersA);
  const b = viewerRelationsFor(viewersB);

  viewersA.of(output, "viewer-1");

  assert.equal(a.viewerCountOn(output), 1);
  assert.equal(b.viewerCountOn(output), 0);
  assert.equal(a.outputStillNeeded(output), true, "somebody stands on it");
  assert.equal(b.outputStillNeeded(output), false, "nobody does, in the other viewers");
  viewersA.of({ id: "out-2", outputKey: "k2" }, "viewer-2");
  a.watches(output, "viewer-2");
  assert.equal(a.viewerCountOn(output), 2, "watches puts a viewer on the output in the viewers it was given");
  assert.equal(b.viewerCountOn(output), 0, "and not in the others");
});

test("the step being warmed is recorded with when it began, and cleared with it (stepBeingWarmedSinceOf)", () => {
  const viewers = new Viewers();
  const relations = viewerRelationsFor(viewers);
  const output = { id: "out-1", outputKey: "k1" };
  viewers.of(output, "viewer-1");
  assert.equal(relations.stepBeingWarmedOf(output, "viewer-1"), null);
  assert.equal(relations.stepBeingWarmedSinceOf(output, "viewer-1"), null);

  relations.noteStepBeingWarmed(output, "viewer-1", "step-7");

  assert.equal(relations.stepBeingWarmedOf(output, "viewer-1"), "step-7");
  assert.equal(Number.isFinite(relations.stepBeingWarmedSinceOf(output, "viewer-1")), true);
  relations.noteStepBeingWarmed(output, "viewer-1", null);
  assert.equal(relations.stepBeingWarmedOf(output, "viewer-1"), null);
  assert.equal(relations.stepBeingWarmedSinceOf(output, "viewer-1"), null);
});

test("the move between limits being prepared round-trips and clears (sameHeightSwitchOf)", () => {
  const viewers = new Viewers();
  const relations = viewerRelationsFor(viewers);
  const output = { id: "out-1", outputKey: "k1" };
  viewers.of(output, "viewer-1");
  const move = { askedHeights: [720], outputId: "out-2", outputKey: "k2", direction: "down", reason: "slow", since: 5 };
  assert.equal(relations.sameHeightSwitchOf("viewer-1"), null);
  relations.noteSameHeightSwitch("viewer-1", move);
  assert.deepEqual(relations.sameHeightSwitchOf("viewer-1"), move);
  relations.noteSameHeightSwitch("viewer-1", null);
  assert.equal(relations.sameHeightSwitchOf("viewer-1"), null);
});

test("what a viewer was given and chose is the viewer's own record", () => {
  const viewers = new Viewers();
  const relations = viewerRelationsFor(viewers);
  const output = { id: "out-1", outputKey: "k1" };
  viewers.of(output, "viewer-1");

  relations.chooseOutput("viewer-1", 720, "k2");
  relations.noteGivenOutput("viewer-1", 0, 720, 3, "k2");

  assert.equal(relations.chosenOutputOf("viewer-1", 720), "k2");
  assert.deepEqual(relations.heightsChosenAs("viewer-1", "k2"), [720]);
  assert.equal(relations.givenOutputOf("viewer-1", 0, 720, 3), "k2");
  assert.equal(relations.givenOutputOf("viewer-1", 0, 720, 4), "");
  assert.equal(relations.generationOfRequest("viewer-1", 4), 4);
  assert.equal(relations.generationOfRequest("viewer-1", undefined), 0);
});

test("renditionsHost(viewers) carries every viewer relation, the three the copies lacked among them", () => {
  const host = renditionsHost(new Viewers());
  assert.deepEqual(VIEWER_RELATIONS.filter((name) => typeof host[name] !== "function"), []);
  for (const name of ["stepBeingWarmedSinceOf", "outputStillNeeded", "sameHeightSwitchOf"]) {
    assert.equal(typeof host[name], "function", `${name} is what production has and the copies did not`);
  }
});

test("renditionsHost's relations are over its viewers", () => {
  const viewers = new Viewers();
  const host = renditionsHost(viewers);
  const output = { id: "out-1", outputKey: "k1" };
  viewers.of(output, "viewer-1");
  assert.equal(host.viewerCountOn(output), 1);
  assert.equal(host.outputStillNeeded(output), true);
});

test("renditionsHost gives the inert ports the three checks all wrote: nobody has a position, nothing is on screen", () => {
  const host = renditionsHost(new Viewers());
  assert.equal(host.viewerSecondsOn({}, "viewer-1", 0), 0);
  assert.equal(host.viewerPositionOf("id", "viewer-1"), 0);
  assert.equal(host.encodeRuns.isLive({}), true);
  assert.ok(host.quality.variantsOnScreen() instanceof Set);
  assert.equal(host.quality.variantsOnScreen().size, 0);
});

test("a port named in the overrides replaces the helper's, and the rest stay", () => {
  const viewers = new Viewers();
  const mine = () => 41;
  const host = renditionsHost(viewers, { viewerSecondsOn: mine, createOrGetSession: async () => null });
  assert.equal(host.viewerSecondsOn, mine);
  assert.equal(typeof host.createOrGetSession, "function");
  assert.equal(typeof host.sameHeightSwitchOf, "function");
  assert.equal(host.viewerPositionOf("id", "viewer-1"), 0);
});

test("a Renditions can be built on the helper's host", () => {
  const host = renditionsHost(new Viewers(), { outputs: new Map() });
  assert.doesNotThrow(() => new Renditions(host));
});

test("parity: the Renditions host of wire-outputs.js and the helper take their viewer relations from the same function", () => {
  const production = read("services", "server", "wire-outputs.js");
  const helper = read("test", "no-torrent", "helpers", "renditions.js");

  assert.match(production, /\.\.\.viewerRelationsFor\(parts\.viewers\)/, "wire-outputs.js builds its host from viewerRelationsFor");
  assert.match(helper, /viewerRelationsFor\(/, "helpers/renditions.js builds its host from viewerRelationsFor");
  for (const [name, source] of [["wire-outputs.js", production], ["helpers/renditions.js", helper]]) {
    assert.match(source, /import\s*\{[^}]*\bviewerRelationsFor\b[^}]*\}\s*from\s*"[./]*(?:services\/)?viewer\/choices\.js"/, `${name} imports it from viewer/choices.js`);
    const spelledOut = VIEWER_RELATIONS.filter((port) => new RegExp(`^\\s*${port}: \\(`, "m").test(source));
    assert.deepEqual(spelledOut, [], `${name} writes these relations out again instead of taking them from viewerRelationsFor`);
  }
});
