/**
 * @file The encoder run as a transition table: states, the relation between
 * them, and the answers derived from a state. Pure — no ffmpeg, no torrent, no
 * filesystem, no clock — so every decision can be exercised by `node --test`.
 *
 * This table is the SPECIFICATION, not a description of code written elsewhere.
 * The session manager executes it, the picture in `docs/encode-run-state.md` is
 * rendered from it, and every transition a real run makes is logged as state,
 * event and target — so a run that takes an edge this table does not declare is
 * a violation the log names, and a state never entered is a gap in coverage.
 *
 * Why a table at all, for this and not for everything: five field failures in a
 * row were not wrong lines but EMPTY CELLS — a pair of state and event nobody
 * had considered. A run at #26 meeting a request for #0; a request behind the
 * head arriving while a seek settles; a suspended encoder's cumulative speed
 * read as a measurement; a session in "failed" answering 500 for ever because
 * no edge leads out of it; an audio track left with its encoder when the viewer
 * moved to another. A table makes an empty cell visible before a release; a
 * conditional buried in 6900 lines does not.
 *
 * The four principles are the project's, and they decide everything below —
 * they are argued at length in `server/public/domain/app-state.js`, whose shape
 * this follows deliberately:
 *
 * 1. **Moore.** An output depends on the state alone, never on the edge taken.
 *    So "is the input being read", "can the process be signalled" and "what
 *    does a missing segment get answered" are functions of the state, computed
 *    by the caller, never commanded alongside a transition.
 * 2. **Extended state.** Something becomes a state only when it changes what is
 *    legal or what is shown. `encoderPauseUnsupported`, the seek-failure
 *    counter, the wait epoch and the rest stay variables with guards.
 * 3. **Hierarchy.** An edge shared by several states is declared once on their
 *    superstate; {@link nextState} walks the containment chain.
 * 4. **Graph discipline.** Deterministic, total (an unlisted pair is IGNORED,
 *    never an exception), every state reachable, no dead ends. The ABSENT edges
 *    carry the meaning — see {@link ABSENT_EDGE_INVARIANTS}.
 *
 * Derivation from the code as it stood at proxy 2.22.0, with line numbers:
 * `research/encode-run-machine-2026-08-16.md`.
 */

/**
 * Control states of ONE encoder run inside one session.
 *
 * The session's own lifetime (live vs disposed) is deliberately not here: it is
 * two states and one edge, and the value is in taking it out of the field this
 * machine replaces, not in tabulating it.
 *
 * @readonly
 */
export const ENCODE_RUN_STATE = Object.freeze({
  /**
   * No process exists and one is expected: before the first run, and between a
   * retry timer firing and the spawn it leads to.
   *
   * Distinct from {@link ENCODE_RUN_STATE.STOPPED}, which looks identical in
   * the old field set (`session.ffmpeg === null`) and calls for the opposite
   * answer — that is the whole reason both exist.
   */
  IDLE: "IDLE",
  /** Spawned; nothing servable produced by THIS run yet. */
  STARTING: "STARTING",
  /** This run has produced at least one servable segment. */
  PRODUCING: "PRODUCING",
  /**
   * `SIGSTOP` delivered, the process alive. The one state where a live run
   * reads nothing: suspending the encoder stops the only thing pulling on the
   * torrent, which is how an eleven-minute download stall came about (2.9.105).
   */
  SUSPENDED: "SUSPENDED",
  /**
   * The input went away and a restart is timed. Not a failure: the data can
   * come back, so requests are held rather than refused (2.9.112).
   */
  RETRY_WAIT: "RETRY_WAIT",
  /**
   * Stopped on purpose with no replacement — a rung the viewer switched away
   * from. Its segments stay servable and a switch back restarts it, but nothing
   * a REQUEST does may revive it, or the host ends up running the encoder the
   * viewer left as well as the one they chose.
   */
  STOPPED: "STOPPED",
  /** Ran through the last segment of the file. Nothing is owed. */
  ENDED_COMPLETE: "ENDED_COMPLETE",
  /** Terminal for this target: requests are answered as failures. */
  ENDED_FAILED: "ENDED_FAILED"
});

/** Where a run begins, so no caller hardcodes it. */
export const INITIAL_RUN_STATE = ENCODE_RUN_STATE.IDLE;

