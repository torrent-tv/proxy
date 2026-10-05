/**
 * How an output ends.
 *
 * Disposed when nobody is left on it and it has stood idle past its time, or all
 * at once when the proxy stops; its encoders stopped, its viewers told, its
 * statement of accuracy said. At startup the segments an earlier process left
 * behind are adopted where their address still names what they hold.
 */

import { logger } from "../../utils/logger.js";
import { isOutputName, PLAYLIST_FILE_NAME } from "../encode/output/index.js";
import { IDLE_KEEP_MS } from "../storage/keep.js";
/**
 * How long produced segments are kept after the last request for them.
 *
 * Long on purpose, and deliberately not the session TTL: an output outlives
 * every session on it, and the reason to keep it is that somebody may ask
 * again — the viewer who closed the tab, or one who has not arrived yet and
 * will find the film already encoded. Reclaiming space is the allowance below,
 * not this; this only stops something nobody has touched all day from sitting
 * there for the life of the process.
 */
const SEGMENT_STORE_IDLE_MS = IDLE_KEEP_MS;
/**
 * Wait for a child process to exit, with a hard timeout fallback.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {number} [timeoutMs=2000]
 * @returns {Promise<void>}
 */
function waitForChildExit(child, timeoutMs = 2_000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };
    child.once("exit", finish);
    setTimeout(finish, timeoutMs);
  });
}
/**
 * Whether a child process has genuinely exited. `ChildProcess.killed` only
 * means `.kill()` was called — the process can stay alive well after that
 * (blocked in I/O, ignoring/delaying the signal). `exitCode`/`signalCode` are
 * only set once the `exit` event has actually fired, so this is the reliable
 * check before treating a directory/file as free for a new process to use.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @returns {boolean}
 */
function hasChildExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

export class OutputLifecycle {
  /** Whether a room check is already queued for this turn. */
  #roomCheckQueued = false;

  /** What this reads and asks of the rest of the proxy, and nothing else. @type {object} */
  #host;

  /**
   * @param {object} host - `invalidateWaits`, `segmentFormatOfKey`, `viewerSegmentsOn`, `budgetTimer`, `cleanupTimer`, `encodeRuns`, `keyframeTables`, `machineBudget`, `outputTimes`, `outputs`, `returns`, `segmentStore`, `sessionTtlMs`, `sourceFiles`, `timelines`, `viewers`
   */
  constructor(host) {
    this.#host = host;
  }

