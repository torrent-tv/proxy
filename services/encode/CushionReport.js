/**
 * How much film is ready in front of the earliest viewer of each output, said
 * every half minute, and what that costs off the swarm.
 *
 * A reading, and it commands nothing: where encoders go is the plan's. The one
 * thing it starts is the fetch of a picture's spare soundtracks, once the
 * cushion is full and the swarm has demonstrably spare capacity.
 */

export const LOOKAHEAD_PAUSE_SECONDS = 120;
// How often each session says what its cushion is. Half a minute: the link
// reports that feed it arrive every ten seconds, and a line per session per
// ten seconds would drown the log on a host serving several.
const CUSHION_REPORT_MS = 30_000;
// How old a viewer's link report may be and still describe where they are. It
// is sent every 10 s, and a seek in between moves them somewhere this cannot
// predict — so anything older is treated as no report at all.
const NET_REPORT_FRESH_MS = 15_000;

/**
 * The last index of the unbroken run of segments starting at `from`.
 *
 * Null when `from` itself is absent. A hole matters: segments beyond one are
 * not look-ahead, because the viewer cannot reach them until it is filled.
 *
 * @param {Set<number>} present
 * @param {number} from
 * @returns {number | null}
 */
export function contiguousEnd(present, from) {
  if (!present.has(from)) {
    return null;
  }
  let last = from;
  while (present.has(last + 1)) {
    last += 1;
  }
  return last;
}

export class CushionReport {
  /** What this reads and asks of the rest of the proxy, and nothing else. @type {object} */
  #host;

  /** Files whose spare soundtracks have been fetched whole, once each. @type {Set<string>} */
  #spareSoundtracksFetched = new Set();
  #lastSaidAt = new WeakMap();
  #lookAheadDisagreementSince = new WeakMap();

  /**
   * @param {object} host - `viewerSecondsOn`, `viewersOf`, `SourceFiles`, `logger`, `producedNumbers`, `encodeRuns`, `fetchWholeFile`, `getCachedAudioTracks`, `hostLoad`, `lookaheadSeconds`, `outputTimes`, `outputs`
   */
  constructor(host) {
    this.#host = host;
  }

  /**
   * Say what the cushion is, for every session.
   *
   * This is all that is left of `#enforceLookAhead`, which also SUSPENDED a run
   * once it was `LOOKAHEAD_PAUSE_SECONDS` in front of the viewer and woke it at
   * `LOOKAHEAD_RESUME_SECONDS` — two chosen numbers, and a second authority
   * over the encoders beside the plan. The two contradicted each other
   * directly: this one deliberately pushed a run past the window the plan was
   * asking about, and the plan then killed it for standing there. Measured in
   * the field 2026-09-05, 350-700ms per cycle, the viewer's picture stopped for
   * 125 seconds.
   *
   * How far ahead a run may get is now a question for the plan alone, which
   * answers it from the demand map. What remains here is a READING — how much
   * film is ready in front of the earliest viewer — and a reading commands
   * nothing.
   */
  reportCushions() {
    for (const session of this.#host.outputs.values()) {
      this.reportCushionFor(session);
    }
  }

