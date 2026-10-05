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

import { emptyMap, mapForViewer, mergeMaps, runsOf, pauseCoefficient } from "./PriorityMap.js";

export class PriorityOrchestrator {
  /** Where the map goes once it is built. @type {(published: object) => void} */
  #publish;

  /**
   * The last map published per film and file, so an unchanged one is not
   * resent — and what it was about, so that a file everybody has left can be
   * published as wanting nothing.
   *
   * @type {Map<string, { shape: string, sourceKey: string, fileIndex: number, durationSeconds: number }>}
   */
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

  /** The registry of this component that knows who watches each output. @type {{ forOutput: (output: object) => Map<string, object> }} */
  #viewers;

  /** How wide the first band of one session's file is. @type {(session: object) => number} */
  #allowanceFor;

  /** Whether this output is what that person is consuming, as opposed to one
   * they merely hold a record on. @type {(session: object, viewer: object) => boolean} */
  #watchedBy;
  #urgentReadyFor;

  /**
   * Who watches an output is this component's own registry, handed in as the
   * registry. What it needs from elsewhere — how wide an interruption this file
   * has shown on this swarm, and which output a person has on screen — is
   * passed in as functions.
   *
   * @param {object} params
   * @param {(published: { sourceKey: string, fileIndex: number, durationSeconds: number,
   *   zones: { from: number, to: number, priority: number }[] }) => void} params.publish
   * @param {{ forOutput: (output: object) => Map<string, object> }} params.viewers - Required:
   *   without it every output would read as unwatched and every encoder would stop.
   * @param {(session: object) => number} [params.allowanceFor]
   * @param {(session: object, viewer: object) => boolean} [params.watchedBy] -
   *   Whether this output is the one that person is consuming. Which of a film's
   *   outputs a person has on screen is a fact about the film's shape, which
   *   this layer does not know; absent, every registered viewer counts, and then
   *   the per-output map says the same as the per-file one.
   */
  constructor({ publish, viewers, allowanceFor, watchedBy, urgentReadyFor }) {
    if (typeof viewers?.forOutput !== "function") {
      throw new TypeError("PriorityOrchestrator needs the viewer registry");
    }
    this.#publish = typeof publish === "function" ? publish : () => {};
    this.#viewers = viewers;
    this.#allowanceFor = typeof allowanceFor === "function" ? allowanceFor : () => 0;
    this.#watchedBy = typeof watchedBy === "function" ? watchedBy : () => true;
    this.#urgentReadyFor = typeof urgentReadyFor === "function" ? urgentReadyFor : () => false;
  }

