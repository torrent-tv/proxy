/**
 * @file The encoder-run table, exercised as a graph.
 *
 * These are properties of the specification, not of any run: no ffmpeg, no
 * torrent, no filesystem, no clock. What they buy is the thing five field
 * failures in a row were — an empty cell — being visible before a release
 * rather than after one.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ABSENT_EDGE_INVARIANTS,
  ENCODE_RUN_EVENT,
  ENCODE_RUN_STATE,
  ENCODE_RUN_SUPERSTATE,
  INITIAL_RUN_STATE,
  answerForMissingSegment,
  declaredContainment,
  declaredEdges,
  isInputBeingRead,
  isWithin,
  mayRestart,
  nextState,
  processCanBeSignalled,
  wireState
} from "../services/encode/encode-run-state.js";

const ALL_STATES = Object.values(ENCODE_RUN_STATE);
const ALL_EVENTS = Object.values(ENCODE_RUN_EVENT);

// ------------------------------------------------------------ graph discipline

test("the relation is deterministic", () => {
  for (const state of ALL_STATES) {
    for (const event of ALL_EVENTS) {
      assert.equal(nextState(state, event), nextState(state, event));
    }
  }
});

test("every pair is answered, and nothing throws", () => {
  for (const state of ALL_STATES) {
    for (const event of ALL_EVENTS) {
      const target = nextState(state, event);
      assert.ok(
        target === null || ALL_STATES.includes(target),
        `${state} + ${event} answered ${String(target)}, which is neither a state nor "ignored"`
      );
    }
  }
  // Nonsense in, "ignored" out — never an exception. The machine this pattern
  // replaces threw from inside an event handler, which left the caller's work
  // half applied.
  assert.equal(nextState("NOT_A_STATE", ENCODE_RUN_EVENT.SPAWNED), null);
  assert.equal(nextState(ENCODE_RUN_STATE.IDLE, "NOT_AN_EVENT"), null);
  assert.equal(nextState(undefined, undefined), null);
});

test("one target per state and event — no pair is declared twice", () => {
  const seen = new Set();
  for (const edge of declaredEdges()) {
    const pair = `${edge.from}+${edge.event}`;
    assert.ok(!seen.has(pair), `${pair} is declared more than once`);
    seen.add(pair);
  }
});

test("the table cannot be edited through what it hands out", () => {
  const [first] = declaredEdges();
  const mutated = declaredEdges();
  mutated[0].to = "TAMPERED";
  assert.equal(declaredEdges()[0].to, first.to);
  const containment = declaredContainment();
  containment[0].parent = "TAMPERED";
  assert.notEqual(declaredContainment()[0].parent, "TAMPERED");
});

test("every state is reachable from where a run begins", () => {
  const seen = new Set([INITIAL_RUN_STATE]);
  const queue = [INITIAL_RUN_STATE];
  while (queue.length > 0) {
    const state = queue.shift();
    for (const event of ALL_EVENTS) {
      const target = nextState(state, event);
      if (target && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  assert.deepEqual(
    ALL_STATES.filter((state) => !seen.has(state)),
    [],
    "a state no sequence of events can enter is either dead code or a missing edge"
  );
});

test("no state is a dead end — every one can start a run again", () => {
  for (const state of ALL_STATES) {
    assert.equal(
      nextState(state, ENCODE_RUN_EVENT.SPAWNED),
      ENCODE_RUN_STATE.STARTING,
      `${state} must be able to spawn a run: a session that cannot restart answers 500 for ever, ` +
        "which is what the roadmap calls the empty cell"
    );
  }
});

test("the two edges that lead back to their own state are deliberate", () => {
  const selfEdges = [];
  for (const state of ALL_STATES) {
    for (const event of ALL_EVENTS) {
      if (nextState(state, event) === state) {
        selfEdges.push(`${state} + ${event}`);
      }
    }
  }
  assert.deepEqual(
    selfEdges.sort(),
    [
      // A new run spawned while one was starting: the state is right already,
      // and nothing in the caller re-runs on entry — the spawn has happened.
      `${ENCODE_RUN_STATE.STARTING} + ${ENCODE_RUN_EVENT.SPAWNED}`,
      // Suspending what is suspended. The caller returns early before signalling,
      // so this is the answer to an event that cannot actually be raised twice.
      `${ENCODE_RUN_STATE.SUSPENDED} + ${ENCODE_RUN_EVENT.SUSPEND_ORDERED}`
    ].sort(),
    "an edge that leads back to its own state must be argued for, not acquired"
  );
});

test("the table stays small enough to hold in the head", () => {
  assert.ok(
    declaredEdges().length <= 12,
    `${declaredEdges().length} declared edges — a near-complete digraph asserts nothing`
  );
});

// ------------------------------------------------------- what must not happen

test("the absent edges are absent", () => {
  for (const invariant of ABSENT_EDGE_INVARIANTS) {
    assert.notEqual(
      nextState(invariant.from, invariant.event),
      invariant.mustNotReach,
      `${invariant.from} + ${invariant.event} reached ${invariant.mustNotReach}: ${invariant.because}`
    );
  }
});

test("an event that means nothing here is ignored, not obeyed", () => {
  assert.equal(nextState(ENCODE_RUN_STATE.IDLE, ENCODE_RUN_EVENT.FIRST_SEGMENT), null);
  assert.equal(nextState(ENCODE_RUN_STATE.IDLE, ENCODE_RUN_EVENT.EXITED_COMPLETE), null);
  assert.equal(nextState(ENCODE_RUN_STATE.STOPPED, ENCODE_RUN_EVENT.RESUME_ORDERED), null);
  assert.equal(nextState(ENCODE_RUN_STATE.ENDED_COMPLETE, ENCODE_RUN_EVENT.SUSPEND_ORDERED), null);
  assert.equal(nextState(ENCODE_RUN_STATE.PRODUCING, ENCODE_RUN_EVENT.RETRY_DUE), null);
});

// ------------------------------------------------------------------ hierarchy

test("an edge on a superstate reaches every state inside it", () => {
  const alive = ALL_STATES.filter((state) => isWithin(state, ENCODE_RUN_SUPERSTATE.ALIVE));
  assert.deepEqual(
    alive.sort(),
    [ENCODE_RUN_STATE.PRODUCING, ENCODE_RUN_STATE.STARTING, ENCODE_RUN_STATE.SUSPENDED].sort()
  );
  for (const state of alive) {
    assert.equal(nextState(state, ENCODE_RUN_EVENT.EXITED_FAILED), ENCODE_RUN_STATE.ENDED_FAILED);
    assert.equal(nextState(state, ENCODE_RUN_EVENT.EXITED_INPUT_LOST), ENCODE_RUN_STATE.RETRY_WAIT);
    assert.equal(nextState(state, ENCODE_RUN_EVENT.STOP_ORDERED), ENCODE_RUN_STATE.STOPPED);
  }
  const working = ALL_STATES.filter((state) => isWithin(state, ENCODE_RUN_SUPERSTATE.WORKING));
  assert.deepEqual(working.sort(), [...alive, ENCODE_RUN_STATE.RETRY_WAIT].sort());
  for (const state of ALL_STATES) {
    assert.ok(isWithin(state, ENCODE_RUN_SUPERSTATE.RUN), `${state} must sit inside RUN`);
  }
});

test("a state's own edge wins over the one it inherits", () => {
  // STARTING inherits SPAWNED from RUN and declares FIRST_SEGMENT itself; the
  // walk must stop at the first hit rather than continue up the chain.
  assert.equal(
    nextState(ENCODE_RUN_STATE.STARTING, ENCODE_RUN_EVENT.FIRST_SEGMENT),
    ENCODE_RUN_STATE.PRODUCING
  );
  assert.equal(
    nextState(ENCODE_RUN_STATE.SUSPENDED, ENCODE_RUN_EVENT.RESUME_ORDERED),
    ENCODE_RUN_STATE.PRODUCING
  );
});

// -------------------------------------------------------------------- outputs

test("only a live run reads its input", () => {
  assert.equal(isInputBeingRead(ENCODE_RUN_STATE.STARTING), true);
  assert.equal(isInputBeingRead(ENCODE_RUN_STATE.PRODUCING), true);
  assert.equal(
    isInputBeingRead(ENCODE_RUN_STATE.SUSPENDED),
    false,
    "a suspended encoder reads nothing — the reader's window is then satisfied, WebTorrent drops " +
      "the selection, and the download dies with the swarm open (eleven minutes, 2026-08-05)"
  );
  for (const state of [
    ENCODE_RUN_STATE.IDLE,
    ENCODE_RUN_STATE.RETRY_WAIT,
    ENCODE_RUN_STATE.STOPPED,
    ENCODE_RUN_STATE.ENDED_COMPLETE,
    ENCODE_RUN_STATE.ENDED_FAILED
  ]) {
    assert.equal(isInputBeingRead(state), false, `${state} has no process to read anything`);
  }
});

test("a signal may be sent only where a process exists", () => {
  for (const state of ALL_STATES) {
    assert.equal(
      processCanBeSignalled(state),
      isWithin(state, ENCODE_RUN_SUPERSTATE.ALIVE),
      `${state} answered the wrong thing about whether it holds a process`
    );
  }
});

test("a missing segment is held everywhere except a terminal failure", () => {
  for (const state of ALL_STATES) {
    assert.equal(
      answerForMissingSegment(state),
      state === ENCODE_RUN_STATE.ENDED_FAILED ? "fail" : "hold",
      `${state} must give one answer for a missing segment, not one per call site`
    );
  }
});

test("the wire state is a function of the run state alone", () => {
  assert.equal(wireState(ENCODE_RUN_STATE.IDLE), "starting");
  assert.equal(wireState(ENCODE_RUN_STATE.RETRY_WAIT), "starting");
  assert.equal(wireState(ENCODE_RUN_STATE.STARTING), "running");
  assert.equal(wireState(ENCODE_RUN_STATE.PRODUCING), "running");
  assert.equal(wireState(ENCODE_RUN_STATE.SUSPENDED), "running");
  assert.equal(wireState(ENCODE_RUN_STATE.STOPPED), "running");
  assert.equal(wireState(ENCODE_RUN_STATE.ENDED_COMPLETE), "ready");
  assert.equal(wireState(ENCODE_RUN_STATE.ENDED_FAILED), "failed");
  for (const state of ALL_STATES) {
    assert.ok(
      ["starting", "running", "ready", "failed"].includes(wireState(state)),
      `${state} produced a wire state the browser has never been told about`
    );
  }
});

test("only a finished file refuses to be repositioned", () => {
  for (const state of ALL_STATES) {
    assert.equal(mayRestart(state), state !== ENCODE_RUN_STATE.ENDED_COMPLETE);
  }
});

// ------------------------------------------------- the failures, by their name

test("the sawtooth of 2.9.93 is not expressible", () => {
  // Any segment request released a suspended encoder, and the run drifted from
  // 155 s to 922 s ahead of the viewer in three minutes. Resuming is an output
  // of how far ahead the run is, computed by the caller — never an edge hung on
  // a request arriving.
  assert.equal(nextState(ENCODE_RUN_STATE.SUSPENDED, ENCODE_RUN_EVENT.FIRST_SEGMENT), null);
  assert.equal(
    nextState(ENCODE_RUN_STATE.SUSPENDED, ENCODE_RUN_EVENT.RESUME_ORDERED),
    ENCODE_RUN_STATE.PRODUCING
  );
});

test("a dead run cannot be mistaken for one that is covering the seek", () => {
  // the process handle pointed at a corpse, so every later seek was waved through
  // as "already covered by the running encode" and the session answered 500 for
  // as long as the viewer kept trying.
  assert.equal(processCanBeSignalled(ENCODE_RUN_STATE.ENDED_FAILED), false);
  assert.equal(isInputBeingRead(ENCODE_RUN_STATE.ENDED_FAILED), false);
  assert.equal(
    nextState(ENCODE_RUN_STATE.ENDED_FAILED, ENCODE_RUN_EVENT.SPAWNED),
    ENCODE_RUN_STATE.STARTING,
    "and the way out of it is a spawn — the edge whose absence is the empty cell"
  );
});

test("a rung the viewer left is not the same as a run that has not started", () => {
  // Both are "no process" in the field set this replaces, and they call for
  // opposite answers: one must not be revived by its own held requests, the
  // other is waiting to be spawned.
  assert.notEqual(ENCODE_RUN_STATE.STOPPED, ENCODE_RUN_STATE.IDLE);
  assert.equal(nextState(ENCODE_RUN_STATE.STOPPED, ENCODE_RUN_EVENT.RESUME_ORDERED), null);
  assert.equal(nextState(ENCODE_RUN_STATE.IDLE, ENCODE_RUN_EVENT.SPAWNED), ENCODE_RUN_STATE.STARTING);
});

test("an input that dried up is not a finished file", () => {
  // ffmpeg exits 0 for both, and the difference had to be recovered by
  // comparing what was produced against the published playlist (2.9.104).
  assert.equal(
    nextState(ENCODE_RUN_STATE.PRODUCING, ENCODE_RUN_EVENT.EXITED_SHORT),
    ENCODE_RUN_STATE.ENDED_FAILED
  );
  assert.equal(
    nextState(ENCODE_RUN_STATE.PRODUCING, ENCODE_RUN_EVENT.EXITED_COMPLETE),
    ENCODE_RUN_STATE.ENDED_COMPLETE
  );
});

test("losing the input holds the viewer's requests instead of failing them", () => {
  const afterLoss = nextState(ENCODE_RUN_STATE.PRODUCING, ENCODE_RUN_EVENT.EXITED_INPUT_LOST);
  assert.equal(afterLoss, ENCODE_RUN_STATE.RETRY_WAIT);
  assert.equal(answerForMissingSegment(afterLoss), "hold");
  assert.equal(wireState(afterLoss), "starting");
  assert.equal(nextState(afterLoss, ENCODE_RUN_EVENT.RETRY_DUE), ENCODE_RUN_STATE.IDLE);
});