/**
 * One line per state, for the rendered picture.
 *
 * Data rather than a comment because the drawing is GENERATED from this file:
 * a legend kept beside the diagram drifts from the table, and a drawing that
 * disagrees with the code is worse than none.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const STATE_MEANING = Object.freeze({
  [ENCODE_RUN_STATE.IDLE]: "No process, and one is expected — before the first run, or after a retry timer fired.",
  [ENCODE_RUN_STATE.STARTING]: "Spawned; this run has produced nothing servable yet.",
  [ENCODE_RUN_STATE.PRODUCING]: "This run has produced at least one servable segment.",
  [ENCODE_RUN_STATE.SUSPENDED]: "SIGSTOP delivered, process alive — and nothing is reading the input.",
  [ENCODE_RUN_STATE.RETRY_WAIT]: "The input went away; a restart is timed. Requests are held, not refused.",
  [ENCODE_RUN_STATE.STOPPED]: "Stopped on purpose with no replacement — a rung the viewer switched away from.",
  [ENCODE_RUN_STATE.ENDED_COMPLETE]: "Ran through the last segment of the file. Nothing is owed.",
  [ENCODE_RUN_STATE.ENDED_FAILED]: "Terminal for this target: requests are answered as failures."
});

/**
 * Superstates. Containers, not states: they declare a shared edge once and
 * express an output over a group.
 *
 * @readonly
 */
export const ENCODE_RUN_SUPERSTATE = Object.freeze({
  /** A pid exists and can be signalled: STARTING, PRODUCING, SUSPENDED. */
  ALIVE: "ALIVE",
  /** A missing segment is held rather than refused: ALIVE plus RETRY_WAIT. */
  WORKING: "WORKING",
  /** Every state. Exists so a universal edge is written once. */
  RUN: "RUN"
});

/**
 * Freeze an object and everything under it. `Object.freeze` is shallow, and a
 * transition relation that can be edited at runtime is not a specification.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) {
      deepFreeze(inner);
    }
  }
  return value;
}

/**
 * Containment, innermost first — the chain {@link nextState} walks when a state
 * declares no edge of its own for an event.
 *
 * @type {Readonly<Record<string, string | null>>}
 */
const PARENT = Object.freeze({
  [ENCODE_RUN_STATE.STARTING]: ENCODE_RUN_SUPERSTATE.ALIVE,
  [ENCODE_RUN_STATE.PRODUCING]: ENCODE_RUN_SUPERSTATE.ALIVE,
  [ENCODE_RUN_STATE.SUSPENDED]: ENCODE_RUN_SUPERSTATE.ALIVE,
  [ENCODE_RUN_SUPERSTATE.ALIVE]: ENCODE_RUN_SUPERSTATE.WORKING,
  [ENCODE_RUN_STATE.RETRY_WAIT]: ENCODE_RUN_SUPERSTATE.WORKING,
  [ENCODE_RUN_SUPERSTATE.WORKING]: ENCODE_RUN_SUPERSTATE.RUN,
  [ENCODE_RUN_STATE.IDLE]: ENCODE_RUN_SUPERSTATE.RUN,
  [ENCODE_RUN_STATE.STOPPED]: ENCODE_RUN_SUPERSTATE.RUN,
  [ENCODE_RUN_STATE.ENDED_COMPLETE]: ENCODE_RUN_SUPERSTATE.RUN,
  [ENCODE_RUN_STATE.ENDED_FAILED]: ENCODE_RUN_SUPERSTATE.RUN,
  [ENCODE_RUN_SUPERSTATE.RUN]: null
});

/**
 * Events, named for what HAPPENED. An event that names its target cannot be
 * refused without contradicting itself.
 *
 * `EXITED_COMPLETE` and `EXITED_SHORT` are two events for one exit code
 * because ffmpeg exits 0 both at the end of the file and when its input simply
 * stops delivering — a distinction that cost a frozen player and had to be
 * recovered by comparing what was produced against the published playlist
 * (2.9.104). Written down, it can never collapse back into one.
 *
 * @readonly
 */
