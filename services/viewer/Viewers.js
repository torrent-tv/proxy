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
 * The relation "this person watches this output" is stored once, as output ids
 * on the viewer. Queries in the opposite direction scan the small viewer
 * registry instead of maintaining a second value that can disagree.
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

import { Viewer } from "./Viewer.js";

export class Viewers {
  /**
   * One object per viewer, by name. Every viewer has one: a request that names
   * nobody makes no viewer (see `of`).
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

  /** Register presence before source metadata or an output exists. */
  present(consumerId, now = Date.now()) {
    if (typeof consumerId !== "string" || !consumerId) throw new TypeError("A viewer needs a name.");
    const known = this.#byId.get(consumerId);
    const viewer = known ?? new Viewer(consumerId, now);
    viewer.seen(now);
    viewer.gone = false;
    this.#byId.set(consumerId, viewer);
    if (!known) this.#onChange();
    return viewer;
  }

  /** Bind the same viewer to their source before metadata preparation. */
  selectsSource(consumerId, sourceKey, now = Date.now()) {
    if (typeof sourceKey !== "string" || !sourceKey) throw new TypeError("A selected source needs a key.");
    const viewer = this.present(consumerId, now);
    if (viewer.source?.sourceKey !== sourceKey) {
      viewer.source = { sourceKey, visibleFileIndices: [], selectedFileIndex: null };
      viewer.subtitle = null;
      this.#onChange();
    }
    return viewer;
  }

  selectsFile(consumerId, sourceKey, fileIndex, now = Date.now(), selection = {}) {
    if (!Number.isSafeInteger(fileIndex) || fileIndex < 0) throw new TypeError("A selected file needs its source index.");
    const viewer = this.selectsSource(consumerId, sourceKey, now);
    const changed = viewer.source.selectedFileIndex !== fileIndex;
    if (changed) {
      viewer.source.selectedFileIndex = fileIndex;
      viewer.source.generation = 0;
      viewer.subtitle = null;
    }
    if (changed || Number.isFinite(selection.positionSeconds)) viewer.moveTo(selection.positionSeconds ?? 0, now);
    if (typeof selection.wantsToPlay === "boolean") {
      viewer.playing = false;
      viewer.waiting = selection.wantsToPlay;
      viewer.pausedAt = selection.wantsToPlay ? null : viewer.pausedAt ?? now;
    }
    if (changed || Object.keys(selection).length) this.#onChange();
    return viewer;
  }

  visibleFiles(consumerId, sourceKey, indices, now = Date.now()) {
    if (!Array.isArray(indices) || indices.some(index => !Number.isSafeInteger(index) || index < 0)) {
      throw new TypeError("Visible files need source indices.");
    }
    const viewer = this.selectsSource(consumerId, sourceKey, now);
    const visible = [...new Set(indices)];
    if (JSON.stringify(viewer.source.visibleFileIndices) !== JSON.stringify(visible)) {
      viewer.source.visibleFileIndices = visible;
      this.#onChange();
    }
    return viewer;
  }

  /** Accept a source report only while its original selection is still present. */
  reportSource(consumerId, sourceKey, fileIndex, report, now = Date.now()) {
    const viewer = this.get(consumerId);
    if (!viewer || viewer.gone || viewer.outputs.size !== 0 ||
        viewer.source?.sourceKey !== sourceKey || viewer.source.selectedFileIndex !== fileIndex) return false;
    if (report.generation !== undefined) {
      if (!Number.isSafeInteger(report.generation) || report.generation < (viewer.source.generation ?? 0)) return false;
      viewer.source.generation = report.generation;
    }
    if (report.seek === true && Number.isFinite(report.positionSeconds) && report.positionSeconds >= 0) {
      viewer.moveTo(report.positionSeconds, now);
    }
    viewer.report(report, now);
    this.#onChange();
    return true;
  }

