/**
 * @file Reading the subtitle cues a file already holds, and the plan of its
 * subtitle tracks.
 *
 * It walks ONLY what is downloaded: switching subtitles on must never pull
 * bytes the viewer is not waiting for. The head and the Cues table are the one
 * exception and are fetched — they are kilobytes, they are needed before
 * anything can be offered — and they are read by the file's ONE container, the
 * one `ContainerOrchestrator` keeps. This file used to build a second container
 * of its own over the same file and read both again; when its read of the Cues
 * table had not arrived it kept "no clusters" for the life of the process, and
 * an embedded track showed nothing for a whole session
 * (`research/subtitles-never-appear-2026-10-01.md`).
 *
 * **A plan is kept only once it has been read.** While the bytes it needs have
 * not arrived the plan is "not ready": nothing is kept, the walk does nothing,
 * and the next pass — on the next arrival of pieces — reads again.
 *
 * **The torrent is not here, and that is the point.** This layer is handed a
 * `HeldFile`: a name, a length, the file's container, which ranges are
 * downloaded whole, how to read one of them without fetching, the portion a
 * read may span, and where the viewers stand. Piece length, file offsets and
 * the bitfield are the torrent's words and stay in the torrent's thread.
 *
 * What is genuinely this file's own: the found-order cursor a browser follows,
 * the per-file state, one walk of a file at a time, and taking back the cues of
 * a cluster the container withdraws.
 */

import { TextSubtitleTrack } from "./tracks/TextSubtitleTrack.js";
import { detectLanguage } from "./tracks/language-detect.js";
import { isUnavailable, strictReader } from "./container/unavailable.js";
import { logger } from "../../utils/logger.js";

/**
 * One file of one torrent, as much of it as this layer is allowed to know.
 *
 * @typedef {object} HeldFile
 * @property {string} sourceKey
 * @property {number} fileIndex
 * @property {string} name
 * @property {number} length
 * @property {() => Promise<import("./container/Container.js").Container | null>} container -
 *   The file's one container. Throws `BytesUnavailable` while its head has not
 *   arrived; null where the bytes are no format this proxy knows.
 * @property {() => Promise<Array<[number, number]>>} heldRanges - Ascending,
 *   non-overlapping, inclusive offsets within the file.
 * @property {(start: number, end: number) => Promise<Buffer | null>} readHeld -
 *   Null where those bytes are not there, which is never fetched.
 * @property {number} [portionBytes] - The largest read one step may make.
 * @property {() => number[]} [wantedSeconds] - Where viewers stand, in seconds.
 * @property {() => void} [askAgain] - Run the walk again: said when a pass left
 *   readable clusters for the next one, so they are read without waiting for
 *   another arrival of pieces — the file may be downloaded whole.
 */

/** How often one file's walk says what it has done, at most. */
const WALK_REPORT_INTERVAL_MS = 60_000;

/**
 * Whether a range falls entirely inside one of the held runs.
 *
 * @param {Array<[number, number]> | null} ranges
 * @param {number} start
 * @param {number} end - Inclusive.
 * @returns {boolean}
 */
function rangeHolds(ranges, start, end) {
  if (!Array.isArray(ranges) || !(end >= start)) {
    return false;
  }
  for (const [from, to] of ranges) {
    if (start >= from && end <= to) {
      return true;
    }
  }
  return false;
}

/** @type {Map<string, object>} */
const byFile = new Map();

/**
 * The subtitle plan of a file, read once it can be.
 *
 * @param {HeldFile} source
 * @param {string} key - `sourceKey:fileIndex`.
 * @returns {Promise<object | null>} Null while the plan's bytes have not
 *   arrived — "not ready", not "no subtitles".
 */
async function planFor(source, key) {
  const state = stateFor(key);
  if (state.plan !== null) {
    return state.plan;
  }
  // The head and the Cues table are reads that DO wait on the swarm, so two
  // callers arriving together would both make them. One promise, awaited by
  // whoever asks while it is in flight.
  if (!state.planPromise) {
    state.planPromise = readPlan(source, state)
      .catch((error) => {
        if (!isUnavailable(error)) {
          throw error;
        }
        if (!state.waitingSaid) {
          state.waitingSaid = true;
          logger.info(
            `subtitles: the plan of "${String(source.name).slice(0, 40)}" waits for its bytes ` +
              `(${error.message}); read again when pieces arrive`
          );
        }
        return null;
      })
      .finally(() => {
        state.planPromise = null;
      });
  }
  return state.planPromise;
}

