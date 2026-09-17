/**
 * How an output ends.
 *
 * Disposed when nobody is left on it and it has stood idle past its time, or all
 * at once when the proxy stops; its encoders stopped, its viewers told, its
 * statement of accuracy said. At startup the segments an earlier process left
 * behind are adopted where their address still names what they hold.
 */

import { logger } from "../../utils/logger.js";
import { resolveSegmentFormat, SEGMENT_FORMAT_IDS } from "../segment-formats/index.js";
import { isOutputName, OutputSpec } from "../output/index.js";
import { viewersOf } from "../viewer/Viewer.js";
import { viewerSegmentsOn } from "../viewer/positions.js";
import { variantConsumerId, isFamilyConsumerId } from "../encode/Renditions.js";
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
  /** What this reads and asks of the rest of the proxy, and nothing else. @type {object} */
  #host;

  /**
   * @param {object} host - `budgetTimer`, `cleanupTimer`, `encodeRuns`, `keyframeTables`, `machineBudget`, `outputTimes`, `outputs`, `returns`, `segmentStore`, `sessionTtlMs`, `sourceFiles`, `timelines`, `viewers`
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
    for (const [consumerId] of [...viewersOf(session)]) {
      this.viewerLeaves(session, consumerId);
    }
    for (const other of this.#host.outputs.familyOf(session)) {
      for (const viewer of viewersOf(other).values()) {
        viewer.outputs.delete(session.id);
        if (viewer.activeVariantId === session.id) {
          viewer.activeVariantId = null;
        }
      }
    }

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
    this.#host.segmentStore.enforce({
      idleMs: SEGMENT_STORE_IDLE_MS,
      maxBytes: this.#host.machineBudget.segmentBytes(),
      viewersAt: (key) =>
        viewerSegmentsOn({
          outputs: this.#host.outputs.values(),
          outputKey: key,
          segmentAt: (session, seconds) => this.#host.outputTimes.segmentIndexForTime(session, seconds),
          now: Date.now(),
        })
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
    return this.#host.segmentStore.adoptWhatSurvived((key) => {
      // Which container the segments are in is stated by the key itself, so a
      // directory can be read back without any record kept elsewhere. A key in
      // a shape this version does not write — one naming the box a viewer
      // asked for rather than the format produced — cannot say what format is
      // inside, and the directory goes.
      const stated = OutputSpec.fromKey(key)?.segmentFormatId ?? "";
      return SEGMENT_FORMAT_IDS.includes(stated) ? resolveSegmentFormat(stated) : null;
    });
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
    const internalClaim = isFamilyConsumerId(consumerId);
    if (internalClaim) {
      session.claims?.delete(consumerId);
    }
    // And everything that was true of them alone, in EVERY output of this film
    // they were watching — not only in the one the browser addresses. A viewer
    // watches a picture, a quality step and a soundtrack; the browser knows one
    // id of the three, so subtracting them here from that one left them counted
    // as watching the other two. This is the half of the relation the viewer
    // holds, and it exists for exactly this question.
    if (!internalClaim) {
      for (const outputId of this.#host.viewers.watching(session, consumerId)) {
        const output = this.#host.outputs.get(outputId);
        if (output) {
          this.viewerLeaves(output, consumerId);
        }
      }
      this.viewerLeaves(session, consumerId);
    }
    this.#host.outputs.touch(session);
    const remaining = viewersOf(session).size + (session.claims?.size ?? 0);
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
    await this.disposeSession(sessionId);
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
    // a soundtrack; having no listeners is.
    const familyConsumer = variantConsumerId(session.id);
    for (const output of family) {
      if (
        !this.#host.outputs.has(output.id) ||
        viewersOf(output).size > 0 ||
        !(output.claims instanceof Set) ||
        !output.claims.has(familyConsumer)
      ) {
        continue;
      }
      await this.releaseSessionConsumer(
        output.id,
        familyConsumer,
        "nobody is watching it and the picture it was made for has ended"
      );
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
      return 0;
    }
    // Copied before anything is released: releasing walks the same set.
    const outputs = [...watched];
    for (const outputId of outputs) {
      await this.releaseSessionConsumer(outputId, consumerId, because);
    }
    return outputs.length;
  }

  /**
   * This viewer is no longer watching this output.
   *
   * Both directions of the relation go together — the output forgets the
   * viewer, the viewer forgets the output — and so does the claim their
   * watching had placed on production. That last part is why this is a method
   * and not a line: the ONLY place a claim is released is the plan's pass over
   * `viewersOf(session)` (`#planEncoding`), so a viewer deleted from that map
   * by any other route leaves a claim nothing can ever release, and the plan
   * goes on making segments for somebody who has gone.
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
