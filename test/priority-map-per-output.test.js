/**
 * @file One fact asked at two scopes: what the swarm is asked for, and what the
 * encoders are placed by.
 *
 * Both are right for what asks them. The swarm is asked for bytes of a FILE,
 * and the picture, a quality step and a soundtrack of one film read the same
 * bytes — so every viewer of any of them wants that file's bytes. Encoders are
 * placed per OUTPUT, and a person watching 480p wants nothing of the 1080p
 * output at all.
 *
 * One map for both was the second authority over encoders. Every output of a
 * film was handed the whole film's map, so the plan wanted an encoder on every
 * one of them; what actually stopped the ones nobody was watching was the
 * session manager killing them by its own judgement — and since a viewer moving
 * between steps also announces itself, the plan started them again on the next
 * pass. Field 2026-09-08.
 *
 * Built out of the real classes throughout: the real viewer registry holds real
 * viewers, the real `LiveOutputs` answers what a film's shape is, and the real
 * `PriorityOrchestrator` builds the maps. A session is a plain object in this
 * proxy — there is no class for one — so the literals below are the thing
 * itself and not a stand-in for it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PriorityOrchestrator } from "../services/priority/PriorityOrchestrator.js";
import { LiveOutputs } from "../services/output/LiveOutputs.js";
import { Viewers } from "../services/viewer/Viewers.js";
import { viewersOf } from "../services/viewer/Viewer.js";
import { runsOf } from "../services/priority/PriorityMap.js";

const FILM = { sourceKey: "source-1", fileIndex: 0, durationSeconds: 600 };
const STALE_AFTER_MS = 60_000;

/**
 * A session, as much of one as these classes read.
 *
 * @param {{ id: string, outputKey: string, isStep?: boolean, audioOnly?: boolean }} params
 * @returns {object}
 */
function outputOf({ id, outputKey, isStep = false, audioOnly = false }) {
  return {
    id,
    outputKey,
    isStep,
    audioOnly,
    state: "ready",
    sourceKey: FILM.sourceKey,
    fileIndex: FILM.fileIndex,
    file: { key: "film-1", durationSeconds: FILM.durationSeconds }
  };
}

/**
 * The real orchestrator over the real registry, wired the way the session
 * manager wires it.
 *
 * @param {object[]} sessions
 * @returns {{ priority: PriorityOrchestrator, viewers: Viewers, publish: () => void }}
 */
function over(sessions) {
  const live = new LiveOutputs({ sessionsById: new Map(sessions.map((one) => [one.id, one])) });
  const viewers = new Viewers();
  const priority = new PriorityOrchestrator({
    publish: () => {},
    viewersOf: (session) => viewersOf(session),
    allowanceFor: () => 10,
    watchedBy: (session, viewer) => live.watchedBy(session, viewer)
  });
  return {
    priority,
    viewers,
    live,
    publish: () => priority.publishFor({ sessionGroups: [sessions], staleAfterMs: STALE_AFTER_MS })
  };
}

test("a person on a step wants nothing of the picture they stepped off", () => {
  const picture = outputOf({ id: "pic", outputKey: "out:1080" });
  const step = outputOf({ id: "step", outputKey: "out:480", isStep: true });
  const { priority, viewers, publish } = over([picture, step]);
  // ONE viewer object per person, referenced from both outputs — which is why
  // the step they are on is known when the picture is asked about.
  viewers.of(picture, "p");
  const person = viewers.of(step, "p");
  person.moveTo(300);
  person.activeVariantId = "step";
  publish();

  assert.ok(
    runsOf(priority.mapForOutput("out:480")).length > 0,
    "the step they are watching is wanted"
  );
  assert.deepEqual(
    runsOf(priority.mapForOutput("out:1080")),
    [],
    "and the picture is producing for nobody, which is what makes its encoder unwanted"
  );
  // The bytes are another matter: both outputs read the same file, and the
  // swarm is asked for the file.
  assert.ok(
    runsOf(priority.mapFor(FILM.sourceKey, FILM.fileIndex)).length > 0,
    "the download still wants the film, because that is what is being watched"
  );
});