/**
 * The state kept for one file, created on first use.
 *
 * @param {string} key - `sourceKey:fileIndex`.
 * @returns {object}
 */
function stateFor(key) {
  let state = byFile.get(key);
  // A state that has been forgotten is not handed out again, even in the moment
  // between the call and the walk that was still running finishing.
  if (state?.forgotten === true) {
    state = undefined;
  }
  if (!state) {
    state = {
      plan: null,
      planPromise: null,
      waitingSaid: false,
      forgotten: false,
      // One walk of a file at a time — see `serialize`.
      chain: Promise.resolve(),
      // What the container has read of this file between passes. Each
      // container keeps its own part under its own name.
      progress: {},
      cues: new Map(),
      seq: new Map(),
      // The found-order cursor of the last cue PUSHED for each track, so a
      // second warmup pass sends only what a first one did not.
      pushed: new Map(),
      // Cues taken back since the last push, by track: their found-order
      // numbers, which is how a browser names the cues it holds.
      withdrawn: new Map(),
      // The tracks whose container-default language the text was seen to
      // contradict — said once each.
      disagreementSaid: new Set(),
      lastReportMs: 0,
      lastStats: null
    };
    byFile.set(key, state);
  }
  return state;
}

/**
 * Run `work` after every walk of this file already started, and before any
 * started after it.
 *
 * Both entry points here — a browser's own pull and the warmup that runs ahead
 * of it — mark a cluster as walked only AFTER reading and parsing it, which is
 * several suspension points later; without one walk at a time, two calls
 * arriving in between read and parsed the same cluster and could push the
 * same line twice under different `seq` numbers.
 *
 * @template T
 * @param {object} state
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
function serialize(state, work) {
  const run = state.chain.then(work, work);
  // The queue must survive a failed walk, so what is chained is the settled
  // form; the caller still sees the rejection.
  state.chain = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Read one file's subtitle plan — the tracks it declares and where the cues
 * holding them are. Throws `BytesUnavailable` while those bytes are not here.
 *
 * @param {HeldFile} source
 * @param {object} state
 * @returns {Promise<object>}
 */
async function readPlan(source, state) {
  // `declared` is what the container itself says about its subtitle tracks, in
  // its own order. Empty means the container said nothing — which is a real
  // answer and not a missing one.
  const empty = { tracks: [], declared: [], secondsPerTick: 0.001, segmentDataOffset: 0 };
  if (!source || !(Number(source.length) > 0) || typeof source.container !== "function") {
    state.plan = empty;
    return state.plan;
  }
  const container = await source.container();
  if (!container) {
    // The bytes were read and are no format this proxy knows.
    state.plan = empty;
    return state.plan;
  }
  const plan = await container.readSubtitlePlan();
  state.container = container;
  state.plan = plan ?? empty;
  if (state.plan.tracks.length > 0) {
    logger.info(
      `subtitles: "${String(source.name).slice(0, 40)}" has ${state.plan.tracks.length} text track(s) ` +
      `of ${state.plan.declared.length} declared` +
      (state.plan.cuesState ? `, Cues ${state.plan.cuesState}` : "") +
      " — " +
      state.plan.tracks
        // `s:N` is the number the browser names (ffmpeg's own), and it differs
        // from the file's track number whenever a picture track sits among them.
        .map((track) => `s:${track.declaredIndex}=${track.trackNumber}:${track.language || "?"}` +
          `${track.languageSource === "default" ? "(default)" : ""}` +
          `${track.name ? `/${track.name}` : ""}(${(track.clusterPositions ?? track.samples ?? []).length} indexed)`)
        .join(" ")
    );
  }
  return state.plan;
}

/**
 * The order a cue was FOUND in, which is the only cursor a browser can follow.
 *
 * A cue's TIME cannot serve as one. Cues are harvested out of whichever
 * clusters happen to be downloaded, and those are not contiguous, so the set
 * grows in the middle as well as at the end. Found-order is monotonic by
 * construction, so `?since=<n>` is exact however the file arrives.
 *
 * @param {{ seq: Map<number, number> }} state
 * @param {number} trackNumber
 * @returns {number}
 */
