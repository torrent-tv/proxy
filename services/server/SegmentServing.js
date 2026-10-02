/**
 * Answering one request for a file of an output: a playlist, the init segment
 * or a segment.
 *
 * A segment is served from the store when it is made and whole; otherwise the
 * request is held until it is, or until nobody wants it any more, and a hold
 * that lasts says why. A request is an operation on material that exists; where
 * encoders work is the plan's, and a request does not move one.
 */

import { createReadStream } from "node:fs";
import { access, readFile, stat, unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { logger } from "../../utils/logger.js";
import { isOutputName, PLAYLIST_FILE_NAME } from "../encode/output/index.js";
// The index of variants. Served from the same route as the media playlist, so
// it needs no path of its own.
export const MASTER_PLAYLIST_FILE_NAME = "master.m3u8";
// Read segment files in large blocks so the body is delivered to the data
// channel in few, big chunks. On a busy ARM host the in-process WebTorrent
// hashing starves the event loop in bursts, so fewer read iterations means
// far less time lost between chunks while serving the first segments.
const SEGMENT_READ_HIGH_WATER_MARK = 4 * 1024 * 1024;
/**
 * Resolve after a given number of milliseconds.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
/**
 * Guard against path traversal by restricting file names to the known
 * playlist and segment patterns produced by ffmpeg. Which segment names are
 * legal depends on the active container, so the format decides.
 *
 * @param {string} fileName
 * @param {import("../encode/segment-formats/index.js").SegmentFormat} segmentFormat
 * @returns {boolean}
 */
function isSafeFileName(fileName, segmentFormat) {
  return (
    fileName === PLAYLIST_FILE_NAME ||
    fileName === MASTER_PLAYLIST_FILE_NAME ||
    (segmentFormat.initFileName !== null && fileName === segmentFormat.initFileName) ||
    segmentFormat.isSegmentFileName(fileName)
  );
}
/**
 * Whether this output is cut at times we hand the muxer, rather than at a
 * duration it chooses for itself.
 *
 * A property of the output and not of a run: the cut grid and the branch decide
 * it, so every run of one output answers alike. It decides how a segment is
 * judged finished — see getFileStream.
 *
 * @param {object} session
 * @returns {boolean}
 */
function cutsAtGivenTimes(session) {
  const explicit = session?.segmentFormat?.explicitTimesMuxerArgs?.() ?? null;
  if (!explicit) {
    return false;
  }
  return !session.spec.transcodesVideo || session.timeline?.cutGrid === "keyframe";
}

export class SegmentServing {
  /** Serving state keyed by the output object it belongs to. */
  #states = new WeakMap();
  /** What this reads and asks of the rest of the proxy, and nothing else. @type {object} */
  #host;

  /**
   * @param {object} host - `buildMasterPlaylist`, `declaredTracks`, `publishedGridFor`, `runStartTimeFor`, `cushion`, `encodeOrchestrator`, `encodeRuns`, `hostTimings`, `lookaheadSeconds`, `outputTimes`, `outputs`, `segmentStore`, `startupWaitMs`, `viewers`
   */
  constructor(host) {
    this.#host = host;
  }

  #stateFor(output) {
    let state = this.#states.get(output);
    if (!state) {
      state = {
        holdExplainedAt: new Map(),
        waitEpoch: 0,
        waitListeners: new Set()
      };
      this.#states.set(output, state);
    }
    return state;
  }

  invalidateWaits(output) {
    const state = this.#stateFor(output);
    state.waitEpoch += 1;
    for (const wake of state.waitListeners) wake(true);
    state.waitListeners.clear();
  }

  /**
   * Open a read stream for an HLS segment or playlist file from a session.
   *
   * @param {string} sessionId
   * @param {string} fileName - Must match the playlist or segment name pattern.
   * @param {{ consumerId?: string }} [options] -
   *   `consumerId` says WHICH viewer is asking, so a session
   *   shared by several of them can tell their positions apart; absent from a
   *   browser or a transport that does not carry it, and then everything falls
   *   back to the one shared position.
   * @returns {Promise<
   *   | { kind: "not-found" }
   *   | { kind: "warming-up" }
   *   | { kind: "failed"; message: string }
   *   | { kind: "file"; stream: import("node:fs").ReadStream; contentType: string; isPlaylist: boolean }
   * >}
   */
  async getFileStream(sessionId, fileName, options = {}) {
    const consumerId = typeof options.consumerId === "string" ? options.consumerId : "";
    if (!isOutputName(sessionId)) {
      return { kind: "not-found" };
    }
    const session = this.#host.outputs.get(sessionId);
    // The session is looked up BEFORE the name is validated, because what
    // counts as a valid segment name depends on the container this session
    // chose — `.mp4` for fMP4, `.ts` for MPEG-TS.
    if (!session || !isSafeFileName(fileName, session.segmentFormat)) {
      return { kind: "not-found" };
    }
    // WHETHER PRODUCTION FAILED IS NOT ASKED HERE. It explains a piece that is
    // ABSENT and says nothing about one that is on disk: a segment under its
    // served name is whole by construction, whoever wrote it and whatever has
    // become of the encoder since. Asked at the door, as it was, a failed run
    // answered 500 to every request for material it had already finished — the
    // viewer lost what was made as well as what was not, and a seek back into
    // it could not be served either. It is asked where the answer is needed:
    // where the file is not there (`#holdForProduction`, and the init's own
    // absent branch).
    this.#host.outputs.touch(session);

    // The index of variants. Served from here rather than a route of its own,
    // because to a player it is simply another playlist under the session.
    if (fileName === MASTER_PLAYLIST_FILE_NAME) {
      const masterText = this.#host.buildMasterPlaylist(sessionId, consumerId);
      if (!masterText) {
        return { kind: "not-found" };
      }
      return {
        kind: "file",
        stream: Readable.from([masterText]),
        contentType: "application/vnd.apple.mpegurl",
        isPlaylist: true
      };
    }

    // Serve the synthetic VOD playlist (full duration, terminated with
    // #EXT-X-ENDLIST) so the player gets the correct total length and a fully
    // seekable timeline up-front, independent of how far ffmpeg has encoded.
    if (fileName === PLAYLIST_FILE_NAME && session.useSyntheticPlaylist) {
      return {
        kind: "file",
        stream: Readable.from([session.playlistText]),
        contentType: "application/vnd.apple.mpegurl",
        isPlaylist: true
      };
    }

    // The init segment (fMP4 only; referenced by #EXT-X-MAP). Each seek-restart
    // run REWRITES it, so cache the FIRST one and always serve that — the
    // player fetches it once and never re-fetches, so it must stay stable for
    // the session's lifetime. (What that costs, and why segments must therefore
    // carry their own position, is documented in `encode/segment-formats/mp4-boxes.js`
    // `stampSegmentStartTime`.)
    //
    // ffmpeg creates init.mp4 before it has finished writing the fMP4 header
    // boxes into it (unlike segments, its write is not gated behind an atomic
    // rename), so a read can race a moment where the file EXISTS but is still
    // EMPTY. Root cause of a real incident: that empty read used to be cached
    // as the output's init — a zero-length Buffer is still a truthy object,
    // so a check on its presence treated it as "already resolved" and served
    // the empty file for the rest of the session's life, permanently breaking
    // playback (hls.js can never initialize its SourceBuffer from an empty
    // init segment) while the transcode itself kept encoding normally. Guard
    // on non-empty content on both the cache check and the fresh read, so an
    // empty read is treated as not-yet-ready and the caller's long-poll keeps
    // retrying until ffmpeg has actually written the header.
    const { initFileName } = session.segmentFormat;
    if (initFileName !== null && fileName === initFileName) {
      const kept = this.#host.segmentStore.initOf(session.outputKey ?? "");
      if (kept) {
        return {
          kind: "file",
          stream: Readable.from([kept]),
          contentType: session.segmentFormat.initContentType,
          isPlaylist: false
        };
      }
      try {
        // With explicit cut times there is no init file: that muxer writes each
        // piece self-contained, header and all. The header is identical in every
        // piece, so the first one to exist supplies it.
        const bytes = cutsAtGivenTimes(session)
          ? await this.#initFromFirstSegment(session)
          : await readFile(path.join(this.#host.segmentStore.pathFor(session.outputKey ?? ""), initFileName));
        const standing = this.#host.segmentStore.keepInit(session.outputKey ?? "", bytes);
        if (!standing) {
          // Nothing usable yet. On the branch that lifts the header out of the
          // first piece there is no file to be missing, so "not produced yet"
          // arrives HERE and not in the catch below: `#initFromFirstSegment`
          // answers null rather than throwing `ENOENT`. A production that has
          // ended in an error is not going to produce one either, and saying
          // "still warming up" to that holds the request for its whole deadline.
          return this.#failedOrWarming(session);
        }
        return {
          kind: "file",
          stream: Readable.from([standing]),
          contentType: session.segmentFormat.initContentType,
          isPlaylist: false
        };
      } catch (error) {
        if (error?.code === "ENOENT") {
          // Not produced yet — the encode run started at session creation
          // writes it early; the caller long-polls until it appears. Unless
          // production has ended in an error, in which case nothing is going to
          // write it and holding the request only spends the viewer's patience.
          return this.#failedOrWarming(session);
        }
        logger.error(
          `transcode ${session.id} could not serve ${initFileName}: ${error?.message ?? error}` +
          (error?.stack ? `\n${error.stack}` : "")
        );
        return {
          kind: "failed",
          message: `Could not serve ${initFileName}: ${error?.message ?? String(error)}`
        };
      }
    }

    // Which run's copy answers, when several have written this name. Chosen by
    // what the copies CARRY, not by which run is newest — see #chooseProducedCopy.
    const filePath = this.#host.segmentStore.pathOfName(session.outputKey ?? "", fileName) ??
      path.join(this.#host.segmentStore.pathFor(session.outputKey ?? ""), fileName);
    const isPlaylist = fileName === PLAYLIST_FILE_NAME;
    if (!isPlaylist) {
      // A REQUEST SAYS THE VIEWER IS HERE, AND NOTHING ELSE. It does not say
      // where they are — that is what they state themselves — and it steers no
      // encoder: the segment either exists and is served, or does not and is
      // waited for.
      const requested = session.segmentFormat.segmentIndexFromName(fileName);
      if (requested >= 0) {
        this.#noteViewerSeen(session, consumerId);
        // A viewer who has caught up must not wait out the monitor's interval —
        // but only if they HAVE caught up, which is why this re-evaluates the
        // same condition instead of resuming outright.
        this.#host.cushion.reportCushionFor(session);
      }
    }
    // Whether the file is there is asked on its own, and nothing else shares
    // this catch. Everything below is PREPARATION of a file that exists, and a
    // failure there means something entirely different from "not produced yet"
    // — but for one release the two were caught together, so an undeclared name
    // in the fMP4 path read as "the segment is not ready". Every poll threw the
    // same ReferenceError, every poll answered "wait", and playback never began
    // on any file cut at keyframes (2.9.124; measured 2026-08-08: segment #0
    // held for 45 281 ms with twelve finished segments on disk).
    try {
      await access(filePath);
    } catch {
      // Not produced yet.
      return this.#holdForProduction(session, fileName, isPlaylist, options);
    }
    try {
      // Existing is not the same as finished. The `hls` muxer wrote each
      // segment to a temporary name and renamed it once complete, so a file
      // appearing WAS a finished segment. The `segment` muxer has no such
      // option: the file appears when writing begins. Serving it then hands the
      // player a truncated segment, which it rejects and then simply stops —
      // observed as playback dying a few seconds in with the encoder still
      // running happily ahead. A segment is finished once the NEXT one has been
      // started, or once the run producing it has ended.
      if (!isPlaylist && cutsAtGivenTimes(session)) {
        // WHAT PROVES A PIECE IS WHOLE is the encoder's own word for it: it
        // names each file on a channel of its own the moment it closes it, and
        // the store keeps those names.
        //
        // What stood here instead was the existence of the NEXT file, with two
        // exceptions bolted on because it is not true. It is never true of the
        // last piece of a run — nothing is producing a next one — so the first
        // segment of every run was held: measured 2026-08-09, #807 held while
        // it lay on disk, and in August the same shape held #317 for 46 seconds
        // and then answered 404 to a browser that had given up.
        const index = session.segmentFormat.segmentIndexFromName(fileName);
        if (!this.#host.segmentStore.isClosed(session.outputKey ?? "", index)) {
          this.#explainHold(session, fileName, "the encoder has not closed it yet");
          return { kind: "warming-up" };
        }
      }

      // Cold-start: the time from the create request to a playable first
      // segment, measured once per output by the owner of host timings.
      const coldStartMs = isPlaylist ? null : this.#host.hostTimings.noteSegmentServed(session);
      if (coldStartMs !== null) {
        // Data is flowing again, so the next loss starts its backoff afresh
        // rather than inheriting the delay of the last one.
        this.#host.encodeRuns.resetInputRetry(session);
        logger.info(`cold-start ${sessionId.slice(0, 8)}: first-segment ready +${coldStartMs}ms`);
      }
      // Formats whose segments need correcting before they are valid against
      // the session's cached init are read whole and passed through the format
      // module; the rest stream straight off disk.
      if (!isPlaylist && session.segmentFormat.needsSegmentRewrite) {
        const index = session.segmentFormat.segmentIndexFromName(fileName);
        const raw = await readFile(filePath);
        // Self-contained pieces carry the init header; a media segment must not.
        const bytes = cutsAtGivenTimes(session) && session.segmentFormat.stripInit
          ? session.segmentFormat.stripInit(raw)
          : raw;
        // WHOLE OR SHORT IS A JUDGEMENT ABOUT BYTES, and the format that
        // knows how to read them makes it (`judgeTracks`). What is done about
        // the answer is this path's business and stays here: a whole piece is
        // served, a short one is removed so it can be made again.
        const verdict = session.segmentFormat.judgeTracks?.(raw, bytes, this.#host.segmentStore.initOf(session.outputKey ?? "")) ?? null;
        if (verdict && !verdict.whole) {
          logger.warn(
            `transcode ${session.id} segment #${index} is short of a track — ` +
            `${filePath}, ${raw.length} bytes on disk, ${bytes.length} of body, ` +
            `${verdict.fragmentTracks} track(s) in its fragments against ` +
            `${verdict.sessionTracks} the session's header declares and ` +
            `${verdict.ownTracks} its own declares — ${verdict.because}`
          );
          if (!verdict.serve) {
            try {
              await unlink(filePath);
            } catch {
              // Already gone: either way nothing to do.
            }
            // What the store remembers of this directory is stale the moment a
            // file is taken out of it.
            this.#host.segmentStore.forget(session.outputKey ?? "");
            return { kind: "warming-up" };
          }
        }
        // Where this segment REALLY begins, taken from the piece itself, and
        // only from the playlist when the piece does not say.
        //
        // The playlist's own answer is built from the container's keyframe
        // index, and an index can be wrong: measured 2026-08-06 on a Matroska
        // file whose index claimed a keyframe at 157.99 s where the real ones
        // were 153.82 and 164.247. ffmpeg cut at 153.82, and stamping that
        // picture with 157.99 told the player it belonged four seconds later
        // than it did — while subtitles, extracted straight from the source,
        // kept the true times. Speech and text drifted apart by 4.17 s.
        //
        // Read from `raw`, before the header is stripped: the position lives
        // in an empty edit in the piece's own `moov`, which `stripInit`
        // removes. Identical to the playlist's figure whenever the index is
        // honest, so nothing changes for a well-formed file.
        const trueStart = cutsAtGivenTimes(session)
          ? session.segmentFormat.readSegmentStartSeconds?.(raw) ?? null
          : null;
        const declaredStart = this.#host.outputTimes.segmentStartTime(session, index);
        if (trueStart !== null) {
          this.#host.outputTimes.noteRunLanding(session, index, trueStart);
          this.#host.outputTimes.noteIndexAccuracy(session, index, trueStart, declaredStart);
        }
        // WHERE THE PLAYER WAS TOLD THIS SEGMENT BEGINS, which is the playlist
        // it holds and nothing else. The published text is fixed when the
        // session is created; `#segmentStartTime` reads a table that a
        // correction may since have moved, and a stamp taken from the moved
        // table describes a timeline the player has never seen.
        const publishedStart = this.#host.outputTimes.publishedStartTime(session, index);
        // A player places a fragment by the playlist. If the bytes claim a
        // different position, the fragment does not land where the fragment was
        // expected, hls.js finds the range still unbuffered and asks for the
        // same fragment again — for ever. Measured 2026-08-17: a seek to
        // 1590.4 s produced audio segments #292/#293 whose own timeline said
        // 1587.892 and 1592.692 against a playlist saying 1585.376 and
        // 1590.585, and the browser fetched those two segments 1908 times each
        // over ten minutes, every one of them served in 4 ms. The film was dead
        // and no line said why.
        //
        // So the stamp follows the playlist whenever the two disagree by more
        // than a player will bridge. hls.js bridges up to `maxBufferHole`,
        // which it defaults to 0.5 s — that is the player's own published
        // figure, not a number chosen here. Within it the file's own position
        // is kept, because it is the honest one and it is what keeps speech and
        // subtitles together on a file whose index is slightly out (2026-08-06,
        // 4.17 s of drift on a Matroska index that lied).
        // STAMPED WITH ITS OWN TRUE START, always. Two attempts at moving it
        // toward the playlist both made things worse, and the reason is in what
        // the first segment of a run is: it is not CUT at all — it begins where
        // ffmpeg's seek landed. The picture must land on a keyframe; the sound
        // needs none and starts at the instant asked for. So after every
        // restart the two runs genuinely begin at different real times, and the
        // whole run carries that difference (field 2026-08-17: the sound's
        // #292 began at 1587.892 s and #293 at 1592.692 s — exactly one segment
        // apart, the whole run shifted 2.5 s from the grid).
        //
        // Labelling each track with its own true time is therefore what keeps
        // picture and sound together in real time. Moving them onto the
        // published grid — separately (2.24.1) or by one family offset (2.25.0)
        // — closes a gap that is real and opens one that is not: it desynced
        // playback in the field within the hour, twice.
        //
        // What that leaves unsolved is the reason those attempts were made: a
        // playlist that disagrees with the media by more than a player bridges
        // makes hls.js refetch the same fragment for ever (1908 times each for
        // two segments, measured). The answer to THAT is to make the published
        // grid agree with where the runs really begin — not to relabel the
        // media. Recorded as its own roadmap item rather than guessed at here.
        const stampStart = trueStart ?? publishedStart;
        if (trueStart !== null) {
          this.#host.outputTimes.notePlaylistDisagreement(session, index, trueStart, publishedStart);
        }
        const prepared = session.segmentFormat.prepareSegmentBytes(bytes, {
          startSeconds: stampStart,
          rawBytes: raw,
          initBytes: this.#host.segmentStore.initOf(session.outputKey ?? "")
        });
        this.#host.encodeRuns.noteRunProducedSegment(session, filePath);
        return {
          kind: "file",
          stream: Readable.from([prepared]),
          contentType: session.segmentFormat.segmentContentType,
          isPlaylist: false
        };
      }
      if (!isPlaylist) {
        this.#host.encodeRuns.noteRunProducedSegment(session, filePath);
      }
      return {
        kind: "file",
        stream: isPlaylist
          ? createReadStream(filePath)
          : createReadStream(filePath, { highWaterMark: SEGMENT_READ_HIGH_WATER_MARK }),
        contentType: isPlaylist
          ? "application/vnd.apple.mpegurl"
          : session.segmentFormat.segmentContentType,
        isPlaylist
      };
    } catch (error) {
      if (error?.code === "ENOENT") {
        // The file went away between the check and the read — a leftover being
        // removed so it can be produced again. Means exactly what never having
        // existed means.
        return this.#holdForProduction(session, fileName, isPlaylist, options);
      }
      // Anything else is a fault in producing the answer. Name it: a request
      // answered "wait" for ever tells the viewer nothing and leaves no trace
      // of what actually happened.
      logger.error(
        `transcode ${session.id} could not serve ${fileName}: ${error?.message ?? error}` +
        (error?.stack ? `\n${error.stack}` : "")
      );
      return {
        kind: "failed",
        message: `Could not serve ${fileName}: ${error?.message ?? String(error)}`
      };
    }
  }

  /**
   * Whether a piece already given to a viewer can still be served from what is
   * stored under the key of the output that made it, after that output has
   * gone.
   *
   * WHY THIS EXISTS (roadmap item 97, step 11). A repeat of an address must be
   * answered by what answered it the first time: the player holds that
   * output's header, and a piece of another output under the same address may
   * not decode under it. When the output itself has been disposed, its pieces
   * and its header stay in the store until the disk needs the room — so the
   * very bytes that were given can be given again.
   *
   * @param {string} goneKey
   * @param {string} fileName
   * @returns {boolean}
   */
  hasStoredPiece(goneKey, fileName) {
    const format = this.#host.segmentFormatOfKey(goneKey);
    if (!format) {
      return false;
    }
    if (format.initFileName !== null && fileName === format.initFileName) {
      return Boolean(this.#host.segmentStore.initOf(goneKey));
    }
    if (!format.isSegmentFileName(fileName)) {
      return false;
    }
    const index = format.segmentIndexFromName(fileName);
    return this.#host.segmentStore.isClosed(goneKey, index) &&
      Boolean(this.#host.segmentStore.pathOfName(goneKey, fileName));
  }

  /**
   * That stored piece, prepared exactly as it would have been served while its
   * output lived: its header stripped where the piece carries one, and stamped
   * with where it truly begins or, where it does not say, where the playlist
   * the player holds puts it.
   *
   * `like` is the picture the address belongs to. Every output interchangeable
   * with it publishes one timeline, so its playlist is the gone output's too.
   *
   * @param {string} goneKey
   * @param {string} likeId - The picture the address belongs to.
   * @param {string} fileName
   * @returns {Promise<{ kind: "file", stream: Readable, contentType: string, isPlaylist: false } | null>}
   */
  async storedPieceOf(goneKey, likeId, fileName) {
    const like = isOutputName(likeId) ? this.#host.outputs.get(likeId) : null;
    const format = this.#host.segmentFormatOfKey(goneKey);
    const spec = this.#host.specOfKey(goneKey);
    if (!format || !spec || !like || !this.hasStoredPiece(goneKey, fileName)) {
      return null;
    }
    const answer = (bytes, contentType) => ({
      kind: "file",
      stream: Readable.from([bytes]),
      contentType,
      isPlaylist: false
    });
    if (format.initFileName !== null && fileName === format.initFileName) {
      return answer(this.#host.segmentStore.initOf(goneKey), format.initContentType);
    }
    const index = format.segmentIndexFromName(fileName);
    let raw;
    try {
      raw = await readFile(this.#host.segmentStore.pathOfName(goneKey, fileName));
    } catch {
      return null;
    }
    if (!format.needsSegmentRewrite) {
      return answer(raw, format.segmentContentType);
    }
    const view = { segmentFormat: format, spec, timeline: like.timeline };
    const selfContained = cutsAtGivenTimes(view);
    const bytes = selfContained && format.stripInit ? format.stripInit(raw) : raw;
    const trueStart = selfContained ? format.readSegmentStartSeconds?.(raw) ?? null : null;
    const prepared = format.prepareSegmentBytes(bytes, {
      startSeconds: trueStart ?? this.#host.outputTimes.publishedStartTime(like, index),
      rawBytes: raw,
      initBytes: this.#host.segmentStore.initOf(goneKey)
    });
    logger.info(`[hold] ${fileName} served from the stored pieces of ${goneKey}, the output that first answered it`);
    return answer(prepared, format.segmentContentType);
  }

  /**
   * Whether a piece of `liveKey` may stand where a piece of `goneKey` was
   * given: the two headers compared by the product's own rule
   * (`init-compat.js`), which refuses anything it cannot show a decoder
   * ignores. A header not yet made is no proof, and so is a refusal.
   *
   * @param {string} goneKey
   * @param {string} liveKey
   * @returns {{ compatible: boolean, differences: string[] }}
   */
  headersCompatible(goneKey, liveKey) {
    const verdict = this.#host.compareInits(
      this.#host.segmentStore.initOf(goneKey),
      this.#host.segmentStore.initOf(liveKey)
    );
    return { compatible: verdict.compatible === true, differences: verdict.differences ?? [] };
  }

  /**
   * Say WHY a segment is being held, at most once every few seconds per file.
   *
   * A hold is silent today, and that silence has now cost three releases: a
   * file that exists, a route that answers "not yet", and nothing anywhere
   * saying which of the several reasons applied. Measured 2026-08-09: a run
   * begun mid-file at segment #317 produced two minutes of video from #317
   * upwards at 10.5x, and #317 itself was held 46 s and then answered 404 once
   * the browser had given up — with not one line about the cause.
   *
   * @param {HlsSession} session
   * @param {string} fileName
   * @param {string} reason
   * @returns {void}
   */
  #explainHold(session, fileName, reason) {
    const now = Date.now();
    const state = this.#stateFor(session);
    const last = state.holdExplainedAt.get(fileName) ?? 0;
    if (now - last < 5_000) {
      return;
    }
    state.holdExplainedAt.set(fileName, now);
    const index = session.segmentFormat.segmentIndexFromName(fileName);
    // What the encoder has actually DONE since it restarted. "Alive at the right
    // index" was as far as the old line went, and it left the two possible
    // causes indistinguishable: an encoder waiting for torrent pieces looks
    // exactly like one that is encoding and simply has not finished. The
    // difference is whether its position has moved at all.
    // Where this run began, from the run — the same reckoning
    // `processedSeconds` is counted in. A table lookup here can disagree with
    // it by the distance between the two grids, which is enough to print a
    // negative "produced" and send the reader after the torrent when the
    // encoder is the subject.
    const progress = this.#host.encodeRuns.progressOf(session, index);
    const runStartSeconds = Number.isFinite(progress?.startPositionSeconds)
      ? progress.startPositionSeconds
      : this.#host.runStartTimeFor(session, this.#host.encodeRuns.earliestStartOf(session) ?? 0);
    const position = Number(progress?.processedSeconds);
    const produced = Number.isFinite(position) ? position - runStartSeconds : null;
    const measured = this.#host.encodeRuns.liveRunsOf(session)
      .reduce((best, run) => Math.max(best, run.speedX || 0), 0);
    const speed = measured > 0 ? `${measured.toFixed(2)}x` : "n/a";
    logger.warn(
      `transcode ${session.id} holding ${fileName}: ${reason} ` +
      `(runs from #${this.#host.encodeRuns.earliestStartOf(session) ?? "?"}, viewer at #${this.#host.outputTimes.segmentIndexForTime(session, this.#host.viewerSecondsOn(session))}, ` +
      `encoder ${this.#host.encodeRuns.liveRunsOf(session).length > 0 ? "alive" : "stopped"}, index #${index}, ` +
      `produced ${produced === null ? "nothing yet — no position reported" : `${produced.toFixed(1)}s`} ` +
      `at ${speed}${produced !== null && produced <= 0 ? " — the encoder has not moved, so it is waiting on its input" : ""})`
    );
  }

  /**
   * What an absent file answers when production has failed.
   *
   * @param {object} session
   * @returns {{ kind: "failed", message: string } | { kind: "warming-up" }}
   */
  #failedOrWarming(session) {
    if (!this.#host.encodeRuns.hasFailed(session)) {
      return { kind: "warming-up" };
    }
    return {
      kind: "failed",
      message: this.#host.encodeRuns.lastErrorOf(session) || "ffmpeg failed for this transcode session."
    };
  }

  #holdForProduction(session, fileName, isPlaylist, options) {
    // The file is not there and production has ended in an error: nothing is
    // going to write it, so the viewer is told instead of held.
    if (this.#host.encodeRuns.hasFailed(session)) {
      return this.#failedOrWarming(session);
    }
    if (this.#host.encodeRuns.isWaitingForInput(session)) {
      // The data went away and is being fetched again. Holding the request is
      // the truthful answer: nothing is broken and there is nothing for the
      // viewer to retry. Only what is NOT on disk is held for it — a piece that
      // exists is whole, and it is served whatever the encoder is doing.
      return { kind: "warming-up" };
    }
    /** @type {{ address: string, rank: number, topRank: number } | null} */
    let ranked = null;
    if (!isPlaylist) {
      this.#explainHold(session, fileName, "the file is not on disk");
    }
    // A segment was requested that ffmpeg has not produced yet.  Decide whether
    // to wait for the current encode run to reach it or to restart the encoder
    // at this position (server-side seeking).  The caller long-polls.
    if (!isPlaylist) {
      const requestedIndex = session.segmentFormat.segmentIndexFromName(fileName);
      // Unanswerable, and known to be: behind a run that only moves forward,
      // too far behind for the repair to fetch it, and no seek on its way to
      // move the encoder there. Holding it changes nothing about whether it can
      // be produced — it only spends the player's patience.
      //
      // This is what a track change costs when it is held instead: measured
      // 2026-08-15, hls.js asked the new track for segment #0 while the run was
      // at #354, the request was held for the full minute, and only when it
      // failed did the player move to the segment it actually needed — 63 s of
      // spinner after a track that had been made ready in 7.
      //
      // WHETHER ANYBODY IS COMING FOR IT, asked of the encoding (`rankAt`,
      // which also tells "in nobody's zone" from "no map yet"). The same walk
      // was written out here and could answer only yes or no, so the RANK was
      // discarded at the one point where a viewer measurably waits for a named
      // segment; it goes back out with the answer, because the wait is measured
      // by whoever holds the request.
      const address = session.outputKey ?? "";
      const { rank, topRank } = this.#host.encodeOrchestrator.rankAt(address, requestedIndex);
      ranked = { address, rank, topRank };
      const nobodyIsComing = topRank > 0 && rank === 0;
      if (
        Number.isFinite(requestedIndex) &&
        requestedIndex < (this.#host.encodeRuns.earliestStartOf(session) ?? 0) &&
        nobodyIsComing &&
        this.#host.encodeRuns.liveRunsOf(session).length > 0
      ) {
        logger.info(
          `transcode ${session.id} segment #${requestedIndex} is ${(this.#host.encodeRuns.earliestStartOf(session) ?? 0) - requestedIndex} ` +
          "segments behind the run and in nobody's zone; answered as absent rather than held"
        );
        return { kind: "not-found", ranked };
      }
      this.#noteWanted(session, requestedIndex);
    }
    return { kind: "warming-up", ranked };
  }

  /**
   * Record that a segment nobody has made yet is wanted, and say so when it lies
   * behind every encoder of this output.
   *
   * A REQUEST STEERS NO ENCODER. This used to be where one did: a request far
   * from the encode head restarted ffmpeg there, and in the field one seek
   * produced nine restarts in a minute, because a player holds a couple of
   * dozen requests open at once and none of them is "the one the viewer ended
   * on". What is missing in front of a viewer is stated by the priority map,
   * and placing encoders on it is the plan's work. What is left here is a
   * record for the restart accounting and a line for whoever reads the log.
   *
   * @param {HlsSession} session
   * @param {number} index
   * @returns {void}
   */
  #noteWanted(session, index) {
    // When this segment was FIRST asked for and nobody was producing it. The
    // restart itself costs 0.7-1.3 s (measured 2.9.132), while a seek costs
    // 5-8 s end to end — so most of the wait happens before a restart is even
    // decided on, and that is what this records.
    this.#host.encodeRuns.noteWanted(session, index);
    if (!this.#host.encodeRuns.isLive(session) || index < 0) {
      return;
    }
    const head = this.#host.encodeRuns.earliestStartOf(session) ?? 0;
    if (index < head) {
      // Nothing running goes backwards, so nothing running will make it.
      this.#explainHold(
        session,
        session.segmentFormat.segmentFileName(index),
        `it is behind the run (#${head}); where the viewers are is what places encoders`
      );
    }
  }

  /**
   * The init header, lifted out of the first segment that exists.
   *
   * Needed only on the explicit-cut path, where the muxer produces no init file
   * of its own. Scans rather than assuming segment 0: a run started by a seek
   * begins at whatever index the viewer asked for.
   *
   * @param {HlsSession} session
   * @returns {Promise<Buffer | null>}
   */

  async #initFromFirstSegment(session) {
    if (typeof session.segmentFormat.extractInit !== "function") {
      return null;
    }
    // How many tracks a complete header must declare is ANSWERED, not assumed.
    //
    // The probe already knows the source's stream list, and the output maps at
    // most one of each (`-map 0:v:0? -map 0:a:0?`), so the count follows from
    // what the source actually has. A film with no soundtrack expects one; an
    // ordinary file expects two; neither is a convention.
    //
    // Deriving it from the produced pieces instead — the first version of this
    // — reads correctly only once a piece carrying every track exists, and the
    // whole point is the moment BEFORE that: early pieces written before the
    // video was muxed would set the requirement to one and wave through exactly
    // the header this exists to reject. The pieces are still consulted, but
    // only as a floor: a piece carrying more than the probe led us to expect is
    // evidence, and evidence outranks the probe.
    const declared = this.#host.declaredTracks(session);
    let expectedTracks = (declared.video ? 1 : 0) + (declared.audio ? 1 : 0);
    if (expectedTracks === 0) {
      // Nothing to consult. Fall back to the evidence, with its known lag.
      expectedTracks = 1;
    }
    let best = null;
    let bestTracks = 0;
    /** @type {Map<string, Buffer>} Pieces read once and used for both passes. */
    const pieces = new Map();
    let names;
    try {
      names = this.producedNumbers(session).map((index) => session.segmentFormat.segmentFileName(index));
    } catch {
      return null;
    }
    // First pass: what do the produced pieces actually carry? The answer is the
    // requirement — no assumption about the source is involved.
    if (typeof session.segmentFormat.countSegmentTracks === "function") {
      for (const name of names) {
        try {
          // The first copy WITH BYTES IN IT, not the first name: a run stopped
          // with a piece open leaves an empty file under the same name, and
          // taking that one skips a number whose header is sitting in the run
          // before it.
          const found = await this.#firstCopyWithBytes(session, name);
          if (!found) {
            continue;
          }
          const bytes = await readFile(found);
          pieces.set(name, bytes);
          expectedTracks = Math.max(expectedTracks, session.segmentFormat.countSegmentTracks(bytes));
        } catch {
          // Being written right now — it says nothing about the others.
        }
      }
    }

    for (const name of names) {
      try {
        const cached = pieces.get(name);
        const found = cached ? name : await this.#firstCopyWithBytes(session, name);
        if (!found) {
          continue;
        }
        const ownInit = session.segmentFormat.extractInit(cached ?? await readFile(found));
        const init = ownInit && session.segmentFormat.prepareSharedInit ?
          session.segmentFormat.prepareSharedInit(ownInit) : ownInit;
        if (!init || init.length === 0) {
          continue;
        }
        // The requirement computed above is APPLIED here. It was computed and
        // then ignored: this loop returned the first header it found, so a
        // piece written before the video was muxed supplied an audio-only
        // header — and that header is cached for the session's whole life,
        // because the player fetches `#EXT-X-MAP` once. Measured 2026-08-11:
        // `videoWidth=0`, `totalVideoFrames=0`, `readyState=4` — sound playing
        // and no picture, for as long as the session lasted.
        const tracks = typeof session.segmentFormat.countInitTracks === "function"
          ? session.segmentFormat.countInitTracks(init)
          : expectedTracks;
        if (tracks >= expectedTracks) {
          return init;
        }
        if (tracks > bestTracks) {
          best = init;
          bestTracks = tracks;
        }
      } catch {
        // Being written right now — try the next one.
      }
    }
    if (best !== null) {
      // Nothing carried the full set. The source is probably missing a stream;
      // serving the richest header found is right, and saying so makes the
      // other possibility — every piece so far written before the video was
      // muxed — visible rather than silent.
      logger.warn(
        `transcode ${session.id} no piece declared ${expectedTracks} tracks; ` +
        `serving an init with ${bestTracks}`
      );
      return best;
    }
    return best;
  }

  /**
   * A produced file that has anything in it, or null.
   *
   * For callers that need a file's CONTENTS and cannot judge them — deriving
   * the session's header is the case, since the header is what judging would
   * need. An empty file answers no question, so it is passed over.
   *
   * @param {HlsSession} session
   * @param {string} fileName
   * @returns {Promise<string | null>}
   */
  async #firstCopyWithBytes(session, fileName) {
    const held = this.#host.segmentStore.pathOfName(session.outputKey ?? "", fileName);
    if (held === null) {
      return null;
    }
    try {
      const info = await stat(held);
      return info.size > 0 ? held : null;
    } catch {
      return null;
    }
  }

  /**
   * Record where one viewer of this session is, and answer with the furthest
   * any of them has reached.
   *
   * The furthest is what the single encoder is steered by: it has to serve
   * everyone, and what lies behind the leader has already been produced and is
   * served from disk without a wait. The individual positions exist for the
   * opposite question — whether a particular held request is still wanted —
   * which cannot be answered from a shared field.
   *
   * A REQUEST IS NOT A POSITION. It says the viewer is still here and nothing
   * more: where they are is what they themselves state, on the viewer, and a
   * request cannot reach it. Asking for a segment used to write the position,
   * so two writers filled one field in turn and the priority map jumped
   * backwards several times a second — measured 2026-09-13, 77 encoder starts
   * and 141 stops in six minutes while both viewers sat frozen.
   *
   * A viewer is forgotten once nothing has been heard from them for longer than
   * any silence a watching viewer can produce. The figure is the proxy's own
   * look-ahead, not a chosen interval.
   *
   * @param {HlsSession} session
   * @param {string} consumerId
   * @returns {void}
   */
  #noteViewerSeen(session, consumerId) {
    // A request that names nobody is evidence about nobody.
    if (!consumerId) {
      return;
    }
    this.#host.viewers.of(session, consumerId).seen();
  }

  /**
   * Whether a held request is for a segment the viewer STILL needs.
   *
   * The epoch alone says a seek happened; it cannot say whether this particular
   * request was made for the position left behind or for the one just arrived
   * at. That distinction is the whole of the failure measured 2026-08-18: the
   * viewer seeked to 1061.0 s, the request for `segment-00101` — the segment AT
   * that position — raced the seek notification, the epoch moved underneath it,
   * and it was answered 503 twice within 80 ms. The player then hunted at
   * sn=105-107, never came back to 101, and looped two audio segments 1473
   * times over 149 s while the picture stood still.
   *
   * A request is stale when its segment lies behind where the viewer now is, or
   * so far ahead that the running encode will not reach it. Anything between is
   * exactly what the viewer is waiting for, and holding it is the point.
   *
   * "So far ahead" is the encoder's own look-ahead, measured on this session's
   * own cut grid — the same figure the browser sizes its forward buffer from.
   * It used to be `MAX_LOOKAHEAD_SEGMENTS`, which is eight segments ahead of
   * the ENCODE HEAD
   * and has nothing to do with how far ahead of the VIEWER a request may
   * legitimately sit; it happened to match a browser holding 30 s, and would
   * have refused three quarters of the requests of one holding the whole
   * cushion (roadmap item 4).
   *
   * Judged against the position of the viewer who MADE the request, when the
   * transport carries who that is. A session is shared by everyone watching a
   * copied picture and the epoch is per session, so a seek by the viewer in
   * front used to release every request being held for the viewer behind them.
   *
   * @param {string} sessionId
   * @param {string} fileName
   * @param {string} [consumerId] - Who is asking. Without it the one shared
   *   position decides, which is what a single viewer means anyway.
   * @returns {boolean} True when the request should keep waiting.
   */
  requestStillWanted(sessionId, fileName, consumerId = "") {
    const session = isOutputName(sessionId) ? this.#host.outputs.get(sessionId) : null;
    if (!session) {
      return false;
    }
    const index = session.segmentFormat?.segmentIndexFromName?.(fileName) ?? -1;
    if (!(index >= 0)) {
      return true; // a playlist or an init segment belongs to no position
    }
    const position = this.#host.viewerSecondsOn(session, consumerId);
    const at = this.#host.outputTimes.segmentIndexForTime(session, position);
    // The far edge on THIS session's own grid rather than a count of nominal
    // segments: a copied picture is cut at the source's keyframes, so its
    // segments are not four seconds long and dividing by that figure would put
    // the edge somewhere else entirely. The segment CONTAINING the edge is
    // wanted — it is the one the deepest allowed request lands in, and it
    // already reaches past the cushion by whatever is left of its own duration.
    const edge = this.#host.outputTimes.segmentIndexForTime(session, position + this.#host.lookaheadSeconds);
    return index >= at && index <= edge;
  }

  /**
   * How many times the viewer has moved since this session started.
   *
   * A request being held for a segment answers "retry" as soon as this changes,
   * because it was made for a position the viewer has left — see `requestSeek`.
   *
   * @param {string} sessionId
   * @returns {number}
   */
  seekEpoch(sessionId) {
    const session = isOutputName(sessionId) ? this.#host.outputs.get(sessionId) : null;
    return session ? this.#stateFor(session).waitEpoch : 0;
  }

  /**
   * Wait for the requested segment to be published, without polling the disk.
   *
   * Ends on the publication, on the waits of this output being invalidated, on
   * the deadline, or when the requester goes — and whichever ends it, the
   * waiter is taken out of the store, so a wait with no deadline cannot outlive
   * the request it was for. Returns false at once for playlists and init files,
   * whose readiness has a different owner.
   *
   * @param {string} sessionId
   * @param {string} fileName
   * @param {number} timeoutMs - May be infinite.
   * @param {Promise<unknown> | null} [requesterGone]
   * @returns {Promise<boolean>} Whether it is worth asking for the file again.
   */
  async waitForSegment(sessionId, fileName, timeoutMs, requesterGone = null) {
    const session = isOutputName(sessionId) ? this.#host.outputs.get(sessionId) : null;
    const index = session?.segmentFormat?.segmentIndexFromName?.(fileName) ?? -1;
    if (!session || index < 0) return false;
    const state = this.#stateFor(session);
    let wake;
    const invalidated = new Promise((resolve) => {
      wake = resolve;
      state.waitListeners.add(resolve);
    });
    let finished = () => {};
    const over = new Promise((resolve) => {
      finished = resolve;
    });
    try {
      return await Promise.race([
        this.#host.segmentStore.waitFor(session.outputKey ?? "", index, timeoutMs, over),
        invalidated,
        ...(requesterGone ? [requesterGone.then(() => false)] : [])
      ]);
    } finally {
      state.waitListeners.delete(wake);
      finished();
    }
  }

  /**
   * Poll until the HLS playlist file exists and contains a valid `#EXTM3U`
   * header, or until the session fails, or until the startup timeout elapses.
   * Throws with message `"HLS playlist is still warming up."` on timeout.
   *
   * @param {HlsSession} session
   * @returns {Promise<void>}
   */
  async waitUntilReady(session) {
    // With a synthetic VOD playlist there is nothing to wait for: the playlist
    // is generated from the probed duration and is available immediately.
    // Individual segments are long-polled by the segment route as ffmpeg
    // produces them.
    if (session.useSyntheticPlaylist) {
      if (this.#host.encodeRuns.hasFailed(session)) {
        throw new Error(this.#host.encodeRuns.lastErrorOf(session) || "ffmpeg failed to start HLS session.");
      }
      return;
    }

    const playlistPath = path.join(this.#host.segmentStore.pathFor(session.outputKey ?? ""), PLAYLIST_FILE_NAME);
    const deadline = Date.now() + this.#host.startupWaitMs;

    while (Date.now() < deadline) {
      if (this.#host.encodeRuns.hasFailed(session)) {
        throw new Error(this.#host.encodeRuns.lastErrorOf(session) || "ffmpeg failed to start HLS session.");
      }
      try {
        await access(playlistPath);
        const text = await readFile(playlistPath, "utf8");
        if (text.includes("#EXTM3U")) {
            return;
        }
      } catch (_error) {
        // Playlist is not ready yet.
      }
      await delay(250);
    }

    throw new Error("HLS playlist is still warming up.");
  }

  /**
   * Answer the player's report that a delivered fragment sits far from the edge
   * of its buffer, with the one fact only this side holds: which boundary the
   * segment of that number really begins at.
   *
   * The player can say the gap; it cannot say whether the cause is its own
   * loading or a run whose output no longer matches its numbering. Here both
   * are in hand — the time the playlist gave that segment, and, when the
   * segment has been served, the time it truly began at — so the line either
   * names a shifted run or clears this side of it.
   *
   * Diagnostic only: nothing is repositioned on the strength of a browser's
   * reading, deliberately, because a wrong answer here would restart an encoder
   * the viewer is waiting on.
   *
   * @param {string} sessionId
   * @param {{ sn: number, track?: string, fragStartSec: number, bufferEndSec: number, currentTimeSec: number }} report
   * @returns {boolean} False when no such session exists.
   */
  recordFragmentFar(sessionId, { sn, track, fragStartSec, bufferEndSec, currentTimeSec }) {
    const named = this.#host.outputs.get(sessionId);
    if (!named) {
      return false;
    }
    // Which of the two streams the report is about. The browser addresses
    // everything to the video session's id — the soundtrack is served under
    // `/a/<n>/` on that same id — but it is a session of its own, with its own
    // run and its own position, and that is exactly the pair this report exists
    // to tell apart. Answering an audio report from the picture's records would
    // state, confidently, something about the wrong stream.
    const onScreen = this.#host.activeOutputFor({ base: named, outputs: this.#host.outputs });
    const session = track === "audio"
      ? ([...this.#host.outputs.familyOf(onScreen)].find((member) => member.spec.carries === "audio-only") ?? onScreen)
      : onScreen;
    const gap = fragStartSec - bufferEndSec;
    const declared = this.#host.outputTimes.publishedStartTime(session, sn);
    const trueStart = this.#host.outputTimes.trueStartAt(session, sn);
    const verdict = trueStart === undefined
      // Where a segment truly began is only ever read off one that was cut on
      // an explicit list — a uniform grid has nothing to read back — so this is
      // "not recorded", which is not the same as "not produced", and the line
      // must not claim the second.
      ? "where that segment began is not recorded on this side, so the gap cannot be attributed here"
      : (() => {
        const at = this.#host.outputTimes.boundaryIndexAt(session, trueStart, this.#host.publishedGridFor(session));
        if (at === null) {
          return `it really began at ${trueStart.toFixed(3)}s, which is no boundary of this grid`;
        }
        if (at === sn) {
          return `it really began at boundary #${sn}, where it should — the gap is not this run's`;
        }
        return `it really began at boundary #${at}, ${sn - at} place(s) before its own number — ` +
          "this run's output does not match its numbering";
      })();
    logger.warn(
      `transcode ${session.id} the player is stuck: ${session.spec.carries === "audio-only" ? "sound" : "picture"} ` +
      `fragment #${sn} starts ${gap.toFixed(1)}s past ` +
      `the end of its buffer (${bufferEndSec.toFixed(1)}s, viewer at ${currentTimeSec.toFixed(1)}s, ` +
      `the playlist puts it at ${declared.toFixed(3)}s) — ${verdict}`
    );
    return true;
  }

  /**
   * Every segment number this session's OUTPUT holds, whoever produced it.
   *
   * Public because it is the one thing worth asserting about the address
   * change: two sessions of one output answer with the same list, including
   * segments the other one's encoder made.
   *
   * @param {HlsSession} session
   * @returns {number[]}
   */
  producedSegmentNumbers(session) {
    return new Set(this.producedNumbers(session));
  }

  /**
   * What this session's OUTPUT holds, asked of the one thing that owns it.
   *
   * There were two owners of this fact over one directory: the store, addressed
   * by the output's own key, and a `ProducedIndex` built per SESSION over a
   * path the store had handed out. Two viewers of one output therefore built
   * two indexes over one directory, each with its own idea of what was in it.
   *
   * @param {HlsSession} session
   * @returns {number[]} Every segment number it holds, in order.
   */
  producedNumbers(session) {
    return this.#host.segmentStore.provenNumbers(session.outputKey ?? "");
  }
}