test("a soundtrack is wanted by whoever is registered on it", () => {
  const picture = outputOf({ id: "pic", outputKey: "out:1080" });
  const sound = outputOf({ id: "rus", outputKey: "out:a1", audioOnly: true });
  const { priority, viewers, publish } = over([picture, sound]);
  // Standing on a STEP of the picture says nothing about the sound: the tracks
  // nobody chose are let go of where a track is chosen, so being known to a
  // soundtrack is listening to it.
  const person = viewers.of(sound, "p");
  person.moveTo(120);
  person.activeVariantId = "step";
  publish();

  assert.ok(runsOf(priority.mapForOutput("out:a1")).length > 0);
});

test("a step being warmed is wanted, and so is the picture still on screen", () => {
  // Both are genuinely being produced through a warm-up, which is the price of
  // the switch not being visible. Whether the machine can afford two encoders
  // is the budget's question and not this one's.
  const picture = outputOf({ id: "pic", outputKey: "out:1080" });
  const step = outputOf({ id: "step", outputKey: "out:480", isStep: true });
  const { priority, viewers, publish } = over([picture, step]);
  viewers.of(picture, "p");
  const person = viewers.of(step, "p");
  person.moveTo(300);
  person.warmingVariantId = "step";
  publish();

  assert.ok(runsOf(priority.mapForOutput("out:1080")).length > 0, "still on screen");
  assert.ok(runsOf(priority.mapForOutput("out:480")).length > 0, "being made ready");
});

test("an output everybody has left is stated as empty, not left as it was", () => {
  // The difference matters: the plan stops the encoders of an output whose map
  // is empty, and would keep the map it had when somebody was watching.
  const picture = outputOf({ id: "pic", outputKey: "out:1080" });
  const { priority, viewers, publish } = over([picture]);
  viewers.of(picture, "p").moveTo(300);

  publish();
  assert.ok(runsOf(priority.mapForOutput("out:1080")).length > 0);

  viewers.leaves(picture, "p");
  publish();
  assert.deepEqual(runsOf(priority.mapForOutput("out:1080")), []);
});

test("a viewer nothing has been heard from is not watching anything", () => {
  // The backstop for a viewer who never said they were leaving: a browser whose
  // tab is gone releases nothing, and their own silence is what expires.
  const picture = outputOf({ id: "pic", outputKey: "out:1080" });
  const live = new LiveOutputs({ sessionsById: new Map([["pic", picture]]) });
  const viewers = new Viewers();
  const priority = new PriorityOrchestrator({
    publish: () => {},
    viewersOf: (session) => viewersOf(session),
    allowanceFor: () => 10,
    watchedBy: (session, viewer) => live.watchedBy(session, viewer)
  });
  const person = viewers.of(picture, "p");
  person.moveTo(300);

  priority.publishFor({
    sessionGroups: [[picture]],
    staleAfterMs: STALE_AFTER_MS,
    now: person.lastSeenAt + STALE_AFTER_MS + 1
  });

  assert.deepEqual(runsOf(priority.mapForOutput("out:1080")), []);
});

test("a file and an output that are gone are forgotten", () => {
  // These are the projection of the live sessions, never a memory of them. Left
  // to accumulate they were three maps that only grew, and `forget` was written
  // for that and called from nowhere.
  const picture = outputOf({ id: "pic", outputKey: "out:1080" });
  const { priority, viewers, publish } = over([picture]);
  viewers.of(picture, "p").moveTo(300);

  publish();
  assert.ok(runsOf(priority.mapForOutput("out:1080")).length > 0);

  priority.publishFor({ sessionGroups: [[]], staleAfterMs: STALE_AFTER_MS });
  assert.deepEqual(runsOf(priority.mapForOutput("out:1080")), [], "the output is gone");
  assert.deepEqual(
    runsOf(priority.mapFor(FILM.sourceKey, FILM.fileIndex)),
    [],
    "and so is the file"
  );
});

test("the picture is watched by a person who never moved off it", () => {
  const picture = outputOf({ id: "pic", outputKey: "out:1080" });
  const { viewers, live } = over([picture]);
  const person = viewers.of(picture, "p");

  assert.equal(live.watchedBy(picture, person), true, "no step is active");
  person.activeVariantId = "pic";
  assert.equal(
    live.watchedBy(picture, person),
    true,
    "and naming the picture itself as the step is the same statement"
  );
});
