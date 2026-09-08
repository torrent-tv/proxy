/**
 * @file The priority map, built once and handed to everybody who acts on it.
 *
 * One map per film, in seconds of film against a number. It is built from where
 * the viewers are and nothing else, and both of the things that do work — the
 * encoding and the downloading — read it and decide for themselves. They do not
 * talk to each other, and neither of them tells this class anything.
 *
 * **Why it has to be published rather than asked for.** The downloading lives
 * in another thread. Until now it took its orders from the reads themselves:
 * every read declared a window around its own head, so fifteen reads declared
 * fifteen windows on a piece store that holds sixteen pieces. Half of all
 * evictions then took a piece a reader had said it wanted, two thirds of reads
 * came back from disk, and what `/stream` handed out stopped being the file's
 * bytes — twenty-two source-parse errors, a segment the player could not
 * append, and an empty picture for six minutes (field 2026-09-05).
 */

import { emptyMap, mapForViewer, mergeMaps, runsOf } from "./PriorityMap.js";

export class PriorityOrchestrator {
  /** Where the map goes once it is built. @type {(published: object) => void} */
  #publish;

  /** The last map published per film and file, so an unchanged one is not resent. */
  #last = new Map();

  /** The last map BUILT per film and file, for whoever reads instead of being
   * handed it. @type {Map<string, import("./PriorityMap.js").PriorityMap>} */
  #maps = new Map();

  /**
   * The last map built per OUTPUT, from the viewers of that output alone.
   *
   * The same fact answered at two scopes, because the two things that act on it
   * ask at two scopes and both are right. The swarm is asked for bytes of a
   * FILE, and the picture, a quality step and a soundtrack of one film read the
   * same bytes — so every viewer of any of them wants that file's bytes.
   * Encoders are placed per OUTPUT, and a person watching 480p wants nothing of
   * the 1080p output at all.
   *
   * One map for both was the second authority over encoders. Every output of a
   * film was handed the whole film's map, so the plan wanted an encoder on every
   * one of them; what actually stopped the ones nobody was watching was the
   * session manager killing them by its own judgement — and since a viewer
   * moving between steps also announces itself, the plan started them again on
   * the next pass. Two parties answering "should this encoder exist" by different
   * rules, several times a second.
   *
   * @type {Map<string, import("./PriorityMap.js").PriorityMap>}
   */
  #byOutput = new Map();

  /** Who is watching one session. @type {(session: object) => Map<string, object>} */
  #viewersOf;

  /** How wide the first band of one session's file is. @type {(session: object) => number} */
  #allowanceFor;

  /** Whether this output is what that person is consuming, as opposed to one
   * they merely hold a record on. @type {(session: object, viewer: object) => boolean} */
  #watchedBy;

  /**
   * This layer states facts and imports nothing above itself, so what it needs
   * of a session — who is watching it, and how wide an interruption this file
   * has shown on this swarm — is passed in.
   *
   * @param {object} params
   * @param {(published: { sourceKey: string, fileIndex: number, durationSeconds: number,
   *   zones: { from: number, to: number, priority: number }[] }) => void} params.publish
   * @param {(session: object) => Map<string, object>} [params.viewersOf]
   * @param {(session: object) => number} [params.allowanceFor]
   * @param {(session: object, viewer: object) => boolean} [params.watchedBy] -
   *   Whether this output is the one that person is consuming. Which of a film's
   *   outputs a person has on screen is a fact about the film's shape, which
   *   this layer does not know; absent, every registered viewer counts, and then
   *   the per-output map says the same as the per-file one.
   */
  constructor({ publish, viewersOf, allowanceFor, watchedBy }) {
    this.#publish = typeof publish === "function" ? publish : () => {};
    this.#viewersOf = typeof viewersOf === "function" ? viewersOf : () => new Map();
    this.#allowanceFor = typeof allowanceFor === "function" ? allowanceFor : () => 0;
    this.#watchedBy = typeof watchedBy === "function" ? watchedBy : () => true;
  }