  /**
   * This viewer, watching this output.
   *
   * Asking for a viewer of an output IS the statement that they are watching
   * it: every caller either
   * records where they are, what they chose, or what is being prepared for
   * them, and each of those is only true of somebody watching. It is also
   * evidence that they are still there, so it refreshes presence.
   *
   * A VIEWER HAS A NAME, always. A request that names nobody states nothing
   * about anybody and makes no viewer: a viewer without a name used to belong
   * to whichever output met it, so the same person was a different object on
   * each output, and two nameless people on one output were one object.
   *
   * @param {object} output
   * @param {string} consumerId - Required, non-empty.
   * @param {number} [now]
   * @returns {Viewer}
   */
  of(output, consumerId, now = Date.now()) {
    if (typeof consumerId !== "string" || consumerId.length === 0) {
      throw new TypeError(`a viewer of ${output?.id ?? "an output"} needs a name`);
    }
    const known = this.getForOutput(output, consumerId);
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
    const viewer = this.#byId.get(consumerId) ?? new Viewer(consumerId, now);
    viewer.seen(now);
    viewer.gone = false;
    this.#byId.set(consumerId, viewer);
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

  sourceKeys() {
    return new Set([...this.#byId.values()].filter(viewer => viewer.isPresent() && viewer.source)
      .map(viewer => viewer.source.sourceKey));
  }

  forSource(sourceKey) {
    return [...this.#byId.values()].filter(viewer => viewer.isPresent() && viewer.source?.sourceKey === sourceKey);
  }

  /**
   * A viewer of one output, without creating one.
   *
   * @param {object} output
   * @param {string} consumerId
   * @returns {Viewer | null}
   */
  getForOutput(output, consumerId) {
    if (!output || !consumerId) return null;
    const viewer = this.#byId.get(consumerId);
    return viewer?.outputs.has(output.id) ? viewer : null;
  }

  /**
   * A derived view of who watches one output. The stored relation exists only
   * in `Viewer.outputs`.
   *
   * @param {object} output
   * @returns {Map<string, Viewer>}
   */
  forOutput(output) {
    const found = new Map();
    for (const [consumerId, viewer] of this.#byId) {
      if (viewer.outputs.has(output.id)) found.set(consumerId, viewer);
    }
    return found;
  }

  /**
   * Whether anything still stands on this output.
   *
   * TWO REASONS, AND THE SECOND IS WHY THIS EXISTS. Somebody watching it is the
   * obvious one. The other is an assignment: a response already begun is still
   * being sent from this output, or a request made moments ago may still be
   * repeated and must be answered by whatever answered it the first time. Both
   * outlive the instant a viewer stops being registered on the output, and a
   * disposal that asked only the first would take the output away while its
   * bytes were going out.
   *
   * Asked BEFORE an output is let go, which is the whole point: the standing
   * assignments were otherwise discovered afterwards, as a request for a
   * segment of something that no longer exists.
   *
   * @param {object} output
   * @param {number} [now]
   * @returns {boolean}
   */
  stillNeeded(output, now = Date.now()) {
    if (!output) {
      return false;
    }
    return this.forOutput(output).size > 0 || this.assignmentsHold(output, now);
  }

  /**
   * Whether an assignment of anybody's holds this output: a response still
   * being sent from it, or a request that may still be repeated and must be
   * answered by it.
   *
   * The assignment part of {@link stillNeeded}, also checked after the last
   * viewer leaves. A live response or a repeatable request keeps the output
   * available until that assignment ends.
   *
   * @param {object} output
   * @param {number} [now]
   * @returns {boolean}
   */
  assignmentsHold(output, now = Date.now()) {
    const key = output?.outputKey ?? "";
    if (!key) {
      return false;
    }
    for (const viewer of this.#byId.values()) {
      if (viewer.assignments.heldKeys(now).has(key)) {
        return true;
      }
    }
    return false;
  }

  /** Active responses protect stored files while their bytes are being read. */
  responsesHold(outputKey) {
    return [...this.#byId.values()].some(viewer => viewer.assignments.responseHolds(outputKey));
  }

  /**
   * Every output a present viewer is being prepared onto, as ids: a step being
   * warmed for them, and an output of another limit of the height on their
   * screen.
   *
   * Read by the machine-wide admission as the places preparations hold. A
   * projection of the viewers' own records and nothing kept beside them, so a
   * place ends with the record that holds it, on whichever path that record is
   * cleared.
   *
   * @returns {Set<string>}
   */
  outputsBeingPrepared() {
    const ids = new Set();
    for (const viewer of this.#byId.values()) {
      if (!viewer.isPresent()) {
        continue;
      }
      if (viewer.warmingVariantId) {
        ids.add(viewer.warmingVariantId);
      }
      if (viewer.sameHeightSwitch?.outputId) {
        ids.add(viewer.sameHeightSwitch.outputId);
      }
    }
    return ids;
  }

  /**
   * The outputs this viewer is watching, as ids, copied so that leaving them
   * can be walked without mutating what is being walked.
   *
   * @param {string} consumerId
   * @returns {string[]}
   */
  watching(consumerId) {
    const viewer = consumerId ? this.#byId.get(consumerId) : null;
    return viewer ? [...viewer.outputs] : [];
  }

  /**
   * This viewer is no longer watching this output.
   *
   * The viewer itself is forgotten once it is watching nothing — otherwise the
   * registry would be a map that only grows.
   *
   * @param {object} output
   * @param {string} consumerId
   * @returns {boolean} Whether they were watching it.
   */
  leaves(output, consumerId) {
    const viewer = this.getForOutput(output, consumerId);
    if (!viewer) {
      return false;
    }
    viewer.outputs.delete(output.id);
    if (viewer.outputs.size === 0 && !viewer.source) {
      // Watching nothing at all: this is a statement that they are gone, and
      // not merely that this one output is no longer theirs.
      viewer.markGone();
      this.#byId.delete(consumerId);
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
   * @returns {string[]} The outputs they were watching.
   */
  hasGone(consumerId) {
    const viewer = consumerId ? this.#byId.get(consumerId) : null;
    if (!viewer) {
      return [];
    }
    const left = [...viewer.outputs];
    viewer.outputs.clear();
    viewer.markGone();
    this.#byId.delete(consumerId);
    this.#onChange();
    return left;
  }

  /**
   * Remove a disposed output from every viewer.
   *
   * @param {string} outputId
   */
  outputGone(outputId) {
    for (const [consumerId, viewer] of this.#byId) {
      if (!viewer.outputs.delete(outputId)) continue;
      if (viewer.activeVariantId === outputId) viewer.activeVariantId = null;
      if (viewer.outputs.size === 0 && !viewer.source) {
        viewer.markGone();
        this.#byId.delete(consumerId);
      }
    }
    this.#onChange();
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
   * This viewer has subtitles switched on for this file.
   *
   * Said by the request that turns them on, which is the only place that knows
   * both the person and the file. Registering it here rather than against a
   * channel is what makes it survive a reconnect and a deliberate rotation of
   * the association.
   *
   * @param {string} consumerId
   * @param {string} sourceKey
   * @param {number} fileIndex
   * @returns {boolean} Whether anybody by that name is known to want them.
   */
  wantsCues(consumerId, sourceKey, fileIndex) {
    const viewer = consumerId ? this.#byId.get(consumerId) : null;
    if (!viewer || !sourceKey || !Number.isInteger(fileIndex)) {
      return false;
    }
    viewer.wantsCuesFor.add(`${sourceKey}:${fileIndex}`);
    return true;
  }

  /** Record the chosen subtitle without creating or restoring a viewer. */
  selectsSubtitle(consumerId, sourceKey, fileIndex, trackIndex = null) {
    const viewer = this.get(consumerId);
    if (!viewer || viewer.gone || viewer.source?.sourceKey !== sourceKey ||
      !Number.isSafeInteger(fileIndex) || fileIndex < 0 ||
      (trackIndex !== null && (!Number.isSafeInteger(trackIndex) || trackIndex < 0))) return false;
    if (trackIndex !== null && viewer.source.selectedFileIndex !== fileIndex) return false;
    const selection = { sourceKey, fileIndex, trackIndex };
    if (JSON.stringify(viewer.subtitle) !== JSON.stringify(selection)) {
      viewer.subtitle = selection;
      this.#onChange();
    }
    return true;
  }

  clearsSubtitle(consumerId, sourceKey) {
    const viewer = this.get(consumerId);
    if (!viewer || viewer.gone || viewer.source?.sourceKey !== sourceKey) return false;
    if (viewer.subtitle !== null) {
      viewer.subtitle = null;
      this.#onChange();
    }
    return true;
  }

  /**
   * Who has subtitles switched on for this file.
   *
   * The answer is a list of NAMES. Whoever delivers to them resolves a name to
   * whatever channel that person is reachable on right now, which is the whole
   * point: the recipients outlive the connection.
   *
   * @param {string} sourceKey
   * @param {number} fileIndex
   * @returns {string[]}
   */
  wantingCues(sourceKey, fileIndex) {
    const key = `${sourceKey}:${fileIndex}`;
    const names = [];
    for (const [consumerId, viewer] of this.#byId) {
      if (viewer.wantsCuesFor.has(key)) {
        names.push(consumerId);
      }
    }
    return names;
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
