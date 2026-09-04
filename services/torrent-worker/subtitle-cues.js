/**
 * @file Subtitle cues gathered from the clusters a viewer has already brought
 * in, never from clusters they have not.
 *
 * The rule this file exists to keep (stated by the user 2026-08-20): subtitles
 * arrive the way the picture does, or they are not offered. So nothing here
 * requests a byte. It looks at what the torrent already holds, reads the
 * clusters inside it, and returns what it found; the region the viewer is
 * watching is downloaded before they reach it, so its cues are ready before
 * they are needed. A region nobody has watched has no cues, and that is
 * correct — there is nobody to show them to.
 *
 * Why not ffmpeg: measured 2026-08-19, extracting one subtitle track of
 * `Minions.and.Monsters.1080p.mkv` took **752 seconds** and pulled the download
 * from 2.7 % to 81 % of a 6.5 GB film, because a subtitle stream is sparse and
 * the demuxer walks the container to the end whatever range is asked of it.
 * Reading the clusters costs nothing extra at all.
 */

import { ContainerFactory } from "../container/ContainerFactory.js";
import { TextSubtitleTrack } from "../tracks/TextSubtitleTrack.js";
import { detectLanguage } from "../tracks/language-detect.js";
import { logger } from "../../utils/logger.js";

/** How long a read of already-held bytes may take before it is given up. */
const READ_ABANDON_MS = 30_000;

/** @type {Map<string, { plan: object | null, harvested: Map<number, Set<number>>, cues: Map<number, object[]> }>} */
const byFile = new Map();

/**
 * Whether every piece covering a byte range is already downloaded.
 *
 * @param {object} torrent
 * @param {object} file
 * @param {number} start - Offset within the FILE.
 * @param {number} end - Inclusive.
 * @returns {boolean}
 */
function rangeIsHeld(torrent, file, start, end) {
  const pieceLength = Number(torrent?.pieceLength);
  const offset = Number(file?.offset) || 0;
  if (!Number.isFinite(pieceLength) || pieceLength <= 0 || !torrent?.bitfield) {
    return false;
  }
  const first = Math.floor((offset + start) / pieceLength);
  const last = Math.floor((offset + end) / pieceLength);
  for (let index = first; index <= last; index += 1) {
    if (!torrent.bitfield.get(index)) {
      return false;
    }
  }
  return true;
}

/**
 * Read a byte range of a file straight from the store, without asking the swarm
 * for anything.
 *
 * @param {object} file
 * @param {number} start
 * @param {number} end - Inclusive.
 * @returns {Promise<Buffer | null>}
 */
function readHeld(file, start, end) {
  return new Promise((resolve) => {
    const chunks = [];
    let stream;
    try {
      stream = file.createReadStream({ start, end });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let abandon = null;
    const settle = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (abandon !== null) {
        clearTimeout(abandon);
      }
      if (value === null) {
        stream.destroy?.();
      }
      resolve(value);
    };
    // A read of bytes the torrent already holds either answers or it does not.
    // This is not a measurement of anything and no figure is derived from it:
    // it is the point past which such a read is presumed lost, so that one
    // stream which never ends cannot hold this file's walk — and with it the
    // browser's own request for its subtitles — for the rest of the session.
    abandon = setTimeout(() => {
      logger.info(
        `subtitles: a read of ${start}-${end} in "${String(file.name).slice(0, 40)}" ` +
        `did not finish in ${READ_ABANDON_MS / 1000}s and was given up`
      );
      settle(null);
    }, READ_ABANDON_MS);
    abandon.unref?.();
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => settle(Buffer.concat(chunks)));
    stream.on("error", () => settle(null));
  });
}

/**
 * A container over one file of a torrent, told how to read it.
 *
 * The container is given two readers and a predicate and never the torrent:
 * whether a byte range is already downloaded, how to read one without asking
 * the swarm, and how to read one that may need fetching. That is the whole of
 * what this layer knows and the container does not.
 *
 * WHICH container is decided from the bytes, by the factory's sniff — the
 * header is what the muxer wrote, and a file name is what somebody typed. Only
 * where the head is not downloaded, and so cannot be sniffed without asking the
 * swarm, does the name answer instead. One choice either way: the caller never
 * decides a second time from a track's shape, which is two decisions from
 * different evidence that have to agree.
 *
 * @param {object} state - This file's state; the container is kept on it.
 * @param {object} torrent
 * @param {object} file
 * @returns {Promise<import("../container/Container.js").Container | null>}
 */