export const ENCODE_RUN_EVENT = Object.freeze({
  /** A process was spawned for this session. */
  SPAWNED: "SPAWNED",
  /**
   * The first servable segment of THIS run was served.
   *
   * The only event whose raising is guarded by the current state, and
   * deliberately so: "something has been produced" is a level, not an edge, and
   * the guard is a READ of the state rather than a second copy of it. Declared
   * on STARTING alone, so a segment served by a suspended run cannot resume it
   * — which is exactly the sawtooth of 2.9.93.
   */
  FIRST_SEGMENT: "FIRST_SEGMENT",
  /** `SIGSTOP` was delivered. */
  SUSPEND_ORDERED: "SUSPEND_ORDERED",
  /** `SIGCONT` was sent. */
  RESUME_ORDERED: "RESUME_ORDERED",
  /** The run was stopped with no replacement. */
  STOP_ORDERED: "STOP_ORDERED",
  /** Exit 0, having produced through the last segment. */
  EXITED_COMPLETE: "EXITED_COMPLETE",
  /** Exit 0, short of the last segment — the input dried up. */
  EXITED_SHORT: "EXITED_SHORT",
  /** Died because the input was not there. Recoverable. */
  EXITED_INPUT_LOST: "EXITED_INPUT_LOST",
  /** Died for any other reason, or could not be spawned at all. */
  EXITED_FAILED: "EXITED_FAILED",
  /** The input-retry timer fired. */
  RETRY_DUE: "RETRY_DUE"
});

/**
 * One line per event, for the rendered picture. Same reason as
 * {@link STATE_MEANING}.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const EVENT_MEANING = Object.freeze({
  [ENCODE_RUN_EVENT.SPAWNED]: "A process was spawned for this session.",
  [ENCODE_RUN_EVENT.FIRST_SEGMENT]: "The first servable segment of this run was served.",
  [ENCODE_RUN_EVENT.SUSPEND_ORDERED]: "SIGSTOP was delivered.",
  [ENCODE_RUN_EVENT.RESUME_ORDERED]: "SIGCONT was sent.",
  [ENCODE_RUN_EVENT.STOP_ORDERED]: "The run was stopped with no replacement.",
  [ENCODE_RUN_EVENT.EXITED_COMPLETE]: "Exit 0, having produced through the last segment.",
  [ENCODE_RUN_EVENT.EXITED_SHORT]: "Exit 0, short of the last segment — the input dried up.",
  [ENCODE_RUN_EVENT.EXITED_INPUT_LOST]: "Died because the input was not there. Recoverable.",
  [ENCODE_RUN_EVENT.EXITED_FAILED]: "Died for any other reason, or could not be spawned.",
  [ENCODE_RUN_EVENT.RETRY_DUE]: "The input-retry timer fired."
});

/**
 * The transition relation. One target per state and event.
 *
 * `SPAWNED` sits on RUN because a run may be spawned from any state at all: at
 * session creation (IDLE), replacing a live run on a seek (ALIVE), after a
 * retry (IDLE), on a switch back to a rung (STOPPED), and after a failure
 * (ENDED_*). Declared once, it also makes the restart edge impossible to
 * forget on a state added later.
 *
 * @type {Readonly<Record<string, Readonly<Record<string, string>>>>}
 */
const TRANSITIONS = deepFreeze({
  [ENCODE_RUN_SUPERSTATE.RUN]: {
    // A spawn always lands in STARTING, including from STARTING itself: the new
    // run has produced nothing, whatever its predecessor had done.
    [ENCODE_RUN_EVENT.SPAWNED]: ENCODE_RUN_STATE.STARTING
  },

  [ENCODE_RUN_SUPERSTATE.WORKING]: {
    // Stopping reaches a dead run too: the exit handler leaves the handle in
    // place, so `#stopEncodeRun` runs its course in RETRY_WAIT as well.
    [ENCODE_RUN_EVENT.STOP_ORDERED]: ENCODE_RUN_STATE.STOPPED
  },

  [ENCODE_RUN_SUPERSTATE.ALIVE]: {
    [ENCODE_RUN_EVENT.SUSPEND_ORDERED]: ENCODE_RUN_STATE.SUSPENDED,
    [ENCODE_RUN_EVENT.EXITED_COMPLETE]: ENCODE_RUN_STATE.ENDED_COMPLETE,
    // Stopping short is a FAILURE that may be restarted, not a finished file.
    [ENCODE_RUN_EVENT.EXITED_SHORT]: ENCODE_RUN_STATE.ENDED_FAILED,
    [ENCODE_RUN_EVENT.EXITED_INPUT_LOST]: ENCODE_RUN_STATE.RETRY_WAIT,
    [ENCODE_RUN_EVENT.EXITED_FAILED]: ENCODE_RUN_STATE.ENDED_FAILED
  },

  [ENCODE_RUN_STATE.STARTING]: {
    [ENCODE_RUN_EVENT.FIRST_SEGMENT]: ENCODE_RUN_STATE.PRODUCING
  },

  [ENCODE_RUN_STATE.SUSPENDED]: {
    // Resuming lands in PRODUCING even for a run suspended before its first
    // segment (2.9.117 suspended one 136 ms in). No output distinguishes the
    // two: both read the input, both can be signalled, both hold a missing
    // segment and both say "running" on the wire. The distinction that does
    // exist — the warm-up figure — is answered before the first spawn.
    [ENCODE_RUN_EVENT.RESUME_ORDERED]: ENCODE_RUN_STATE.PRODUCING
  },

  [ENCODE_RUN_STATE.RETRY_WAIT]: {
    // The timer fired; nothing is running and nothing is armed. The spawn it
    // leads to may still be abandoned (a newer run won the race), and IDLE is
    // the honest state for that moment.
    [ENCODE_RUN_EVENT.RETRY_DUE]: ENCODE_RUN_STATE.IDLE
  }
});

