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

  /**
   * This viewer, watching this output.
   *
   * Both directions of the relation are written here. Asking for a viewer of an
   * output IS the statement that they are watching it: every caller either
   * records where they are, what they chose, or what is being prepared for
   * them, and each of those is only true of somebody watching.
   *
   * @param {object} output - A session.
   * @param {string} consumerId
   * @returns {Viewer}
   */
  of(output, consumerId) {
    const viewers = viewersOf(output);
    const known = viewers.get(consumerId);
    if (known) {
      known.outputs.add(output.id);
      return known;
    }
    const viewer = consumerId
      ? this.#byId.get(consumerId) ?? new Viewer(consumerId)
      : new Viewer("");
    if (consumerId) {
      this.#byId.set(consumerId, viewer);
    }
    viewers.set(consumerId, viewer);
    viewer.outputs.add(output.id);
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
    if (consumerId && viewer.outputs.size === 0) {
      this.#byId.delete(consumerId);
    }
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