async function containerOver(state, torrent, file) {
  if (state.container !== null) {
    return state.container;
  }
  const held = async (start, end) => readHeld(file, start, Math.min(end, file.length - 1));
  const params = {
    readRange: held,
    readHeld: held,
    isHeld: (start, end) => rangeIsHeld(torrent, file, start, Math.min(end, file.length - 1)),
    fileSize: file.length,
    label: String(file.name ?? "")
  };
  const sniffed = await ContainerFactory.create(params);
  if (sniffed) {
    state.container = sniffed;
    return state.container;
  }
  const ByName = ContainerFactory.byName(file.name);
  state.container = ByName ? new ByName(params) : null;
  return state.container;
}

/**
 * The subtitle tracks of a file, read once and kept.
 *
 * The head and the Cues table are two short reads, and they ARE fetched if
 * missing — they are kilobytes, they are needed before anything can be offered,
 * and the codec probe has already pulled the head for every file that plays.
 *
 * @param {object} torrent
 * @param {number} fileIndex
 * @param {string} key - `sourceKey:fileIndex`.
 * @returns {Promise<object | null>}
 */
async function planFor(torrent, fileIndex, key) {
  const state = stateFor(key);
  if (state.plan !== null) {
    return state.plan;
  }
  // The head and the Cues table are two reads that DO wait on the swarm, so two
  // callers arriving together would both make them. One promise, awaited by
  // whoever asks while it is in flight.
  if (!state.planPromise) {
    state.planPromise = readPlan(torrent, fileIndex, state).finally(() => {
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
      forgotten: false,
      // One walk of a file at a time — see `serialize`.
      chain: Promise.resolve(),
      // The container over this file, built once. It caches what it has parsed
      // — a `moov` box is tens of megabytes off a torrent — so building a fresh
      // one per call would throw that away on every request.
      container: null,
      harvested: new Map(),
      cues: new Map(),
      seq: new Map(),
      walked: new Set(),
      // The found-order cursor of the last cue PUSHED for each track, so a
      // second warmup pass sends only what a first one did not — the same
      // found-order idea `?since=` uses for a browser's own pull.
      pushed: new Map()
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
 * two suspension points later. Until 2.56.0 nothing stopped a second call
 * arriving in between: `warmActiveFiles` runs on every verified piece AND on a
 * 3 s timer, so on a fast download the same cluster was read and parsed several
 * times over and the same line could be pushed twice under different `seq`
 * numbers. Each of those reads is a WebTorrent file stream, which selects and
 * deselects its pieces, so the repetition reached the piece picker as well.
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
 * Read one file's subtitle plan — the tracks it declares and where the clusters
 * holding them are. Called once per file; see `planFor`.
 *
 * @param {object} torrent
 * @param {number} fileIndex
 * @param {object} state
 * @returns {Promise<object>}
 */
async function readPlan(torrent, fileIndex, state) {
  const file = torrent?.files?.[fileIndex];
  // `declared` is what the container itself says about its subtitle tracks, in
  // its own order. Empty means the container said nothing — which is a real
  // answer and not a missing one: nothing is then shown unasked. An MP4 has no
  // element that means "show this subtitle track by default", so it declares
  // nothing however many tracks it carries.
  const empty = { tracks: [], declared: [], secondsPerTick: 0.001, segmentDataOffset: 0 };
  if (!file) {
    state.plan = empty;
    return state.plan;
  }
  const container = await containerOver(state, torrent, file);
  if (!container) {
    state.plan = empty;
    return state.plan;
  }
  const plan = await container.readSubtitlePlan();
  state.plan = plan ?? empty;
  if (state.plan.tracks.length > 0) {
    logger.info(
      `subtitles: "${String(file.name).slice(0, 40)}" has ${state.plan.tracks.length} text track(s) ` +
      `of ${state.plan.declared.length} declared — ` +
      state.plan.tracks
        // `s:N` is the number the browser names (ffmpeg's own), and it differs
        // from the file's track number whenever a picture track sits among them.
        .map((track) => `s:${track.declaredIndex}=${track.trackNumber}:${track.language || "?"}` +
          `${track.name ? `/${track.name}` : ""}(${track.clusterPositions.length} indexed)`)
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
 * grows in the middle as well as at the end. A browser that remembered "the
 * latest time I hold" and asked for everything past it would never be sent the
 * cues that turn up BEHIND that mark afterwards — which is exactly the stretch
 * it is about to play. Measured 2026-08-20 on a viewer at 272 s: one answer
 * carried cues out to 1176 s, and from then on every cue between the two was
 * filtered away for the rest of the session, with 59 of 276 clusters read.
 *
 * Found-order is monotonic by construction, so `?since=<n>` is exact however
 * the file arrives.
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
 * Every cue of one track that can be read from what is already downloaded.
 *
 * @param {object} torrent
 * @param {number} fileIndex
 * @param {string} sourceKey
 * @param {number} trackNumber
 * @returns {Promise<{ cues: object[], coveredClusters: number, indexedClusters: number, track: object | null }>}
 */
export async function cuesHeldFor(torrent, fileIndex, sourceKey, trackNumber) {
  const key = `${sourceKey}:${fileIndex}`;
  // A torrent that cannot say which pieces it holds makes every range read as
  // "not downloaded", so the walk reads nothing and returns an empty list —
  // which is also what a file with no cues yet returns, and that is how this
  // went unnoticed for a session (2026-09-03: 283 clusters indexed, 0 walked,
  // the browser served `WEBVTT` and nothing else). The stand-in the main thread
  // holds is exactly such a torrent; only the thread that owns the object has
  // the bitfield. Nothing here can repair that, so it says so instead.
  if (!torrent?.bitfield || !(Number(torrent?.pieceLength) > 0)) {
    logger.warn(
      `subtitles: asked for cues of "${String(torrent?.name ?? sourceKey).slice(0, 40)}" ` +
      "on a torrent that cannot say which pieces it holds — no cluster can be read here, " +
      "and the answer would be an empty document indistinguishable from a file with no cues"
    );
    return { cues: [], coveredClusters: 0, indexedClusters: 0, track: null };
  }
  const plan = await planFor(torrent, fileIndex, key);
  const state = stateFor(key);
  const track = plan?.tracks?.find((candidate) => candidate.trackNumber === trackNumber) ?? null;
  if (!track) {
    return { cues: [], coveredClusters: 0, indexedClusters: 0, track: null };
  }
  return serialize(state, () => walkFor(torrent, fileIndex, state, plan, track, trackNumber));
}

/**
 * The walk itself. Only ever entered through `cuesHeldFor`, which is what keeps
 * one file to one walk at a time.
 *
 * @param {object} torrent
 * @param {number} fileIndex
 * @param {object} state
 * @param {object} plan
 * @param {object} track
 * @param {number} trackNumber
 * @returns {Promise<{ cues: object[], coveredClusters: number, indexedClusters: number, track: object | null }>}
 */
async function walkFor(torrent, fileIndex, state, plan, track, trackNumber) {
  const file = torrent.files[fileIndex];
  const container = await containerOver(state, torrent, file);
  if (!container) {
    return { cues: [], coveredClusters: 0, indexedClusters: 0, track };
  }

  // One question, whichever container this is. Matroska walks the clusters its
  // Cues table names and fills every track from one walk; an MP4 reads the
  // samples its own table states for this track. Nothing here chooses between
  // them, which is the point: the container was chosen once, from the bytes.
  const { found, covered, indexed } = await container.readHeldCues(plan, track, state);

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

  return {
    cues: state.cues.get(trackNumber) ?? [],
    coveredClusters: covered,
    indexedClusters: indexed,
    track
  };
}

/**
 * Walk whatever clusters have newly arrived, for every text track a file
 * carries, and report what is new since the last call — so the cues can be
 * PUSHED to a browser rather than left for it to come back and ask.
 *
 * `cuesHeldFor` already skips positions it has walked before (`state.walked`),
 * so calling this on a timer or on every verified piece is cheap once a file
 * is caught up: the only cost is deciding there is nothing new to read. It is
 * `getSubtitleCues` run ahead of being asked, on the same state that call
 * itself would build — nothing is duplicated, and a file nobody has opened
 * costs nothing beyond this.
 *
 * @param {object} torrent
 * @param {number} fileIndex
 * @param {string} sourceKey
 * @returns {Promise<{ trackIndex: number, cues: object[], language: string }[]>}
 *   One entry per track that gained at least one cue since the last call.
 *   `trackIndex` is `declaredIndex` — the track's position among ALL the file's
 *   subtitle tracks, which is ffmpeg's `0:s:N` and the only number the browser
 *   knows. NOT the container's own track number, and not the position among the
 *   readable tracks either: counting those alone puts every text track after a
 *   picture-based one in the wrong place.
 */
export async function warmSubtitleCues(torrent, fileIndex, sourceKey) {
  const key = `${sourceKey}:${fileIndex}`;
  const plan = await planFor(torrent, fileIndex, key);
  const state = stateFor(key);
  const fresh = [];
  const tracks = plan?.tracks ?? [];
  for (let order = 0; order < tracks.length; order += 1) {
    const track = tracks[order];
    const held = await cuesHeldFor(torrent, fileIndex, sourceKey, track.trackNumber);
    const since = state.pushed.get(track.trackNumber) ?? 0;
    const newCues = held.cues.filter((cue) => (Number(cue.seq) || 0) > since);
    if (newCues.length === 0) {
      continue;
    }
    const highest = newCues.reduce((max, cue) => Math.max(max, Number(cue.seq) || 0), since);
    state.pushed.set(track.trackNumber, highest);
    const codecId = held.track?.codecId ?? track.codecId;
    const cues = TextSubtitleTrack.finalizeCues(newCues, codecId);
    fresh.push({
      // ffmpeg's own numbering, which is the only one the browser knows.
      trackIndex: Number.isInteger(track.declaredIndex) ? track.declaredIndex : order,
      cues,
      language: held.track?.language ?? "",
      // What the CUES say the language is, re-read on every push over every cue
      // held so far rather than over this batch. A track whose container states
      // no language is unreadable at the start of a session — a handful of cues
      // is not a sample of a language, and the detector refuses to answer on one
      // — so the answer has to be re-taken as the film downloads, and the label
      // moved when it arrives. Costs about 6 ms per push, measured; pushes
      // arrive about once a second per file being read.
      detectedLanguage: detectLanguage(
        TextSubtitleTrack.finalizeCues(held.cues, codecId).map((cue) => cue.text).join("\n")
      ),
      // Where the browser should resume from if it has to ask again — after a
      // reconnect, which loses the subscription these pushes ride on.
      cursor: highest,
      // What this batch is ABOUT, in film time, so a log can be read against
      // the position being played.
      spanStartSeconds: cues.length > 0 ? cues[0].startSeconds : null,
      spanEndSeconds: cues.length > 0 ? cues[cues.length - 1].endSeconds : null,
      walkedClusters: held.coveredClusters ?? 0,
      indexedClusters: held.indexedClusters ?? 0
    });
  }
  return fresh;
}

/**
 * The text subtitle tracks of a file, for the menu the viewer sees.
 *
 * @param {object} torrent
 * @param {number} fileIndex
 * @param {string} sourceKey
 * @returns {Promise<object[]>}
 */
export async function subtitleTracksOf(torrent, fileIndex, sourceKey) {
  const plan = await planFor(torrent, fileIndex, `${sourceKey}:${fileIndex}`);
  return (plan?.tracks ?? []).map((track, order) => ({
    trackNumber: track.trackNumber,
    declaredIndex: Number.isInteger(track.declaredIndex) ? track.declaredIndex : order,
    codecId: track.codecId,
    language: track.language,
    name: track.name,
    isDefault: track.isDefault,
    indexedClusters: track.clusterPositions.length
  }));
}

/**
 * What the container itself says about its subtitle tracks, in its own order
 * and including the picture-based ones.
 *
 * Separate from `subtitleTracksOf`, which lists only what can be turned into
 * WebVTT and is indexed by position in the subtitle API. This one exists to be
 * lined up against ffmpeg's `0:s:N` numbering, which counts every subtitle
 * stream, so leaving the picture ones out would shift it.
 *
 * @param {object} torrent
 * @param {number} fileIndex
 * @param {string} sourceKey
 * @returns {Promise<object[]>}
 */
export async function declaredSubtitleTracksOf(torrent, fileIndex, sourceKey) {
  const plan = await planFor(torrent, fileIndex, `${sourceKey}:${fileIndex}`);
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
 * Drop one file's state, but not while a walk of it is still running: the
 * record of which clusters have been read lives in that state, and a walk left
 * writing into a discarded copy while a new one starts beside it is the one
 * path that defeats the serialization above.
 *
 * @param {string} key
 * @returns {void}
 */
function forgetOne(key) {
  const state = byFile.get(key);
  if (!state) {
    return;
  }
  // Held, so that a walk started before this call is not left orphaned; the
  // entry is dropped the moment the queue empties, and nothing is handed this
  // state in the meantime.
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