  /**
   * A map from a set of viewers, and the ONE statement of how one is built.
   *
   * Asked at both scopes — once per film for the swarm, once per output for the
   * encoders — and written once, because two copies of how a viewer's map is
   * built is the same two-owners fault this class was split for.
   *
   * @param {object} params
   * @param {number} params.durationSeconds
   * @param {number} params.allowanceSeconds
   * @param {{ atSeconds: number, playing: boolean }[]} params.viewers
   * @returns {import("./PriorityMap.js").PriorityMap} A map of no length where
   *   nobody is watching or the film's length is unknown, which says the same as
   *   a map with nothing in it.
   */
  #mapFrom({ durationSeconds, allowanceSeconds, viewers }) {
    if (!(durationSeconds > 0) || !(viewers?.length > 0)) {
      return emptyMap(0);
    }
    return mergeMaps(
      viewers.map((viewer) =>
        mapForViewer({
          atSeconds: viewer.atSeconds,
          durationSeconds,
          allowanceSeconds,
          playing: viewer.playing !== false
        })
      )
    );
  }

  /**
   * The map for one film, from everyone watching it.
   *
   * @param {object} params
   * @param {string} params.sourceKey
   * @param {number} params.fileIndex
   * @param {number} params.durationSeconds
   * @param {number} params.allowanceSeconds - The measured depth below which an
   *   interruption reaches a viewer of this file.
   * @param {{ atSeconds: number, playing: boolean }[]} params.viewers
   * @returns {import("./PriorityMap.js").PriorityMap} One number per second of
   *   film, merged over everyone watching it.
   */
  build({ sourceKey, fileIndex, durationSeconds, allowanceSeconds, viewers }) {
    const map = this.#mapFrom({ durationSeconds, allowanceSeconds, viewers });
    const key = `${sourceKey}:${fileIndex}`;
    this.#maps.set(key, map);
    // Unchanged maps are not republished: the downloading rebuilds what it asks
    // the swarm for on every one, and a viewer sitting still would otherwise
    // make it do that several times a second. Compared as stretches rather than
    // second by second, which is the same comparison over far fewer values.
    const zones = runsOf(map);
    const shape = JSON.stringify(zones);
    if (this.#last.get(key) !== shape) {
      this.#last.set(key, shape);
      this.#publish({ sourceKey, fileIndex, durationSeconds, zones });
    }
    return map;
  }

  /**
   * Build and publish the map for every file anybody is watching.
   *
   * One map per FILE, not per output: the picture, a quality step and a
   * soundtrack of one film are three outputs reading the same bytes, and the
   * swarm is asked for bytes. Viewers of all of them merge into one map.
   *
   * @param {object} params
   * @param {Iterable<object[]>} params.sessionGroups - The live sessions, in
   *   whatever grouping the caller holds them; they are regrouped by file here.
   * @param {number} params.staleAfterMs - How long a viewer may be silent and
   *   still count as watching.
   * @param {number} [params.now]
   * @returns {void}
   */
  publishFor({ sessionGroups, staleAfterMs, now = Date.now() }) {
    /** @type {Map<string, { sourceKey: string, fileIndex: number, durationSeconds: number, allowanceSeconds: number, viewers: object[] }>} */
    const byFile = new Map();
    /** @type {Map<string, { durationSeconds: number, allowanceSeconds: number, viewers: object[] }>} */
    const byOutput = new Map();
    for (const sessions of sessionGroups) {
      for (const session of sessions) {
        const key = `${session.sourceKey}:${session.fileIndex}`;
        const durationSeconds = Number(session.file?.durationSeconds) || 0;
        // The first band is as wide as an interruption this file has actually
        // shown on this swarm, never a chosen number.
        const allowanceSeconds = this.#allowanceFor(session);
        let held = byFile.get(key);
        if (!held) {
          held = {
            sourceKey: session.sourceKey,
            fileIndex: session.fileIndex,
            durationSeconds,
            allowanceSeconds,
            viewers: []
          };
          byFile.set(key, held);
        }
        // Every output anybody holds a session for, whether or not a viewer is
        // consuming it — an output with nobody on it must get a map with
        // nothing in it, which is how the plan is told to stop its encoders.
        // Left out, it would keep the map it had when somebody was watching.
        const address = session.outputKey ?? "";
        let mine = byOutput.get(address);
        if (!mine) {
          mine = { durationSeconds, allowanceSeconds, viewers: [] };
          byOutput.set(address, mine);
        }
        for (const viewer of this.#viewersOf(session).values()) {
          if (!viewer.isPresent(now, staleAfterMs)) {
            continue;
          }
          const stated = {
            atSeconds: viewer.positionSeconds() ?? 0,
            playing: viewer.playing !== false
          };
          held.viewers.push(stated);
          if (this.#watchedBy(session, viewer)) {
            mine.viewers.push(stated);
          }
        }
      }
    }
    // WHAT THIS PASS SAW IS ALL THERE IS. Everything below is derived from the
    // live sessions, so a file or an output that is not among them is gone —
    // and these maps are the projection of that, never a memory of it. Left to
    // accumulate they were three maps that only grew, which is the shape of half
    // the memory faults recorded in this repository, and `forget` was written
    // for it and called from nowhere.
    for (const key of [...this.#maps.keys()]) {
      if (!byFile.has(key)) {
        this.#maps.delete(key);
        this.#last.delete(key);
      }
    }
    for (const address of [...this.#byOutput.keys()]) {
      if (!byOutput.has(address)) {
        this.#byOutput.delete(address);
      }
    }
    for (const one of byFile.values()) {
      // A file of unknown length cannot be divided into zones, and a file
      // nobody is watching has nothing to be urgent about.
      if (one.durationSeconds > 0 && one.viewers.length > 0) {
        this.build(one);
      }
    }
    for (const [address, one] of byOutput) {
      this.#byOutput.set(address, this.#mapFrom(one));
    }
  }

  /**
   * Nobody is watching this file any more.
   *
   * @param {string} sourceKey
   * @param {number} fileIndex
   */
  /**
   * The map this class last built for one file.
   *
   * Read by whoever acts on it and cannot be handed it at the moment it is
   * made — the encoding decides per output, and one file has several. It is the
   * SAME map: built once here, from where the viewers are, and neither read
   * changes it.
   *
   * @param {string} sourceKey
   * @param {number} fileIndex
   * @returns {import("./PriorityMap.js").PriorityMap} A map of no length where
   *   none was built, which says the same as a map with nothing in it.
   */
  mapFor(sourceKey, fileIndex) {
    return this.#maps.get(`${sourceKey}:${fileIndex}`) ?? emptyMap(0);
  }

  /**
   * The map for ONE output, from the viewers consuming that output.
   *
   * What the encoding reads. A map of no length says nobody is on this output,
   * which is what makes an encoder on it unwanted — and it is a statement, not
   * an absence: the walk above writes one for every output a session exists
   * for, including the ones everybody has left.
   *
   * @param {string} address
   * @returns {import("./PriorityMap.js").PriorityMap}
   */
  mapForOutput(address) {
    return this.#byOutput.get(address) ?? emptyMap(0);
  }

}