  /**
   * Decide whether one session's encoder should be running right now.
   *
   * Called both on the monitor's interval and the moment a segment is
   * requested. It must be the SAME decision in both places: an earlier version
   * simply resumed on any request, which meant a request for a segment produced
   * ten minutes ago released an encoder that had nothing left to do — measured
   * 2026-08-04, the encoder sawtoothed between suspended and running and drifted
   * from 135 s to 702 s ahead of the viewer while doing it.
   *
   * @param {HlsSession} session
   * @returns {void}
   */
  reportCushionFor(session) {
    if (!this.#host.encodeRuns.isLive(session) || this.#host.encodeRuns.liveRunsOf(session).length === 0) {
      return;
    }
    // How far the encoder has got, measured by what EXISTS. ffmpeg's own
    // report of its timeline position is not evidence: field 2026-08-06, it
    // claimed 6012 s at `speed=1.18e+03x` on a file that was one percent
    // downloaded and had produced exactly one segment. The limiter believed it,
    // suspended the encoder twelve seconds into the session, and segment #1 —
    // which nobody was now making — was held for 45.7 s until the viewer gave
    // up and seeked. A segment on disk is something the viewer can be served;
    // a number from ffmpeg is not.
    // Where the viewer is, from the one reading there is.
    const viewerSegment = this.#host.outputTimes.segmentIndexForTime(session, this.#host.viewerSecondsOn(session));

    // How much is ready CONTIGUOUSLY FROM WHERE THE VIEWER IS — not the highest
    // segment number lying in the directory. The two are the same only while a
    // viewer moves forward through one run, and the difference destroyed a
    // session on 2026-08-06: a seek forward left segments 662-665 on disk, the
    // viewer then seeked BACK to 646, and the limiter measured 6950 s of output
    // against a viewer at 6700 s, called it "250s ahead" and suspended a run
    // 136 ms after it started, before it had produced anything at all. Nothing
    // was then encoding, so nothing read the input, so no pieces were asked for
    // — `0 selection(s)` with 33 peers connected — and segment 646 was never
    // made. Segments beyond a hole are not look-ahead: the viewer cannot reach
    // them without the hole being filled first.
    const reading = this.#contiguousAheadSeconds(session, viewerSegment);
    const aheadSeconds = reading === null ? null : reading.seconds;
    if (aheadSeconds === null) {
      // The segment the viewer needs does not exist, so there is no cushion to
      // report. Nothing is commanded here any more: whether an encoder should
      // be working on it is the plan's question, and it is asked the moment
      // anything the plan depends on changes.
      return;
    }

    // Worth knowing when ffmpeg's own report and what exists disagree wildly —
    // it is the only trace of whatever made it claim a position it had not
    // reached. Reported on its EDGES, because it is a state and not a stream.
    const claimed = Number(this.#host.encodeRuns.progressOf(session, viewerSegment)?.processedSeconds);
    const encodedTo = this.#host.outputTimes.segmentStartTime(session, viewerSegment) + aheadSeconds;
    this.#sayCushion(session, encodedTo);
    const disagrees =
      Number.isFinite(claimed) && Math.abs(claimed - encodedTo) > LOOKAHEAD_PAUSE_SECONDS;
    const disagreementSince = this.#lookAheadDisagreementSince.get(session) ?? 0;
    if (disagrees && !disagreementSince) {
      this.#lookAheadDisagreementSince.set(session, Date.now());
      this.#host.logger.info(
        `transcode ${session.id} ffmpeg claims ${Math.round(claimed)}s processed ` +
          `but the viewer's own run of segments ends at ${Math.round(encodedTo)}s`
      );
    } else if (!disagrees && disagreementSince) {
      const lastedMs = Date.now() - disagreementSince;
      this.#lookAheadDisagreementSince.delete(session);
      this.#host.logger.info(
        `transcode ${session.id} ffmpeg's position and the segments on disk agree again ` +
          `after ${(lastedMs / 1000).toFixed(1)}s (ready through ${Math.round(encodedTo)}s)`
      );
    }

  }

  /**
   * What the cushion actually is, said once every half minute per session.
   *
   * Three quantities that were never printed together, and could not be
   * reconstructed afterwards from anything that was:
   *
   *   - how far the produced range runs ahead of the EARLIEST viewer's picture,
   *     which is the protection an interruption would have to exhaust before
   *     anybody saw it;
   *   - what that costs the person hosting this proxy, in megabytes of film
   *     pulled off the swarm ahead of the picture — the read window sits on top
   *     of it, so this is a floor;
   *   - what the browsers say they are holding, so the depth asked for on that
   *     side can be checked against the depth that arrived.
   *
   * Every term is measured: the produced range comes from the segments on disk,
   * the picture from the viewers' own reports, and the byte rate from the
   * file's length over its duration. Roadmap item 4.
   *
   * @param {HlsSession} session
   * @param {number} encodedTo - Seconds of film produced, contiguously, from
   *   where the leading viewer is.
   * @returns {void}
   */
  #sayCushion(session, encodedTo) {
    const now = Date.now();
    if (now - (this.#lastSaidAt.get(session) ?? 0) < CUSHION_REPORT_MS) {
      return;
    }
    const { earliestPosition, deepestBuffer, viewers } = this.#reportedPictureOf(session, now);
    // Nobody has said where they are, so there is no picture to measure
    // against and the line would be about nothing.
    if (earliestPosition === null) {
      return;
    }
    this.#lastSaidAt.set(session, now);
    const aheadOfPicture = Math.max(0, encodedTo - earliestPosition);
    const fileLength = this.#host.hostLoad.fileLengthByKey.get(session.file.key);
    const duration = Number(session.file.durationSeconds) || Number(session.file.durationSeconds) || 0;
    const megabytes =
      Number.isFinite(fileLength) && fileLength > 0 && duration > 0
        ? ((aheadOfPicture * fileLength) / duration / 1e6).toFixed(0)
        : "?";
    this.#host.logger.info(
      `transcode ${session.id.slice(0, 8)} cushion: ${Math.round(aheadOfPicture)}s of film ready ` +
        `ahead of the picture at ${Math.round(earliestPosition)}s (~${megabytes}MB pulled ahead), ` +
        `${viewers} viewer(s) holding up to ` +
        `${deepestBuffer === null ? "?" : deepestBuffer.toFixed(1)}s`
    );
    this.#fetchSpareSoundtracks(session, aheadOfPicture);
  }

  /**
   * Fetch the soundtracks that ship beside this picture, whole, while the swarm
   * has capacity to spare.
   *
   * WHY IT WAITS FOR THE CUSHION. A soundtrack nobody has chosen is worth having
   * on disk — it is a twentieth of the picture (30 MB against 566 MB on the
   * field torrent) and having it makes every later switch instant instead of
   * paying for its first pieces. But fetching it takes swarm capacity from the
   * picture, and there is exactly one moment when that capacity is demonstrably
   * spare: when the encoder is already as far ahead of the viewer as it is
   * allowed to get. That is not a guess about the swarm — it is the measurement
   * the line above just printed.
   *
   * WHY IT IS A READ AND NOT A SELECTION. `file.select()` claims every piece of
   * a file at once, and `#syncSelections` in `torrent/torrent-pool.js` records what that
   * cost when it was done alongside the readers' own windows: a claim covering
   * everything always outranked the window, and a seek to 89.1% of a 4.7 GB film
   * waited 93 s while the swarm fetched 2.47 GB in file order. So this goes
   * through the same bounded read the edge warm-up uses, which claims a moving
   * window like any other reader and gives it back when it ends.
   *
   * Once per file, and only for a soundtrack in a file of its own — the
   * picture's own tracks are already in the bytes being played.
   *
   * @param {HlsSession} session
   * @param {number} aheadOfPicture - Seconds of film ready ahead of the viewer.
   * @returns {void}
   */
  #fetchSpareSoundtracks(session, aheadOfPicture) {
    if (typeof this.#host.fetchWholeFile !== "function") {
      return;
    }
    // The encoder is held at this distance and no further, so reaching it is the
    // signal that nothing more is being asked of the swarm on the picture's
    // behalf.
    if (!(aheadOfPicture >= this.#host.lookaheadSeconds)) {
      return;
    }
    const inventory = this.#host.getCachedAudioTracks?.({
      sourceKey: session.file.sourceKey,
      fileIndex: session.file.fileIndex
    }) ?? [];
    const wanted = new Set(
      inventory
        .filter((entry) => entry?.kind === "sidecar" && Number.isInteger(entry.fileIndex))
        .map((entry) => entry.fileIndex)
    );
    for (const fileIndex of wanted) {
      const key = this.#host.SourceFiles.keyFor(session.file.sourceKey, fileIndex);
      if (this.#spareSoundtracksFetched.has(key)) {
        continue;
      }
      this.#spareSoundtracksFetched.add(key);
      this.#host.logger.info(
        `transcode ${session.id.slice(0, 8)} the picture is ${Math.round(aheadOfPicture)}s ahead of ` +
          `the viewer, so file ${fileIndex} — a soundtrack beside it — is fetched whole now; ` +
          "a switch to it will not wait for the swarm"
      );
      // Not awaited: nothing depends on it finishing, and a failure costs only
      // that the switch pays for its own pieces, as it did before this existed.
      Promise.resolve(this.#host.fetchWholeFile({ sourceKey: session.file.sourceKey, fileIndex })).catch(
        (error) => {
          this.#host.logger.info(
            `transcode: fetching soundtrack file ${fileIndex} whole failed ` +
              `(${error instanceof Error ? error.message : String(error)}) — ` +
              "it will be read when it is played"
          );
        }
      );
    }
  }

  /**
   * Seconds of playback ready without a gap, starting at the segment the viewer
   * is on.
   *
   * Null when that very segment is missing — which is not "zero ahead" but
   * "the viewer is waiting", and the two call for opposite decisions.
   *
   * @param {HlsSession} session
   * @param {number} viewerSegment
   * @returns {{ seconds: number, lastCovered: number, total: number } | null}
   */
  #contiguousAheadSeconds(session, viewerSegment) {
    let present;
    try {
      present = new Set(this.#host.producedNumbers(session));
    } catch {
      return null;
    }
    const lastCovered = contiguousEnd(present, viewerSegment);
    if (lastCovered === null) {
      return null;
    }
    const from = this.#host.outputTimes.segmentStartTime(session, viewerSegment);
    const to = this.#host.outputTimes.segmentStartTime(session, lastCovered + 1);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      return null;
    }
    return { seconds: Math.max(0, to - from), lastCovered, total: present.size };
  }

  /**
   * Where the earliest viewer's picture is, and the deepest cushion any of them
   * reports holding — both read from the link reports, both null when nobody
   * has said recently.
   *
   * @param {HlsSession} session
   * @param {number} now
   * @returns {{ earliestPosition: number | null, deepestBuffer: number | null, viewers: number }}
   */
  #reportedPictureOf(session, now) {
    let earliestPosition = null;
    let deepestBuffer = null;
    let viewers = 0;
    // A session that has never had a link report is the ordinary state at a
    // cold open, and the answer for it is the same as for one whose reports
    // have all gone stale: nobody has said where they are.
    for (const report of this.#host.linkReportsOn(session)) {
      if (now - report.at > NET_REPORT_FRESH_MS) {
        continue;
      }
      viewers += 1;
      if (Number.isFinite(report.positionSeconds)) {
        earliestPosition =
          earliestPosition === null
            ? report.positionSeconds
            : Math.min(earliestPosition, report.positionSeconds);
      }
      if (Number.isFinite(report.bufferedAheadSec)) {
        deepestBuffer =
          deepestBuffer === null
            ? report.bufferedAheadSec
            : Math.max(deepestBuffer, report.bufferedAheadSec);
      }
    }
    return { earliestPosition, deepestBuffer, viewers };
  }
}
