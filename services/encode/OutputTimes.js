/**
 * Where each segment of an output begins in the film, and how the cut table is
 * corrected from what the encoder actually produced.
 *
 * The published grid is what the playlist told the player; a run's landing and
 * the true start of each piece are what ffmpeg did. The two are compared here,
 * a disagreement is said, and a boundary the index got wrong is corrected once
 * for every output of the file.
 */

import { segmentIndexForTime } from "./output/playlists.js";
import { publishedGridFor as publishedGridOf, publishedStartTime } from "./run-command.js";
import { liveRunsOf } from "./encode-run-state.js";
// How many produced segments' true start times to remember, so a player's
// report about one of them can be answered. Two hundred is about twenty
// minutes of playback at these segment lengths — far more than the recent past
// a stall report can be about, and small enough to be free.
const TRUE_START_MEMORY = 200;
// How far a segment's own recorded start may sit from the one the playlist
// assigned it before the disagreement is worth a log line. The two are built
// from the same keyframe index and normally match to the sample; a quarter of a
// second is below any drift a viewer could notice, so anything above it is the
// index being wrong about where a keyframe is rather than rounding.
const SEGMENT_START_DISAGREEMENT_SEC = 0.25;
/**
 * How far a fragment may land from where the playlist put it before the player
 * stops recognising it as buffered.
 *
 * hls.js's own `maxBufferHole`, whose default is 0.5 s: a gap smaller than this
 * is skipped, a gap larger is a hole, and a fragment appended across one is
 * judged not to have loaded — so the player asks for it again, and again.
 * Taken from the player's published default rather than chosen here.
 */
export const PLAYER_BUFFER_HOLE_SEC = 0.5;
/**
 * A live run of this session that begins exactly at this number, if there is
 * one.
 *
 * @param {object[] | Set<object>} runs
 * @param {number} index
 * @returns {object | null}
 */
function runStartingAt(runs, index) {
  return liveRunsOf(runs).find((run) => run.from === index) ?? null;
}

/**
 * How far the live boundary table has moved from the one the player holds, said
 * in words.
 *
 * The corrections are applied one boundary at a time and each is small enough
 * to look harmless; what nobody was watching is the total. It matters because a
 * run positioned on one table and cut on the other carries their difference into
 * every cut it makes — the fault of 2026-08-21, where the distance reached two
 * whole segments after one seek and four after the next. Printed beside each
 * correction so the total is visible while it is still small.
 *
 * @param {number[]} published - The table the playlist text was written from.
 * @param {number[]} live - The table corrected from produced segments.
 * @returns {string} A phrase, always readable, never throwing on odd input.
 */
export function describeGridDrift(published, live) {
  if (!Array.isArray(published) || !Array.isArray(live) || published.length === 0) {
    return "not comparable";
  }
  if (published.length !== live.length) {
    return `a different length (${published.length} against ${live.length})`;
  }
  let apart = 0;
  let worst = 0;
  let worstAt = -1;
  for (let index = 0; index < published.length; index += 1) {
    // Rounded to the millisecond BEFORE comparing, not only before printing.
    // Two boundaries moved by the same amount differ in the last bits of a
    // double, so an unrounded comparison picks between them by an accident
    // invisible in the printed figure — and the line would name a boundary the
    // reader cannot tell apart from the one before it. Rounded, ties keep the
    // earliest, which is also the one worth looking at first.
    const distance = Math.round(Math.abs(live[index] - published[index]) * 1000) / 1000;
    if (distance <= 0.001) {
      continue;
    }
    apart += 1;
    if (distance > worst) {
      worst = distance;
      worstAt = index;
    }
  }
  if (apart === 0) {
    return "identical";
  }
  return `${apart} of ${published.length} boundaries apart, worst ${worst.toFixed(3)}s at #${worstAt}`;
}

export class OutputTimes {
  #state = new WeakMap();
  /** What this reads and asks of the rest of the proxy, and nothing else. @type {object} */
  #host;

  /**
   * @param {object} host - `logger`, `runsOf`, `stopEncodeRun`, `planEncodersSoon`, `outputs`, `segmentDurationSec`
   */
  constructor(host) {
    this.#host = host;
  }