  /**
   * Kill the ffmpeg process, remove it from all maps, and delete the temp dir.
   *
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  async disposeSession(sessionId) {
    const session = this.#host.outputs.get(sessionId);
    if (!session) {
      return;
    }
    this.#host.invalidateWaits(session);
    this.#host.outputs.delete(sessionId);
    this.#host.outputTimes.logIndexAccuracy(session);

    // The chain that used to close here is gone. A picture session releasing a
    // consumer it held on every quality step and every soundtrack was a film
    // object in disguise: one part of a film deciding when another part dies,
    // which is exactly what the criterion refuses — the parts are born at
    // different times, die at different times and are addressed separately.
    //
    // What replaces it is the two sets. A step or a soundtrack nobody is
    // watching has no viewers, so the plan stops its encoders on the next pass
    // — that rule is `EncodePlan`'s and needs no list here — and what it made
    // stays servable until the disk budget says otherwise, which is what a
    // viewer coming back a minute later depends on.
    // A step that has gone must stop being answered with. Nothing has to reach
    // back into another session's map to arrange that: what the file records is
    // a HEIGHT, and the lookup finds no live session producing it, so the next
    // request builds one. What does have to be forgotten is what a VIEWER was
    // watching, because their next request would resolve a session that no
    // longer exists.
    for (const [consumerId] of [...this.#host.viewers.forOutput(session)]) {
      this.viewerLeaves(session, consumerId);
    }
    this.#host.viewers.outputGone(session.id);

    // Whether the process is still RUNNING, not whether anyone has called kill
    // on it: `.killed` means only that a signal was sent, and a run that ended
    // by itself — the file watched through, or a failure — was never killed at
    // all. Asked the old way, every idle session on disposal signalled a dead
    // pid and claimed to be stopping a run that had already ended.
    for (const run of this.#host.encodeRuns.liveRunsOf(session)) {
      const disposingProcess = run.process;
      if (!disposingProcess || hasChildExited(disposingProcess)) {
        continue;
      }
      // A run ends with the session, and it records that itself: left where it
      // was, its state would go on claiming a process that can be signalled and
      // an input that is being read, about a session that no longer exists.
      // `stop` also continues it first, since a suspended process does not act
      // on SIGTERM until it is let go.
      run.stop("the session was disposed");
      await waitForChildExit(disposingProcess);
    }
    this.#host.encodeRuns.forgetEncodingOfGone(session);
    // The segments are NOT removed here, and that is the point of the address
    // change. They belong to the output, not to this session: another viewer
    // may be playing them right now, the viewer who just left may come back,
    // and a viewer who never had a session on this proxy may open the same film
    // a minute from now and find the work already done. A session ending says
    // nothing about any of that.
    //
    // What decides instead is when the material was last READ, and how much
    // room there is — `segmentStore.enforce`, run by the same timer that
    // expires sessions.
  }

  /**
   * Dispose all sessions that have been idle longer than `sessionTtlMs`.
   * Called automatically on the cleanup interval.
   *
   * @returns {Promise<void>}
   */
  async cleanupExpired() {
    const idsToDispose = this.#host.outputs.expiredBefore(Date.now() - this.#host.sessionTtlMs);
    for (const sessionId of idsToDispose) {
      // ASSIGNMENTS ONLY, NOT PRESENCE. An output nobody has read for the whole
      // idle period goes even when a paused viewer is still registered on it —
      // whether a pause should hold it longer is roadmap item 75's question, and
      // asking `stillNeeded` here would answer it by accident. What must not
      // happen is taking the output away while a response is still being sent
      // from it, or while a request made against it may still be repeated.
      const output = this.#host.outputs.get(sessionId);
      if (output && this.#host.viewers.assignmentsHold(output)) {
        logger.info(`transcode ${sessionId} idle past its time, kept: assignments still hold it`);
        continue;
      }
      await this.disposeSession(sessionId);
    }
    // A timeline nobody is reading any more. It is small — two arrays of a few
    // thousand numbers — but nothing removed it, and a proxy that has served a
    // hundred films would have held a hundred of them for the life of the
    // process. An unbounded map that only ever grows is the shape of half the
    // memory faults recorded in this repository.
    const timelinesInUse = new Set();
    for (const session of this.#host.outputs.values()) {
      if (session.timeline) {
        timelinesInUse.add(session.timeline);
      }
    }
    this.#host.timelines.forgetUnused(timelinesInUse);
    const filesInUse = new Set();
    const keyframesInUse = new Set();
    for (const session of this.#host.outputs.values()) {
      if (session.file) {
        filesInUse.add(session.file);
      }
      if (session.spec?.audio) {
        filesInUse.add(this.#host.sourceFiles.get(session.file.sourceKey, session.spec.audioFileIndex));
      }
      if (session.keyframes) {
        keyframesInUse.add(session.keyframes);
      }
    }
    this.#host.sourceFiles.forgetUnused(filesInUse);
    this.#host.keyframeTables.forgetUnused(keyframesInUse);
    // The segments outlive every session on them, so what they cost is decided
    // here rather than by anybody's departure: how long ago each output was
    // last read, and how much room the disk has for the lot.
    // The room is the disk owner's to divide; this asks what the share is now.
    await this.#host.machineBudget.revise();
    // What viewers actually do, beside the period that stands in for it. Said
    // where it can be read against the disk figures rather than on its own.
    const returns = this.#host.returns.describe(IDLE_KEEP_MS);
    if (returns !== null) {
      logger.info(returns);
    }
    this.keepWithinRoom();
  }

  /**
   * Keep the produced segments within the share of the disk they are given,
   * removing what the viewers want least, and drop what nobody has read for
   * the keeping period.
   *
   * Asked when a segment is published — that is the moment the store grows —
   * and on the cleanup pass, which is what notices time passing. Asked only on
   * the timer, the store could run past its share by half a minute of encoding.
   *
   * @returns {void}
   */
  keepWithinRoom() {
    this.#host.segmentStore.enforce({
      idleMs: SEGMENT_STORE_IDLE_MS,
      maxBytes: this.#host.machineBudget.segmentBytes(),
      viewersAt: (key) => this.#host.viewerSegmentsOn(key)
    });
  }

  /**
   * {@link keepWithinRoom} once for a burst of publications: several outputs
   * closing a segment in the same turn ask once.
   *
   * @returns {void}
   */
  keepWithinRoomSoon() {
    if (this.#roomCheckQueued) {
      return;
    }
    this.#roomCheckQueued = true;
    setImmediate(() => {
      this.#roomCheckQueued = false;
      this.keepWithinRoom();
    });
  }

  /**
   * Stop the cleanup timer, dispose all active sessions, and attempt to
   * remove the shared temp root directory if it is empty.
   * Called by Fastify's `onClose` hook during graceful shutdown.
   *
   * @returns {Promise<void>}
   */
  async disposeAll() {
    clearInterval(this.#host.cleanupTimer);
    clearInterval(this.#host.budgetTimer);
    const activeIds = Array.from(this.#host.outputs.keys());
    for (const sessionId of activeIds) {
      await this.disposeSession(sessionId);
    }
    // Everything this process owns, root included. See SegmentStore.dropAll.
    this.#host.segmentStore.dropAll("the proxy is shutting down");
  }

  /**
   * Take back what a previous life of this process left on the disk.
   *
   * Called once at startup, and it is the only record there is of an encoder
   * that ended without anything recording why: when the kernel kills this
   * process no exit handler runs, nothing is cleared up, and — measured on the
   * addon host 2026-09-04 — the files survive, because `/tmp` there is on the
   * overlay filesystem rather than in memory.
   *
   * What survived is kept rather than thrown away. A copied segment's bytes
   * depend only on the source, so it is as good as it was; re-encoding it would
   * cost the machine that is already the scarce thing.
   *
   * @returns {{ adopted: number, dropped: number, unprovenRemoved: number }}
   */
  adoptSegmentsLeftBehind() {
    // Which container the segments are in is stated by the key itself; a key
    // that cannot say is a directory that goes (`encode/output-key-format.js`).
    // The `hls` muxer writes its own list, under the playlist's name, beside the
    // pieces it named itself; none of those pieces is proven whole.
    return this.#host.segmentStore.adoptWhatSurvived(
      (key) => this.#host.segmentFormatOfKey(key),
      { selfNamedListFileName: PLAYLIST_FILE_NAME }
    );
  }

  /**
   * Remove a consumer from a session. Disposes the session when the last
   * consumer leaves.
   *
   * @param {string} sessionId
   * @param {string} [consumerId=""]
   * @param {string} [reason=""]     - Human-readable reason shown in logs.
   * @returns {Promise<boolean>} `false` if the session was not found.
   */
  async releaseSessionConsumer(sessionId, consumerId = "", reason = "") {
    if (!isOutputName(sessionId) || typeof consumerId !== "string" || consumerId.length === 0) {
      return false;
    }
    const session = this.#host.outputs.get(sessionId);
    if (!session) {
      return false;
    }
    // And everything that was true of them alone, in EVERY output of this film
    // they were watching — not only in the one the browser addresses. A viewer
    // watches a picture, a quality step and a soundtrack; the browser knows one
    // id of the three, so subtracting them here from that one left them counted
    // as watching the other two. This is the half of the relation the viewer
    // holds, and it exists for exactly this question.
    for (const outputId of this.#host.viewers.watching(consumerId)) {
      const output = this.#host.outputs.get(outputId);
      if (output) {
        this.viewerLeaves(output, consumerId);
      }
    }
    this.viewerLeaves(session, consumerId);
    this.#host.outputs.touch(session);
    const remaining = this.#host.viewers.forOutput(session).size;
    const logReason = typeof reason === "string" && reason.length > 0 ? reason : "unspecified";
    logger.info(
      `consumer released (${logReason}) session=${session.id} consumer=${consumerId} ` +
        `remaining=${remaining}`
    );
    if (remaining > 0) {
      return true;
    }
    // Read before the picture goes, because a family is found through the file
    // the sessions share and a disposed session is no longer among them.
    const family = this.#host.outputs.familyOf(session).filter((other) => other !== session);
    // Nobody is watching it, but that is only half of whether it is needed: a
    // response already begun is still being sent from it, and another viewer's
    // request made against it moments ago may still be repeated. The same
    // question every other disposal asks, asked here too — this was the one
    // ordinary release that did not. Kept, it goes by the idle expiry once the
    // assignments lapse; its steps and soundtracks are still asked below, each
    // on its own, because this picture being held says nothing about them.
    if (this.#host.viewers.stillNeeded(session)) {
      logger.info(
        `transcode ${session.id} kept after its last viewer left: assignments still hold it ` +
        `(it goes by the idle expiry once they lapse)`
      );
    } else {
      await this.disposeSession(sessionId);
    }
    // The quality steps and the soundtracks this picture had made. Nobody
    // outside this class knows their ids — the browser holds one id for the
    // whole film — so nothing else can ever let go of them, and each holds a
    // consumer, a claim on the torrent, a directory and, until the plan's next
    // pass, a live encoder. Left alone they would sit until the idle timer
    // noticed, half an hour later.
    //
    // The rule is the viewers and not the picture: an output with somebody
    // still watching stays, whoever made it. That is what makes this different
    // from the chain of links it replaced — a picture ending is not what kills
    // a soundtrack; having no listeners is. Whether anybody is left is asked of
    // the viewer registry alone: the family's own made-up claim on what it made
    // was a second answer to that question and is gone. What an output
    // produced stays in the segment store under its key, so disposing it here
    // loses no made segment.
    for (const output of family) {
      if (!this.#host.outputs.has(output.id) || this.#host.viewers.stillNeeded(output)) {
        continue;
      }
      logger.info(
        `transcode ${output.id} disposed: nobody is watching it and the picture it belongs to has ended`
      );
      await this.disposeSession(output.id);
    }
    return true;
  }

  /**
   * This person has gone, and their connection is what said so.
   *
   * Departure is a fact about the PERSON, not about one of the three outputs
   * the browser happens to hold an id for, and their connection knows it before
   * any output does. Until 2026-09-05 nothing carried it: the only exits were
   * the browser's own `release`, which a killed tab never sends, and a silence
   * long enough to be called an absence, which a paused viewer produces without
   * having gone anywhere.
   *
   * Every output they were watching is told, and one with nobody left is
   * disposed by the same path a normal release takes.
   *
   * @param {string} consumerId
   * @param {string} [because]
   * @returns {Promise<number>} How many outputs they were let go of.
   */
  async viewerHasGone(consumerId, because = "their connection closed") {
    if (typeof consumerId !== "string" || consumerId.length === 0) {
      return 0;
    }
    const watched = this.#host.viewers.get(consumerId)?.outputs;
    if (!watched || watched.size === 0) {
      this.#host.viewers.hasGone(consumerId);
      return 0;
    }
    // Copied before anything is released: releasing walks the same set.
    const outputs = [...watched];
    for (const outputId of outputs) {
      await this.releaseSessionConsumer(outputId, consumerId, because);
    }
    this.#host.viewers.hasGone(consumerId);
    return outputs.length;
  }

  /**
   * This viewer is no longer watching this output.
   *
   * The relation is removed from `Viewer.outputs`, its only stored form. The
   * next plan derives who still watches the output from that set, so production
   * no longer contains a claim for this viewer.
   *
   * @param {HlsSession} output
   * @param {string} consumerId
   * @returns {boolean} Whether they had been watching it.
   */
  viewerLeaves(output, consumerId) {
    if (!output) {
      return false;
    }
    // Nothing to release in the encoding: it holds one map per output, built
    // from where the viewers are, and the map that arrives next simply does not
    // have this one in it. A name to release was the last place a viewer
    // appeared inside the encoding at all.
    return this.#host.viewers.leaves(output, consumerId);
  }
}