  /** Apply the viewer's same pause attenuation to related source preparation. */
  priorityFor(session, viewer, priority, viewerCount, now = Date.now()) {
    const allowanceSeconds = this.#allowanceFor(session);
    const coefficient = pauseCoefficient({ playing: viewer.playing || viewer.waiting, viewerCount,
      pauseSeconds: viewer.pausedAt === null ? 0 : (now - viewer.pausedAt) / 1000, allowanceSeconds,
      urgentReady: viewer.pausedAt !== null && this.#urgentReadyFor(session, viewer, allowanceSeconds, now) });
    return Math.max(1, 1 + Math.floor((priority - 1) * coefficient));
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
  #mapFrom({ durationSeconds, allowanceSeconds, viewers, viewerCount }) {
    if (!(durationSeconds > 0) || !(viewers?.length > 0)) {
      return emptyMap(0);
    }
    const count = viewerCount ?? new Set(viewers.map((one, index) => one.id ?? index)).size;
    return mergeMaps(
      viewers.map((viewer) =>
        mapForViewer({
          atSeconds: viewer.atSeconds,
          durationSeconds,
          allowanceSeconds,
          playing: viewer.playing !== false,
          pauseSeconds: viewer.pauseSeconds ?? 0,
          urgentReady: viewer.urgentReady === true,
          viewerCount: count
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
  build({ sourceKey, fileIndex, durationSeconds, allowanceSeconds, viewers, demandKey = null }) {
    const map = this.#mapFrom({ durationSeconds, allowanceSeconds, viewers });
    const key = `${sourceKey}:${fileIndex}`;
    this.#maps.set(key, map);
    // Unchanged maps are not republished: the downloading rebuilds what it asks
    // the swarm for on every one, and a viewer sitting still would otherwise
    // make it do that several times a second. Compared as stretches rather than
    // second by second, which is the same comparison over far fewer values.
    const zones = runsOf(map);
    const shape = JSON.stringify({ zones, demandKey });
    if (this.#last.get(key)?.shape !== shape) {
      // The length is remembered with the shape, so that a file whose viewers
      // have all gone can still be spoken for: what is published then is the
      // same statement with nothing in it, and it has to name the file it is
      // about.
      this.#last.set(key, { shape, sourceKey, fileIndex, durationSeconds });
      this.#publish({ sourceKey, fileIndex, durationSeconds, zones });
    }
    return map;
  }

  /**
   * NOBODY WANTS ANYTHING OF THIS FILE ANY MORE — said, rather than left to be
   * inferred from silence.
   *
   * The map used to be deleted from this class's memory and published nowhere,
   * so what had been stated about that file on the swarm's behalf stood until
   * the torrent itself was removed. Read from the register, a film nobody had
   * watched for an hour was indistinguishable from one being watched now.
   *
   * @param {{ sourceKey: string, fileIndex: number, durationSeconds: number }} what
   * @returns {void}
   */
  #publishNothingFor({ sourceKey, fileIndex, durationSeconds }) {
    this.#publish({ sourceKey, fileIndex, durationSeconds, zones: [] });
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
   * @param {number} [params.now]
   * @returns {void}
   */
  publishFor({ sessionGroups, now = Date.now() }) {
    /** @type {Map<string, { sourceKey: string, fileIndex: number, durationSeconds: number, allowanceSeconds: number, viewers: object[] }>} */
    const byFile = new Map();
    /** @type {Map<string, { durationSeconds: number, allowanceSeconds: number, viewers: object[] }>} */
    const byOutput = new Map();
    for (const sessions of sessionGroups) {
      for (const session of sessions) {
        const sourceKey = session.file?.sourceKey;
        const fileIndex = session.file?.fileIndex;
        if (typeof sourceKey !== "string" || !sourceKey || !Number.isSafeInteger(fileIndex) || fileIndex < 0) {
          throw new TypeError("A priority map requires its output file's source and file index.");
        }
        const key = `${sourceKey}:${fileIndex}`;
        const durationSeconds = Number(session.file?.durationSeconds) || 0;
        // The first band is as wide as an interruption this file has actually
        // shown on this swarm, never a chosen number.
        const allowanceSeconds = this.#allowanceFor(session);
        let held = byFile.get(key);
        if (!held) {
          held = {
            sourceKey,
            fileIndex,
            durationSeconds,
            allowanceSeconds,
            viewers: [],
            demandKey: []
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
          mine = { durationSeconds, allowanceSeconds, viewers: [], fileKey: key };
          byOutput.set(address, mine);
        }
        for (const viewer of this.#viewers.forOutput(session).values()) {
          if (!viewer.isPresent()) {
            continue;
          }
          held.demandKey.push([session.outputKey, viewer.id, viewer.audio?.trackIndex,
            viewer.audio?.transcode, viewer.activeVariantId, viewer.warmingVariantId,
            viewer.warmingAudioId, this.#watchedBy(session, viewer)]);
          const stated = {
            id: viewer.id,
            atSeconds: viewer.positionSeconds(now) ?? 0,
            pauseSeconds: viewer.pausedAt == null ? 0 : Math.max(0, (now - viewer.pausedAt) / 1000),
            urgentReady: viewer.pausedAt != null && this.#urgentReadyFor(session, viewer, allowanceSeconds, now),
            // WATCHING OR WAITING, not merely playing. Three states reach this
            // one question: a viewer whose picture is advancing, a viewer
            // blocked on material we owe them, and a viewer who stopped it
            // themselves. The first two want the film in front of them NOW and
            // share the upper band; only the third can wait. A page that is not
            // on screen has its timers throttled and asks for nothing, which is
            // indistinguishable from a full cushion, so it is not consuming
            // either — told apart on the page, folded into one question here.
            playing: viewer.pausedAt == null && (typeof viewer.wantsFilmNow === "function"
              ? viewer.wantsFilmNow()
              : viewer.playing === true || viewer.waiting === true)
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
        const last = this.#last.get(key);
        this.#maps.delete(key);
        this.#last.delete(key);
        if (last) {
          this.#publishNothingFor(last);
        }
      }
    }
    for (const address of [...this.#byOutput.keys()]) {
      if (!byOutput.has(address)) {
        this.#byOutput.delete(address);
      }
    }
    for (const one of byFile.values()) {
      // A file of unknown length cannot be divided into zones at all. A file
      // whose viewers have all gone CAN be spoken for, and must be: `build`
      // with nobody watching produces a map with nothing in it, which is the
      // truth and is what withdraws what was stated for them. Skipped, as it
      // was, the last thing said about that file stood for as long as the
      // torrent did.
      if (one.durationSeconds > 0) {
        this.build(one);
      }
    }
    for (const [address, one] of byOutput) {
      // Competition is per file, even when two viewers use different outputs.
      one.viewerCount = new Set((byFile.get(one.fileKey)?.viewers ?? []).map((viewer, index) => viewer.id ?? index)).size;
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