  #stateFor(output) {
    let state = this.#state.get(output);
    if (!state) {
      state = {
        stampWarnedAt: new Map(),
        landingReportedForRun: undefined,
        trueStartByIndex: new Map(),
        deviationWarnedAt: new Map()
      };
      this.#state.set(output, state);
    }
    return state;
  }

  trueStartAt(output, index) {
    return this.#stateFor(output).trueStartByIndex.get(index);
  }

  /**
   * Start time (seconds, 0-based) of segment `index`, from the session's
   * boundary table. Clamped to valid range.
   *
   * @param {HlsSession} session
   * @param {number} index
   * @returns {number}
   */
  segmentStartTime(session, index) {
    // The LIVE table, deliberately: this is where the file is cut now, which is
    // a different question from what the player was told. The published table
    // is passed as absent so that one arithmetic serves both.
    return publishedStartTime({ boundaries: session.timeline.boundaries }, index, this.#host.segmentDurationSec);
  }

  /**
   * The boundary table the player is working from: the one its playlist was
   * written from, falling back to the live table when no playlist was built
   * from a table at all (no duration, so no synthetic playlist — and then
   * nothing the player holds contradicts it).
   *
   * @param {HlsSession} session
   * @returns {number[]}
   */
  publishedGridFor(session) {
    return publishedGridOf(session.timeline);
  }

  /**
   * Where a run beginning at `index` must be positioned: the time the PLAYER
   * was told that segment starts at.
   *
   * Public because it is the invariant this class has broken twice, and a
   * private one cannot be pinned by a test. It must always be the table the cut
   * list is taken from — see the comment where a run is started.
   *
   * @param {HlsSession} session
   * @param {number} index
   * @returns {number}
   */
  runStartTimeFor(session, index) {
    return this.publishedStartTime(session, index);
  }

  publishedStartTime(session, index) {
    return publishedStartTime(session.timeline, index, this.#host.segmentDurationSec);
  }

  /**
   * Report a segment whose own timeline disagrees with the playlist by more
   * than a player will bridge.
   *
   * Once per segment per five seconds, like every other repeating condition
   * here: the same segment is requested again and again while it is refused,
   * and a line each time buries the first one.
   *
   * @param {HlsSession} session
   * @param {number} index
   * @param {number} trueStart
   * @param {number} publishedStart
   * @returns {void}
   */
  notePlaylistDisagreement(session, index, trueStart, publishedStart) {
    // Within what the player bridges it is no disagreement worth a line.
    if (!(Math.abs(trueStart - publishedStart) > PLAYER_BUFFER_HOLE_SEC)) {
      return;
    }
    const now = Date.now();
    const state = this.#stateFor(session);
    if (now - (state.stampWarnedAt.get(index) ?? 0) < 5_000) {
      return;
    }
    state.stampWarnedAt.set(index, now);
    this.#host.logger.warn(
      `transcode ${session.id} segment #${index} carries ${trueStart.toFixed(3)}s while the playlist ` +
      `the player holds says ${publishedStart.toFixed(3)}s — a gap of ` +
      `${Math.abs(trueStart - publishedStart).toFixed(3)}s, beyond the ${PLAYER_BUFFER_HOLE_SEC}s a player ` +
      "bridges; stamping it where the playlist says so the fragment lands where it was asked for"
    );
  }

  /**
   * Segment index whose span contains time `t` (0-based), via the boundary
   * table.
   *
   * @param {HlsSession} session
   * @param {number} t
   * @returns {number}
   */
  segmentIndexForTime(session, t) {
    // The player's grid, for the same reason the cut list uses it: the time
    // being resolved came from the playlist the player holds, so the index it
    // means is the index that playlist gives it.
    return segmentIndexForTime(this.publishedGridFor(session), t, this.#host.segmentDurationSec);
  }

  /**
   * Where the run REALLY began, against where it was asked to begin.
   *
   * The first piece a run produces is the only statement of this that exists,
   * and until now nothing compared the two. They disagree whenever the seek
   * lands somewhere other than the time asked for — which, before the landing
   * offset, was every run on a Matroska source with B-frames, by exactly one
   * keyframe interval. Every cut of the run then inherits it, because
   * `-segment_times` is measured from the landing.
   *
   * Said once per run, and only when it matters: within what a player bridges
   * there is nothing to report.
   *
   * @param {HlsSession} session
   * @param {number} index
   * @param {number} trueStart
   * @returns {void}
   */
  noteRunLanding(session, index, trueStart) {
    const state = this.#stateFor(session);
    if (runStartingAt(this.#host.runsOf(session), index) === null || state.landingReportedForRun === index) {
      return;
    }
    state.landingReportedForRun = index;
    // What the run was ASKED for, taken from the run itself rather than looked
    // up again in a table. The two used to be the same lookup; they stopped
    // being so when a run began positioning on the published grid while this
    // read the live one, which made a perfect landing report a drift equal to
    // the distance between the tables — and cancelled a real landing error of
    // the same size to zero. A run also has one legitimate position that is in
    // no table at all: the realignment that starts the sound where the copied
    // picture truly begins.
    const asked = runStartingAt(this.#host.runsOf(session), index)?.progress?.startPositionSeconds ??
      this.runStartTimeFor(session, index);
    const drift = trueStart - asked;
    if (!Number.isFinite(drift) || Math.abs(drift) <= PLAYER_BUFFER_HOLE_SEC) {
      return;
    }
    this.#host.logger.warn(
      `transcode ${session.id} run began at ${trueStart.toFixed(3)}s but was asked for ` +
      `${asked.toFixed(3)}s — ${drift > 0 ? "+" : ""}${drift.toFixed(3)}s, and every cut of this ` +
      "run is measured from where it began, so the whole run is that far from its playlist"
    );
  }

  noteIndexAccuracy(session, index, trueStart, declaredStart) {
    const deviation = Math.abs(trueStart - declaredStart);
    // Where each produced segment truly began, kept so that a player reporting
    // a stall can be ANSWERED rather than merely believed. Bounded: only the
    // recent past can be the subject of such a report, and an unbounded map on
    // a two-hour film is a leak.
    const state = this.#stateFor(session);
    state.trueStartByIndex.set(index, trueStart);
    if (state.trueStartByIndex.size > TRUE_START_MEMORY) {
      const oldest = state.trueStartByIndex.keys().next();
      if (!oldest.done) {
        state.trueStartByIndex.delete(oldest.value);
      }
    }
    // ONE READING, AND WHOSE FACT IT IS DEPENDS ON HOW THIS OUTPUT IS MADE. The
    // three branches below already say the distinction when they WARN; until
    // 2026-09-15 what they COUNTED threw it away, into a tally held per (file,
    // grid) that a picture and the soundtrack inside the same file share.
    //
    // Only a COPY can say anything about the file: it is cut at a keyframe of
    // that file and nowhere else. So a copy's landing goes to the file's own
    // table, where it outlives this grid and reaches every step and every later
    // session of the file.
    if (session.spec.carries !== "audio-only" && !session.spec.transcodesVideo) {
      session.keyframes?.witness({
        index,
        trueStart,
        deviationSec: deviation,
        toleranceSec: SEGMENT_START_DISAGREEMENT_SEC
      });
    }
    // And every output records its own landing against its own published grid,
    // which is what says whether a step will splice and how far a soundtrack
    // stands from the picture.
    session.output?.noteLanding({ index, deviationSec: deviation, toleranceSec: SEGMENT_START_DISAGREEMENT_SEC });
    if (deviation > SEGMENT_START_DISAGREEMENT_SEC) {
      // Which boundary the true start DOES match, if any. This is what tells
      // the two possible faults apart, and they need opposite fixes: matching
      // boundary #N-1 means our numbering is shifted by one — a fault in this
      // code, where the run begins — while matching nothing means the container
      // index describes times the file does not have. Measured 2026-08-11,
      // three samples all matched N-1, which is why the line now says so
      // instead of leaving it to be inferred from the numbers.
      const at = this.boundaryIndexAt(session, trueStart);
      // Once per segment per five seconds, like `#notePlaylistDisagreement`
      // beside it. The same segment is produced and served again and again
      // while it is refused, and — since a run keeps cutting on the list it was
      // launched with — a soundtrack whose grid has moved under it deviates on
      // EVERY segment for the life of that run. A line each time buries the
      // first one, which is the one somebody is reading the log for.
      const state = this.#stateFor(session);
      const lastWarnedAt = state.deviationWarnedAt.get(index) ?? 0;
      if (Date.now() - lastWarnedAt >= 5_000) {
        state.deviationWarnedAt.set(index, Date.now());
        this.#host.logger.warn(
        `transcode ${session.id} segment #${index} really starts at ` +
        `${trueStart.toFixed(3)}s (boundary ${at === null ? "none" : `#${at}`}), ` +
        `the grid says ${declaredStart.toFixed(3)}s — ` +
        (session.spec.carries === "audio-only"
          // A soundtrack is cut exactly where it was asked to be, so a
          // disagreement here is not a reading about the file at all: it is the
          // distance between this run's own cuts and a grid the picture has
          // since corrected under it. Said plainly, because the same sentence
          // used to claim a keyframe index was wrong when no keyframe was
          // involved on this side of the stream.
          ? "sound is cut where it is asked to be; this is the picture's grid having moved, not the index"
          : session.spec.transcodesVideo
            // A re-encode was TOLD to put a keyframe here and did not, so this
            // rung's segments no longer stand where the stream it accompanies
            // would have put them. That is a broken splice, not a wrong index.
            ? "this rung did not cut where its grid says; a switch to it will not join cleanly"
            // A copy. The two possible faults need opposite fixes and the
            // numbers already tell them apart, so the sentence follows THEM
            // rather than the branch it is printed from. Until 2026-08-21 it
            // blamed the index either way — including through a session whose
            // segments each held the boundary two, then four places before
            // their own number, which is this code's own definition of a fault
            // in this code. That sentence is what sent the reading of that
            // session after the file instead of after the arithmetic.
            : at === null
              ? "the container's keyframe index disagrees with the file; using the file"
              : `this began at another boundary of the same list, ${index - at} place(s) before ` +
                "its own number — the numbering of this run is shifted, not the index")
        );
      }
    }
    // Said as the evidence accumulates, not only when the session is disposed.
    // A proxy restart takes its sessions with it — every addon update does —
    // and a summary that only ever appears at the end is a summary that is
    // routinely never written. Twenty-five distinct boundaries is enough for
    // the proportion to mean something and rare enough not to repeat itself.
    const counted = session.output?.piecesLanded ?? 0;
    if (counted > 0 && counted % 25 === 0) {
      this.logIndexAccuracy(session);
    }
    this.correctBoundaryFromSegment(session, index, trueStart);
  }

  /**
   * Replace a boundary the index got wrong with the time the file actually has.
   *
   * The grid of a copied stream comes from the container's keyframe index,
   * because a copy can only be cut where a keyframe already is and nothing
   * cheaper than the index can say where that is before a single byte is
   * encoded. An index can be wrong — proven 2026-08-12 by reproducing both
   * cases against the same file: with an honest index every produced segment
   * started exactly where declared, and with one moved 1.8 s the segments
   * started 1.8 s early, matching no boundary at all. The field showed the
   * second shape.
   *
   * The truth arrives anyway, one segment at a time: a produced piece states
   * where it really begins. Writing it back makes the grid describe the file
   * instead of the index — and it is what lets a re-encoded rung be cut to
   * match a copied one, because the rung is then forced onto times the copy
   * really uses. The alternative considered and rejected was to stop offering
   * quality on files with a bad index, which is not a fix but a withdrawal.
   *
   * The whole family shares one grid, so a correction reaches all of it: a rung
   * created afterwards inherits a table that is true wherever anyone has looked.
   *
   * @param {HlsSession} session
   * @param {number} index
   * @param {number} trueStart
   * @returns {void}
   */
  correctBoundaryFromSegment(session, index, trueStart) {
    // Only the picture may move the grid, because the grid IS the picture's
    // cut list: it is built from the container's keyframe index, and a copied
    // stream can be cut nowhere else. A soundtrack has no keyframes — it is cut
    // exactly where `-segment_times` asks, to within one audio frame — so its
    // reading measures nothing about the grid and everything about itself.
    //
    // Writing it into the shared table is how one film ended up with two
    // answers for one boundary, each side correctly describing its own stream
    // and each overwriting the other: field 2026-08-20, segment #521 of
    // "Minions.and.Monsters.1080p.mkv" corrected 2086.084s → 2084.082s by the
    // picture at 11:14:16.939 and 2084.082s → 2086.033s by the sound 1.6s
    // later — 1.951s apart, against the 0.25s that stops a correction and the
    // 0.5s a player bridges. The next reading disagrees with the table again,
    // so it never converges and never stops.
    if (session.spec.carries === "audio-only") {
      return;
    }
    const boundaries = session.timeline.boundaries;
    if (!Array.isArray(boundaries) || index <= 0 || index >= boundaries.length - 1) {
      // Index 0 is the start of the file and the last entry is its end; neither
      // is a cut, and neither can be learned from a segment.
      return;
    }
    if (Math.abs(boundaries[index] - trueStart) <= SEGMENT_START_DISAGREEMENT_SEC) {
      return;
    }
    // A correction that would put this boundary at or past its neighbours is not
    // a correction — it is a reading from a run that started somewhere else, and
    // applying it would make the table describe nothing at all.
    if (trueStart <= boundaries[index - 1] || trueStart >= boundaries[index + 1]) {
      return;
    }
    const wasAt = boundaries[index];
    // One write, because there is one table. Where a file is cut is a fact
    // about the FILE, so every session of it holds the same array rather than a
    // copy of it — which is what this loop used to keep in step, member by
    // member, and only for members that happened to exist at the time. A
    // session created afterwards used to inherit a copy taken at that moment;
    // now it is handed the table itself.
    boundaries[index] = trueStart;
    this.#host.logger.info(
      `transcode ${session.id} boundary #${index} corrected ${wasAt.toFixed(3)}s → ` +
      `${trueStart.toFixed(3)}s from the file itself` +
      `, and the live table is now ${describeGridDrift(this.publishedGridFor(session), boundaries)}` +
      " from the one the player holds"
    );
    // And every OTHER member whose run begins at this very boundary is moved
    // to the same instant.
    //
    // Why they were not there already: the two branches are asked for the same
    // time and land in different places. The picture cannot begin anywhere but
    // a real keyframe, and it may not begin before the time asked for — that
    // content belongs to the previous segment — so it moves FORWARD to the next
    // one, by up to the keyframe spacing (0.58-2.96 s measured 2026-08-17).
    // A soundtrack has no keyframes: it begins exactly where asked, to within
    // one audio frame. So after every restart the two runs of one film began up
    // to three seconds apart, each correctly labelled with where it really was,
    // and the viewer got sound with no new picture for the difference.
    //
    // The picture's true start is a MEASURED quantity — read from the piece it
    // just produced, which is what the correction above is — so the soundtrack
    // can be put exactly there instead of at the time the container's table
    // claimed. It converges: once the boundary holds the true time, the next
    // reading agrees with it and the guard above returns before doing anything.
    for (const member of this.#host.outputs.familyOf(session)) {
      if (member === session || runStartingAt(this.#host.runsOf(member), index) === null) {
        continue;
      }
      this.#host.logger.info(
        `transcode ${member.id} begins at #${index}, which really starts ` +
        `${(trueStart - wasAt).toFixed(3)}s later than the table said — restarting it there ` +
        `so picture and sound begin together`
      );
      // STOPPED, and its replacement is the plan's to place. What has been
      // learned here is that this run is producing at the wrong instant, which
      // nothing but the piece it produced could say — the plan reasons about
      // numbers and cannot know it. So the fact is acted on where it is known,
      // and only as far as it is known: the run that is wrong goes, the stretch
      // it held returns to the map, and where the next one stands follows from
      // where the viewers are.
      //
      // The corrected instant reaches that replacement through the live table,
      // which this function has just written it into and which every session of
      // the file shares. It used to be passed as an argument from here, so only
      // a run started by this line ever had it.
      this.#host.stopEncodeRun(member, `#${index} really begins ${(trueStart - wasAt).toFixed(3)}s later than the table said`);
    }
    this.#host.planEncodersSoon();
  }

  /**
   * The boundary a time falls on, or null when it falls on none of them.
   *
   * Within the same tolerance a disagreement is judged by, so "matches boundary
   * #N-1" and "matches nothing" mean what they say.
   *
   * @param {HlsSession} session
   * @param {number} seconds
   * @returns {number | null}
   */
  boundaryIndexAt(session, seconds, table) {
    // The table is nameable because the two answer different questions. The
    // LIVE one says "is this a cut this file actually has", which is what a
    // reading taken off a produced segment is about. The PUBLISHED one says "is
    // this a cut the player believes in", which is what a report from the player
    // is about. Answering one with the other prints an index from one grid
    // beside a time from the other.
    const boundaries = Array.isArray(table) ? table : session.timeline.boundaries;
    if (!Array.isArray(boundaries)) {
      return null;
    }
    for (let index = 0; index < boundaries.length; index += 1) {
      if (Math.abs(boundaries[index] - seconds) <= SEGMENT_START_DISAGREEMENT_SEC) {
        return index;
      }
    }
    return null;
  }

  /**
   * Where this output's pieces have been landing, and — where this output is a
   * copy — what that has shown about the FILE's own keyframe table.
   *
   * TWO LINES, because they are two facts with two owners and two lifetimes.
   * The landing is this output's and dies with it. The table's accuracy belongs
   * to the file, is learned only from a copy, and is the same finding for every
   * step and every later session of that file — so it names the file and not
   * the session, and it is written only by the output that can witness it.
   *
   * Written even when nothing disagreed, because that is the finding: with only
   * the per-piece warning, silence could not be told from nobody having
   * watched. Skipped where nothing was produced, which says neither.
   *
   * @param {HlsSession} session
   * @returns {void}
   */
  logIndexAccuracy(session) {
    const copiedPicture = session.spec.carries !== "audio-only" && !session.spec.transcodesVideo;
    const landing = session.output?.landing ?? null;
    if (landing) {
      this.#host.logger.info(
        // The session id, because without it this line cannot be attributed. A
        // family produces one of these per member — the picture, each step,
        // each soundtrack — and on 2026-08-17 the picture's was read as the
        // sound's, from a neighbouring log line, and a roadmap item was written
        // against the wrong half of the stream.
        `landing ${session.id.slice(0, 8)} ` +
        `${session.spec.carries === "audio-only" ? "sound" : copiedPicture ? "copied picture" : "re-encoded picture"} ` +
        `"${session.file.name}": ${landing.disagreed} of ${landing.checked} produced pieces started ` +
        `away from this output's own playlist, median ${landing.medianDeviationSec.toFixed(3)}s ` +
        `worst ${landing.maxDeviationSec.toFixed(3)}s` +
        (landing.firstDisagreementIndex >= 0 ? ` (first at #${landing.firstDisagreementIndex})` : "") +
        ` [tolerance ${SEGMENT_START_DISAGREEMENT_SEC}s] — ` +
        (session.spec.carries === "audio-only"
          // A soundtrack is cut exactly where it is asked to be, so this is not
          // a reading about any keyframe: it is how far this run's cuts stand
          // from a grid the picture has corrected under it.
          ? "sound is cut where it is asked to be, so this is the picture's grid having moved"
          : copiedPicture
            // A copy cannot be cut anywhere but a real keyframe, so this figure
            // is also evidence about the file, reported on the line below.
            ? "a copy is cut at the file's own keyframes, so this is also evidence about its table"
            // A re-encode was TOLD to put a keyframe at each of these instants.
            : "this rung was told where to cut; what it missed will not splice cleanly")
      );
    }
    if (!copiedPicture) {
      return;
    }
    const evidence = session.keyframes?.evidence ?? null;
    if (!evidence) {
      return;
    }
    this.#host.logger.info(
      // Named by the FILE, with no session id in it, because that is what it is
      // about: the same answer for every step and every viewer of these bytes.
      `keyframe-index ${session.keyframes?.format ?? "unknown"} "${session.file.name}": ` +
      `${evidence.disagreed} of ${evidence.checked} copied pieces began away from the table, ` +
      `median ${evidence.medianDeviationSec.toFixed(3)}s worst ${evidence.maxDeviationSec.toFixed(3)}s` +
      (evidence.firstDisagreementIndex >= 0 ? ` (first at #${evidence.firstDisagreementIndex})` : "") +
      // The discriminator, stated in the same line as the count it explains: a
      // piece that began at another time the SAME table names was not
      // mis-described by the table — the grid was built over a gap in it.
      `; ${evidence.landedOnAnotherKeyframe} of them began at another keyframe the table names` +
      ` [tolerance ${SEGMENT_START_DISAGREEMENT_SEC}s, ${session.keyframes?.count ?? 0} keyframes read]`
    );
  }
}