function nextSeq(state, trackNumber) {
  const next = (state.seq.get(trackNumber) ?? 0) + 1;
  state.seq.set(trackNumber, next);
  return next;
}

/**
 * What may be read on this pass: the held ranges taken once, a strict read of
 * them, the portion a read may span, and where the viewers stand.
 *
 * @param {HeldFile} source
 * @returns {Promise<import("./container/Container.js").HeldReader>}
 */
async function heldReaderOf(source) {
  const ranges = await source.heldRanges();
  const last = Number(source.length) - 1;
  // Each read hands the loop back before the walk goes on. The answer comes from
  // the torrent's thread, which replies faster than this thread empties its
  // message port, and without the turn the port takes reply after reply in one
  // go: measured on the addon host 2026-10-01, timers then fired 8-12 ms late
  // at the 99th percentile during a walk, against 2-5 ms with it and 0-3 ms
  // with no walk at all.
  const read = strictReader(async (start, end) => {
    try {
      return await source.readHeld(start, Math.min(end, last));
    } finally {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }, Number(source.length));
  // Read again between clusters, so a pass can stop when a viewer has moved.
  const wantedSeconds = () => {
    try {
      const stated = source.wantedSeconds?.();
      return Array.isArray(stated) ? stated.filter((value) => Number.isFinite(value)) : [];
    } catch {
      return [];
    }
  };
  return {
    ranges,
    isHeld: (start, end) => rangeHolds(ranges, start, Math.min(end, last)),
    read,
    portionBytes: Number.isFinite(source.portionBytes) && source.portionBytes > 0 ? source.portionBytes : Number.POSITIVE_INFINITY,
    wantedSeconds
  };
}

/**
 * Every cue of one track that can be read from what is already downloaded.
 *
 * @param {HeldFile} source
 * @param {number} trackNumber
 * @returns {Promise<{ cues: object[], coveredClusters: number, indexedClusters: number, track: object | null }>}
 */
export async function cuesHeldFor(source, trackNumber) {
  const key = `${source.sourceKey}:${source.fileIndex}`;
  // A source that cannot say which of itself is downloaded makes every range
  // read as "not there", so the walk reads nothing and returns an empty list —
  // which is also what a file with no cues yet returns, and that is how this
  // went unnoticed for a session (2026-09-03). It is not repairable here, so it
  // is said rather than swallowed.
  if (typeof source.heldRanges !== "function" || typeof source.readHeld !== "function") {
    logger.warn(
      `subtitles: asked for cues of "${String(source.name ?? key).slice(0, 40)}" ` +
      "on a source that cannot say which of it is downloaded — no cluster can be read, " +
      "and the answer would be an empty document indistinguishable from a file with no cues"
    );
    return { cues: [], coveredClusters: 0, indexedClusters: 0, track: null };
  }
  const plan = await planFor(source, key);
  const state = stateFor(key);
  const track = plan?.tracks?.find((candidate) => candidate.trackNumber === trackNumber) ?? null;
  if (!track) {
    return { cues: [], coveredClusters: 0, indexedClusters: 0, track: null };
  }
  return serialize(state, () => walkFor(source, state, plan, track, trackNumber));
}

/**
 * The walk itself. Only ever entered through `cuesHeldFor`, which is what keeps
 * one file to one walk at a time.
 *
 * @param {HeldFile} source
 * @param {object} state
 * @param {object} plan
 * @param {object} track
 * @param {number} trackNumber
 * @returns {Promise<{ cues: object[], coveredClusters: number, indexedClusters: number, track: object | null }>}
 */
async function walkFor(source, state, plan, track, trackNumber) {
  const container = state.container;
  if (!container) {
    return { cues: [], coveredClusters: 0, indexedClusters: 0, track };
  }
  // Taken once per pass: pieces keep arriving, and what may be read now is a
  // different list from what could be read when the plan was built.
  const held = await heldReaderOf(source);
  const { found, covered, indexed, withdrawn, more, stats } = await container.readHeldCues(plan, track, state.progress, held);
  if (more) {
    // Readable clusters were left for the next pass — the ones viewers stand in
    // were read first and are pushed now. Asked for here, and not by a timer:
    // nothing else would run the walk again on a file downloaded whole.
    source.askAgain?.();
  }

  for (const at of withdrawn ?? []) {
    takeBack(state, at);
  }
  for (const [number, cues] of found) {
    let into = state.cues.get(number);
    if (!into) {
      into = [];
      state.cues.set(number, into);
    }
    for (const cue of cues) {
      into.push({ ...cue, seq: nextSeq(state, number) });
    }
    into.sort((left, right) => left.startSeconds - right.startSeconds);
  }
  reportWalk(source, state, stats, covered, indexed);

  return {
    cues: state.cues.get(trackNumber) ?? [],
    coveredClusters: covered,
    indexedClusters: indexed,
    track
  };
}

/**
 * Take back every cue read from one position the container has withdrawn.
 *
 * @param {object} state
 * @param {number} at
 * @returns {void}
 */
function takeBack(state, at) {
  for (const [number, cues] of state.cues) {
    const kept = [];
    for (const cue of cues) {
      if (cue.source === at) {
        const list = state.withdrawn.get(number) ?? [];
        list.push(cue.seq);
        state.withdrawn.set(number, list);
      } else {
        kept.push(cue);
      }
    }
    state.cues.set(number, kept);
  }
}

/**
 * One line per file at most once a minute: what the walk has read, how, and
 * what it could not.
 *
 * @param {HeldFile} source
 * @param {object} state
 * @param {object | undefined} stats
 * @param {number} covered
 * @param {number} indexed
 * @returns {void}
 */
function reportWalk(source, state, stats, covered, indexed) {
  if (!stats) {
    return;
  }
  const now = Date.now();
  const summary = JSON.stringify({ covered, indexed, ...stats });
  if (summary === state.lastStats || now - state.lastReportMs < WALK_REPORT_INTERVAL_MS) {
    return;
  }
  state.lastStats = summary;
  state.lastReportMs = now;
  logger.info(
    `subtitles: walk of "${String(source.name).slice(0, 40)}" — ${covered} of ${indexed} known cluster(s) read, ` +
      `${stats.fromSearch ?? 0} found by searching the bytes, ${stats.rejectedCandidates ?? 0} candidate(s) refused, ` +
      `${stats.pendingCandidates ?? 0} waiting for bytes, ${stats.contradictions ?? 0} withdrawn, ` +
      `${stats.unreadable ?? 0} unreadable, ${stats.refusedElements ?? 0} block(s) over one read, ` +
      `${Math.round((stats.bytesWalked ?? 0) / 1048576)}MB read`
  );
}

/**
 * Walk whatever clusters have newly arrived, for every text track a file
 * carries, and report what is new since the last call — so the cues can be
 * PUSHED to a browser rather than left for it to come back and ask.
 *
 * Only for a file somebody has asked about: its plan, its tracks or its cues.
 * A file of the torrent nobody has opened costs nothing, and its head and Cues
 * table are not fetched for this.
 *
 * @param {HeldFile} source
 * @returns {Promise<{ trackIndex: number, cues: object[], withdrawn: number[], language: string }[]>}
 *   One entry per track that gained or lost a cue since the last call.
 *   `trackIndex` is `declaredIndex` — ffmpeg's `0:s:N`, the only number the
 *   browser knows.
 */
export async function warmSubtitleCues(source) {
  const key = `${source.sourceKey}:${source.fileIndex}`;
  if (!byFile.has(key) || byFile.get(key).forgotten === true) {
    return [];
  }
  const plan = await planFor(source, key);
  const state = stateFor(key);
  const fresh = [];
  const tracks = plan?.tracks ?? [];
  for (let order = 0; order < tracks.length; order += 1) {
    const track = tracks[order];
    const held = await cuesHeldFor(source, track.trackNumber);
    const since = state.pushed.get(track.trackNumber) ?? 0;
    const newCues = held.cues.filter((cue) => (Number(cue.seq) || 0) > since);
    const withdrawn = state.withdrawn.get(track.trackNumber) ?? [];
    state.withdrawn.delete(track.trackNumber);
    if (newCues.length === 0 && withdrawn.length === 0) {
      continue;
    }
    const highest = newCues.reduce((max, cue) => Math.max(max, Number(cue.seq) || 0), since);
    state.pushed.set(track.trackNumber, highest);
    const codecId = held.track?.codecId ?? track.codecId;
    const cues = TextSubtitleTrack.finalizeCues(newCues, codecId);
    const entry = {
      // ffmpeg's own numbering, which is the only one the browser knows.
      trackIndex: Number.isInteger(track.declaredIndex) ? track.declaredIndex : order,
      cues,
      withdrawn,
      language: held.track?.language ?? "",
      // What the CUES say the language is, re-read on every push over every cue
      // held so far. Used by the browser only where the container states none.
      detectedLanguage: detectLanguage(
        TextSubtitleTrack.finalizeCues(held.cues, codecId).map((cue) => cue.text).join("\n")
      ),
      // Where the browser should resume from if it has to ask again — after a
      // reconnect, which loses the subscription these pushes ride on.
      cursor: highest,
      spanStartSeconds: cues.length > 0 ? cues[0].startSeconds : null,
      spanEndSeconds: cues.length > 0 ? cues[cues.length - 1].endSeconds : null,
      walkedClusters: held.coveredClusters ?? 0,
      indexedClusters: held.indexedClusters ?? 0
    };
    noteDisagreement(source, state, track, entry.detectedLanguage);
    fresh.push(entry);
  }
  return fresh;
}

/**
 * Say once when the text reads as another language than the format's default
 * the container fell back to.
 *
 * The label does not move: RFC 8794 §11.1.19 makes the default the file's own
 * statement. A disagreement is a muxer that left the element out for a track
 * that is not English, and this line is what counts how often that happens.
 *
 * @param {HeldFile} source
 * @param {object} state
 * @param {object} track
 * @param {{ code: string } | null} detected
 * @returns {void}
 */
function noteDisagreement(source, state, track, detected) {
  if (track.languageSource !== "default" || !detected?.code || state.disagreementSaid.has(track.trackNumber)) {
    return;
  }
  const stated = String(track.language || "").toLowerCase();
  const read = String(detected.code).toLowerCase();
  if (stated === read || stated.startsWith(`${read}-`) || (stated === "eng" && read === "en")) {
    return;
  }
  state.disagreementSaid.add(track.trackNumber);
  logger.info(
    `subtitles: "${String(source.name).slice(0, 40)}" track ${track.trackNumber} has no Language element, ` +
      `so the file states ${track.language} by default, and its text reads as ${detected.code}`
  );
}

/**
 * The text subtitle tracks of a file, for the menu the viewer sees.
 *
 * @param {HeldFile} source
 * @returns {Promise<object[]>} Empty while the plan's bytes have not arrived.
 */
export async function subtitleTracksOf(source) {
  const plan = await planFor(source, `${source.sourceKey}:${source.fileIndex}`);
  return (plan?.tracks ?? []).map((track, order) => ({
    trackNumber: track.trackNumber,
    declaredIndex: Number.isInteger(track.declaredIndex) ? track.declaredIndex : order,
    codecId: track.codecId,
    language: track.language,
    languageSource: track.languageSource ?? "",
    name: track.name,
    isDefault: track.isDefault,
    indexedClusters: (track.clusterPositions ?? track.samples ?? []).length
  }));
}

/**
 * What the container itself says about its subtitle tracks, in its own order
 * and including the picture-based ones — lined up against ffmpeg's `0:s:N`.
 *
 * @param {HeldFile} source
 * @returns {Promise<object[]>}
 */
export async function declaredSubtitleTracksOf(source) {
  const plan = await planFor(source, `${source.sourceKey}:${source.fileIndex}`);
  return plan?.declared ?? [];
}

/**
 * Forget a file's cues — the torrent is gone, and holding them would keep the
 * text of a film nobody is watching.
 *
 * @param {string} sourceKey
 * @param {number} [fileIndex]
 * @returns {void}
 */
export function forgetSubtitles(sourceKey, fileIndex) {
  if (fileIndex === undefined) {
    for (const key of [...byFile.keys()]) {
      if (key.startsWith(`${sourceKey}:`)) {
        forgetOne(key);
      }
    }
    return;
  }
  forgetOne(`${sourceKey}:${fileIndex}`);
}

/**
 * Drop one file's state, but not while a walk of it is still running.
 *
 * @param {string} key
 * @returns {void}
 */
function forgetOne(key) {
  const state = byFile.get(key);
  if (!state) {
    return;
  }
  state.forgotten = true;
  void state.chain.then(() => {
    if (byFile.get(key) === state) {
      byFile.delete(key);
    }
  }, () => {
    if (byFile.get(key) === state) {
      byFile.delete(key);
    }
  });
}
