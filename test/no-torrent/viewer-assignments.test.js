/**
 * @file What a viewer's own assignment to an output must do.
 *
 * The property under all of it: one viewer's link, seek or choice never moves
 * another viewer's output. That is roadmap item 97, and the record it replaces
 * — one entry per (file, height) for everybody — could not express it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Assignments } from "../../services/viewer/Assignments.js";

const WINDOW_MS = 30_000;
const make = () => new Assignments({ acceptWindowMs: WINDOW_MS });

test("the acceptance window is given, not invented", () => {
  assert.throws(() => new Assignments({}), TypeError);
  assert.throws(() => new Assignments({ acceptWindowMs: -1 }), TypeError);
});

test("a choice stands until the rule moves it, and a request never moves it", () => {
  const mine = make();

  mine.choose(720, "out-a");
  mine.give(mine.generation, 720, 4, "out-a");

  assert.equal(mine.chosenFor(720), "out-a");
  mine.give(mine.generation, 720, 5, "out-b");
  assert.equal(mine.chosenFor(720), "out-a", "being given something else does not re-choose");
  mine.choose(720, "out-b");
  assert.equal(mine.chosenFor(720), "out-b");
});

test("two viewers do not share an answer", () => {
  const thin = make();
  const thick = make();

  thin.choose(720, "out-540-slow");
  thick.choose(720, "out-720-full");

  assert.equal(thin.chosenFor(720), "out-540-slow");
  assert.equal(thick.chosenFor(720), "out-720-full", "the other viewer's link decided nothing here");
});

test("a repeat of a request is answered by whatever answered it, not decided again", () => {
  const mine = make();
  const first = mine.generation;

  mine.give(first, 720, 9, "out-a");

  assert.equal(mine.givenFor(first, 720, 9), "out-a");
  assert.equal(mine.givenFor(first, 720, 10), "", "a segment nothing answered says so");
  assert.equal(mine.givenFor(first + 1, 720, 9), "", "and a later generation is not the same question");
});

test("a request carries its own generation, so a late one is not read against the current", () => {
  const mine = make();
  const made = mine.generation;

  mine.statedGeneration(1, 1_000);

  assert.equal(mine.generation, 1);
  assert.notEqual(mine.generation, made);
  assert.equal(mine.accepts(made, 1_000 + WINDOW_MS), true, "inside the window it is still answered");
  assert.equal(mine.accepts(made, 1_000 + WINDOW_MS + 1), false, "past it, a new request is not");
  assert.equal(mine.accepts(mine.generation, 1_000 + 10 * WINDOW_MS), true, "the current one never runs out");
});

test("an accepted response keeps its output past its own generation's window", () => {
  const mine = make();
  const made = mine.generation;
  mine.give(made, 720, 3, "out-a");
  const token = mine.accept("out-a");

  mine.statedGeneration(1, 1_000);
  mine.choose(720, "out-b");

  const longAfter = 1_000 + 10 * WINDOW_MS;
  assert.equal(mine.accepts(made, longAfter), false, "no NEW request of that generation is taken");
  assert.ok(
    mine.heldKeys(longAfter).has("out-a"),
    "but the output whose bytes are still going out is held — dropping it is what the second deadline exists to prevent"
  );

  mine.release(token);
  assert.equal(mine.heldKeys(longAfter).has("out-a"), false, "and released once the response is done");
});

test("what was given inside a live generation holds its output, and is forgotten past the window", () => {
  const mine = make();
  const made = mine.generation;
  mine.give(made, 720, 3, "out-a");
  mine.statedGeneration(1, 1_000);

  assert.ok(mine.heldKeys(1_000 + WINDOW_MS).has("out-a"));
  assert.equal(
    mine.heldKeys(1_000 + WINDOW_MS + 1).has("out-a"),
    false,
    "past the window nothing stands on it, so it may be let go"
  );
  assert.equal(
    mine.givenFor(made, 720, 3),
    "",
    "and the generation is pruned rather than kept for the life of the viewing"
  );
});

test("a viewer leaving holds nothing, response in flight included", () => {
  const mine = make();
  mine.choose(720, "out-a");
  mine.accept("out-b");
  mine.give(mine.generation, 720, 1, "out-c");

  mine.clear();

  assert.equal(mine.heldKeys().size, 0);
});

test("the page owns the number, so a lower one does not take the viewer back", () => {
  const mine = make();
  mine.statedGeneration(4, 1_000);

  assert.equal(mine.statedGeneration(2, 2_000), 4, "a reordered or repeated message changes nothing");
  assert.equal(mine.statedGeneration(4, 2_000), 4, "and neither does the one already current");
  assert.equal(mine.generation, 4);
});

test("a request ahead of what the page has announced is still answered", () => {
  const mine = make();

  // The page raises its own number before it sends anything, so a segment
  // request can overtake the seek that announces the new viewing.
  assert.equal(mine.accepts(1), true, "being behind the page means this side has not heard yet");
  assert.equal(mine.accepts(7), true);
});

test("a request that states no generation is answered", () => {
  const mine = make();
  mine.statedGeneration(3, 1_000);

  assert.equal(mine.accepts(Number.NaN, 1_000 + 10 * WINDOW_MS), true);
  assert.equal(mine.accepts(undefined, 1_000 + 10 * WINDOW_MS), true, "a transport with no loader of ours builds no such parameter");
});
