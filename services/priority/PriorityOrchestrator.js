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

import { mapForViewer, mergeMaps } from "./PriorityMap.js";

export class PriorityOrchestrator {
  /** Where the map goes once it is built. @type {(published: object) => void} */
  #publish;

  /** The last map published per film and file, so an unchanged one is not resent. */
  #last = new Map();

  /** Who is watching one session. @type {(session: object) => Map<string, object>} */
  #viewersOf;

  /** How wide the first band of one session's file is. @type {(session: object) => number} */
  #allowanceFor;

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
   */
  constructor({ publish, viewersOf, allowanceFor }) {
    this.#publish = typeof publish === "function" ? publish : () => {};
    this.#viewersOf = typeof viewersOf === "function" ? viewersOf : () => new Map();
    this.#allowanceFor = typeof allowanceFor === "function" ? allowanceFor : () => 0;
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
   * @returns {{ from: number, to: number, priority: number }[]} Seconds of film
   *   against a number, merged over everyone.
   */
  build({ sourceKey, fileIndex, durationSeconds, allowanceSeconds, viewers }) {
    const zones = mergeMaps(
      (viewers ?? []).map((viewer) =>
        mapForViewer({
          atSeconds: viewer.atSeconds,
          durationSeconds,
          allowanceSeconds,
          playing: viewer.playing !== false
        })
      )
    );
    const key = `${sourceKey}:${fileIndex}`;
    // Unchanged maps are not republished: the downloading rebuilds what it asks
    // the swarm for on every one, and a viewer sitting still would otherwise
    // make it do that several times a second.
    const shape = JSON.stringify(zones);
    if (this.#last.get(key) !== shape) {
      this.#last.set(key, shape);
      this.#publish({ sourceKey, fileIndex, durationSeconds, zones });
    }
    return zones;
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
    for (const sessions of sessionGroups) {
      for (const session of sessions) {
        const key = `${session.sourceKey}:${session.fileIndex}`;
        let held = byFile.get(key);
        if (!held) {
          held = {
            sourceKey: session.sourceKey,
            fileIndex: session.fileIndex,
            durationSeconds: Number(session.file?.durationSeconds) || 0,
            // The first band is as wide as an interruption this file has
            // actually shown on this swarm, never a chosen number.
            allowanceSeconds: this.#allowanceFor(session),
            viewers: []
          };
          byFile.set(key, held);
        }
        for (const viewer of this.#viewersOf(session).values()) {
          if (viewer.isPresent(now, staleAfterMs)) {
            held.viewers.push({
              atSeconds: viewer.positionSeconds() ?? 0,
              playing: viewer.playing !== false
            });
          }
        }
      }
    }
    for (const one of byFile.values()) {
      // A file of unknown length cannot be divided into zones, and a file
      // nobody is watching has nothing to be urgent about.
      if (one.durationSeconds > 0 && one.viewers.length > 0) {
        this.build(one);
      }
    }
  }

  /**
   * Nobody is watching this file any more.
   *
   * @param {string} sourceKey
   * @param {number} fileIndex
   */
  forget(sourceKey, fileIndex) {
    this.#last.delete(`${sourceKey}:${fileIndex}`);
  }
}