/**
 * What the MISSING edges assert, as data so the tests execute them rather than
 * a reader trusting prose. Each entry is a shipped defect stated as a rule.
 *
 * @type {ReadonlyArray<{ from: string, event: string, mustNotReach: string, because: string }>}
 */
export const ABSENT_EDGE_INVARIANTS = Object.freeze([
  {
    from: ENCODE_RUN_STATE.SUSPENDED,
    event: ENCODE_RUN_EVENT.FIRST_SEGMENT,
    mustNotReach: ENCODE_RUN_STATE.PRODUCING,
    because:
      "a segment request must not release a suspended encoder — 2.9.93, where any request did, " +
      "and the run sawtoothed from 155 s to 922 s ahead of the viewer in three minutes"
  },
  {
    from: ENCODE_RUN_STATE.ENDED_FAILED,
    event: ENCODE_RUN_EVENT.FIRST_SEGMENT,
    mustNotReach: ENCODE_RUN_STATE.PRODUCING,
    because:
      "a dead run is not a producing one — 2.9.93, where the handle pointed at a corpse and every " +
      "later seek was waved through as already covered, so the session answered 500 for ever"
  },
  {
    from: ENCODE_RUN_STATE.ENDED_FAILED,
    event: ENCODE_RUN_EVENT.RESUME_ORDERED,
    mustNotReach: ENCODE_RUN_STATE.PRODUCING,
    because: "there is no process to continue; only a spawn leads out of a failure"
  },
  {
    from: ENCODE_RUN_STATE.IDLE,
    event: ENCODE_RUN_EVENT.FIRST_SEGMENT,
    mustNotReach: ENCODE_RUN_STATE.PRODUCING,
    because: "nothing produces before a process exists"
  },
  {
    from: ENCODE_RUN_STATE.RETRY_WAIT,
    event: ENCODE_RUN_EVENT.FIRST_SEGMENT,
    mustNotReach: ENCODE_RUN_STATE.PRODUCING,
    because: "a run waiting for its input back has no process; only a spawn resumes production"
  },
  {
    from: ENCODE_RUN_STATE.STOPPED,
    event: ENCODE_RUN_EVENT.RESUME_ORDERED,
    mustNotReach: ENCODE_RUN_STATE.PRODUCING,
    because:
      "a rung the viewer switched away from must not be revived by its own held requests — " +
      "the host has one encoder's worth of capacity and the rung on screen needs it"
  }
]);

/**
 * The state `event` leads to, or `null` when the event means nothing here.
 *
 * Two answers with two meanings, kept apart on purpose:
 *
 *   - `null` — no edge exists for this pair; the event is IGNORED. A caller may
 *     reasonably log it, and in this codebase that log line IS the measurement
 *     of whether this table matches reality.
 *   - the state passed in — an edge exists and leads back here; nothing
 *     changed, and no entry work may re-run.
 *
 * Never throws. The machine this pattern replaces did, from inside an event
 * listener, so a refused transition abandoned the rest of the handler and left
 * the app describing a state it was no longer in.
 *
 * @param {string} state - Current state.
 * @param {string} event - One of {@link ENCODE_RUN_EVENT}.
 * @returns {string | null}
 */
