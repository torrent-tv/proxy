/**
 * @file Every viewer this proxy has met, one object per person.
 *
 * A viewer used to be made per SESSION: the same person watching a picture, a
 * quality step and a soundtrack was three objects, each with its own copy of
 * what that person had chosen and where they were. Two of those copies were
 * always wrong, and the field that says which outputs a person is watching was
 * worse than wrong — being per session, each copy could only ever hold the id
 * of the session that owned it, so it carried no information at all and the one
 * place that read it could learn nothing from it.
 *
 * One person is one object here, keyed by the consumer id the browser sends.
 * That id is minted once per film opened in the page, so one id is one person
 * watching one film, and sharing the object cannot conflate two films.
 *
 * The relation "this person watches this output" is indexed both ways — the
 * output holds its viewers, the viewer holds its outputs — because it is asked
 * from both ends, and both indexes are written here and nowhere else.
 *
 * **Every change here announces itself.** What encoders should exist is decided
 * from what viewers want, so a viewer arriving, moving or leaving is a change
 * to that decision's input. Until 2026-09-05 the decision was instead re-taken
 * on a five-second timer, which meant a newly created output waited up to five
 * seconds for anybody to notice it had a viewer at all — and the timer's period
 * was also the period of a restart loop that ran for sixteen minutes. The
 * registry does not know what to do about a change; it only says that one
 * happened.
 */

import { Viewer, viewersOf } from "./Viewer.js";

export class Viewers {
  /**
   * One object per named viewer. An unnamed one is not in here: a viewer that
   * cannot say who it is is not the same viewer as another that cannot, so it
   * belongs to the session that met it and to no one else.
   *
   * @type {Map<string, Viewer>}
   */
  #byId = new Map();

  /** @type {() => void} */
  #onChange;

  /**
   * @param {object} [params]
   * @param {() => void} [params.onChange] - Called after the relation changes:
   *   a viewer joined an output, or left one. Says only that something moved.
   */
  constructor({ onChange } = {}) {
    this.#onChange = typeof onChange === "function" ? onChange : () => {};
  }

  /**
   * This viewer, watching this output.
   *
   * Both directions of the relation are written here. Asking for a viewer of an
   * output IS the statement that they are watching it: every caller either
   * records where they are, what they chose, or what is being prepared for
   * them, and each of those is only true of somebody watching. It is also
   * evidence that they are still there, so it refreshes presence.
   *
   * @param {object} output - A session.
   * @param {string} consumerId
   * @param {number} [now]
   * @returns {Viewer}
   */
  of(output, consumerId, now = Date.now()) {
    const viewers = viewersOf(output);
    const known = viewers.get(consumerId);
    if (known) {
      known.seen(now);
      // Asking again is not a return from the dead, but it IS evidence, and a
      // viewer marked gone whose id turns up again is a viewer who came back.
      known.gone = false;
      const wasWatching = known.outputs.has(output.id);
      known.outputs.add(output.id);
      if (!wasWatching) {
        this.#onChange();
      }
      return known;
    }
    const viewer = consumerId
      ? this.#byId.get(consumerId) ?? new Viewer(consumerId, now)
      : new Viewer("", now);
    viewer.seen(now);
    viewer.gone = false;
    if (consumerId) {
      this.#byId.set(consumerId, viewer);
    }
    viewers.set(consumerId, viewer);
    viewer.outputs.add(output.id);
    this.#onChange();
    return viewer;
  }

  /**
   * The viewer with this id, or null when nobody by that name is watching
   * anything. Never makes one.
   *
   * @param {string} consumerId
   * @returns {Viewer | null}
   */
  get(consumerId) {
    return this.#byId.get(consumerId) ?? null;
  }

  /**
   * The outputs this viewer is watching, as ids, copied so that leaving them
   * can be walked without mutating what is being walked.
   *
   * @param {object} anyOutput - A session they are known to, for an unnamed
   *   viewer whose record lives on that session alone.
   * @param {string} consumerId
   * @returns {string[]}
   */
  watching(anyOutput, consumerId) {
    const viewer = consumerId
      ? this.#byId.get(consumerId)
      : viewersOf(anyOutput).get("");
    return viewer ? [...viewer.outputs] : [];
  }

  /**
   * This viewer is no longer watching this output.
   *
   * Both directions again, and the viewer itself is forgotten once it is
   * watching nothing — otherwise the registry would be a map that only grows,
   * which is the shape of half the memory faults recorded in this repository.
   *
   * @param {object} output - A session.
   * @param {string} consumerId
   * @returns {boolean} Whether they were watching it.
   */
  leaves(output, consumerId) {
    const viewers = viewersOf(output);
    const viewer = viewers.get(consumerId);
    if (!viewer) {
      return false;
    }
    viewers.delete(consumerId);
    viewer.outputs.delete(output.id);
    if (viewer.outputs.size === 0) {
      // Watching nothing at all: this is a statement that they are gone, and
      // not merely that this one output is no longer theirs.
      viewer.gone = true;
      if (consumerId) {
        this.#byId.delete(consumerId);
      }
    }
    this.#onChange();
    return true;
  }

  /**
   * Everything this viewer is watching, let go of at once, because their
   * connection said they are gone.
   *
   * The transport knows a viewer has left before any output does, and it knows
   * it about the PERSON rather than about one of the three outputs the browser
   * happens to hold an id for. This is the door that fact comes through.
   *
   * @param {string} consumerId
   * @param {(outputId: string) => object | null} outputById - How to find an
   *   output by id. The registry holds ids, not sessions.
   * @returns {string[]} The outputs they were watching.
   */
  hasGone(consumerId, outputById) {
    const viewer = consumerId ? this.#byId.get(consumerId) : null;
    if (!viewer) {
      return [];
    }
    const left = [...viewer.outputs];
    for (const outputId of left) {
      const output = typeof outputById === "function" ? outputById(outputId) : null;
      if (output) {
        viewersOf(output).delete(consumerId);
      }
    }
    viewer.outputs.clear();
    viewer.gone = true;
    this.#byId.delete(consumerId);
    this.#onChange();
    return left;
  }

  /**
   * Note that this viewer has been heard from, wherever the evidence came from
   * — a request, a link report, an echo of a delivery probe.
   *
   * @param {string} consumerId
   * @param {number} [now]
   * @returns {boolean} Whether anybody by that name is known.
   */
  seen(consumerId, now = Date.now()) {
    const viewer = consumerId ? this.#byId.get(consumerId) : null;
    if (!viewer) {
      return false;
    }
    viewer.seen(now);
    return true;
  }

  /**
   * How many named viewers are watching anything. For the log line and for a
   * check that the registry does not grow.
   *
   * @returns {number}
   */
  get size() {
    return this.#byId.size;
  }
}