export function nextState(state, event) {
  let scope = state;
  while (scope) {
    const target = TRANSITIONS[scope]?.[event];
    if (target !== undefined) {
      return target;
    }
    scope = PARENT[scope] ?? null;
  }
  return null;
}

/**
 * Whether `state` sits inside `superstate` (or is it).
 *
 * @param {string} state
 * @param {string} superstate - One of {@link ENCODE_RUN_SUPERSTATE}.
 * @returns {boolean}
 */
export function isWithin(state, superstate) {
  let scope = state;
  while (scope) {
    if (scope === superstate) {
      return true;
    }
    scope = PARENT[scope] ?? null;
  }
  return false;
}

/**
 * Is anything reading the input right now?
 *
 * The output the torrent turns on, and the one that had no name anywhere in the
 * codebase until the pool learned it the hard way: suspending the encoder stops
 * the only reader, the reader's window is then satisfied, WebTorrent drops the
 * selection, and the download dies with the swarm wide open — eleven minutes of
 * it, measured 2026-08-05 with 150 peers connected.
 *
 * @param {string} state
 * @returns {boolean}
 */
export function isInputBeingRead(state) {
  return state === ENCODE_RUN_STATE.STARTING || state === ENCODE_RUN_STATE.PRODUCING;
}

/**
 * May a signal be sent to this run's process?
 *
 * Replaces re-deriving the answer from a child-process handle at five sites.
 * The OS remains the authority on whether a pid still exists: a caller must
 * keep its `try`/`catch` and feed a throw back as an exit event, never
 * contradict it. A machine that believes it owns the process's life is wrong
 * the first time ffmpeg is killed from outside.
 *
 * @param {string} state
 * @returns {boolean}
 */
export function processCanBeSignalled(state) {
  return isWithin(state, ENCODE_RUN_SUPERSTATE.ALIVE);
}

/**
 * What a request for a segment that is not on disk gets.
 *
 * `"hold"` and `"fail"` were three answers to one condition across the serving
 * path — hold, 404 and 500 — chosen at each site. They are one answer here.
 *
 * @param {string} state
 * @returns {"hold" | "fail"}
 */
export function answerForMissingSegment(state) {
  return state === ENCODE_RUN_STATE.ENDED_FAILED ? "fail" : "hold";
}

/**
 * The status string the browser is given.
 *
 * A Moore output rather than a second field maintained by hand at seven sites,
 * which is how the two came to be read together with `||`.
 *
 * @param {string} state
 * @returns {"starting" | "running" | "ready" | "failed"}
 */
export function wireState(state) {
  if (state === ENCODE_RUN_STATE.IDLE || state === ENCODE_RUN_STATE.RETRY_WAIT) {
    return "starting";
  }
  if (state === ENCODE_RUN_STATE.ENDED_COMPLETE) {
    return "ready";
  }
  if (state === ENCODE_RUN_STATE.ENDED_FAILED) {
    return "failed";
  }
  // STARTING, PRODUCING, SUSPENDED and STOPPED. The last of these keeps the
  // value its run left behind, which is what a stopped rung reports today; a
  // family's progress is answered from the variant on screen in any case.
  return "running";
}

/**
 * May the encoder be repositioned from this state?
 *
 * False only for a run that reached the end of the file: everything it could
 * produce exists, so a restart would re-make what is already on disk.
 *
 * @param {string} state
 * @returns {boolean}
 */
export function mayRestart(state) {
  return state !== ENCODE_RUN_STATE.ENDED_COMPLETE;
}

/**
 * Every declared edge, flattened, for the tests and for drawing the graph.
 * Superstate edges are reported against the superstate, not expanded.
 *
 * @returns {Array<{ from: string, event: string, to: string }>}
 */
export function declaredEdges() {
  const edges = [];
  for (const [from, byEvent] of Object.entries(TRANSITIONS)) {
    for (const [event, to] of Object.entries(byEvent)) {
      edges.push({ from, event, to });
    }
  }
  return edges;
}

/**
 * The containment chain, for the graph renderer. A copy, so no caller can edit
 * the table by editing what it was handed.
 *
 * @returns {Array<{ state: string, parent: string | null }>}
 */
export function declaredContainment() {
  return Object.entries(PARENT).map(([state, parent]) => ({ state, parent }));
}
