/**
 * @file One store of produced segments for the whole proxy, addressed by what
 * the segments ARE rather than by who made them.
 *
 * Until now a segment lived under the id of the session whose encoder wrote it
 * — under that session's own id, in a directory of that run's own — and the index
 * over it was built per session, so a segment was visible only inside the
 * session that made it. Two viewers of one film got two sessions with
 * byte-identical output and neither could see the other's work (measured
 * 2026-09-03, `research/two-viewers-one-file-2026-09-03.md`).
 *
 * Here the address is the output's own parameters. Which viewer asked never
 * enters it, and neither does which encoder produced the bytes: a segment is
 * the same segment whoever made it.
 *
 * **The directory carries its own identity.** Its NAME is a digest, because the
 * key contains characters a path may not; the key itself is written inside it,
 * in `key.txt`. That is what lets a new process, started after this one was
 * killed, work out what it is looking at — without it, everything on disk after
 * a kill is unidentifiable and can only be thrown away.
 *
 * **What proves a segment is closed: its NAME.** A piece being written is called
 * something else — `making-40-00057.mp4`, tagged with the run writing it — and
 * takes its served name only when the
 * encoder has said it is closed, which it does on a channel of its own
 * (`-segment_list pipe:3`). The `hls` branch needs nothing extra: its muxer
 * writes through a temporary name of its own, so its files appear under their
 * final name whole. One rule for both, and true whether or not this process is
 * alive: **a file under its served name is complete.**
 *
 * It was "a segment is closed when the NEXT number exists". That is true of one
 * writer walking forward and false the moment two runs share an output, because
 * the next file is then written by another process while this one is still open
 * — and two runs on one output is not a rare state, it is what the plan gives an
 * output whenever it places a second encoder. Field 2026-09-08:
 * `segment-00057.mp4` served at 2 268 361 bytes and then at 4 510 940, exactly
 * half; the browser appended the half and refused the whole for the rest of the
 * session, `bufferAppendError` fourteen times with the picture frozen at
 * 319.66 s. `segment-00055.mp4` the same, 211 957 against 2 620 617.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Where every output's segments live. One root for the process. */
export const DEFAULT_STORE_ROOT = path.join(os.tmpdir(), "torrent-tv-hls");

/** The file inside each directory that says which output it holds. */
const KEY_FILE = "key.txt";

/**
 * The directory name for an output key.
 *
 * A digest rather than the key itself: the key carries `:` and `/`, which a
 * path may not, and sanitising them would make two different keys collide.
 * Sixteen hex characters is enough that a collision is not a thing that
 * happens, and short enough to read in a log line.
 *
 * @param {string} key
 * @returns {string}
 */
export function directoryNameFor(key) {
  return createHash("sha256").update(String(key)).digest("hex").slice(0, 16);
}

/**
 * What one output's directory holds, as last read.
 *
 * @typedef {object} HeldContents
 * @property {number} readAt - The directory's modification time when it was read.
 * @property {Map<number, string>} byNumber - Segment number to full path.
 * @property {number} bytes - What those files weigh.
 * @property {number} unproven - The highest number, whose closure nothing
 *   proves, or -1 when the directory holds no segments.
 */

export class SegmentStore {
  /** @type {string} */
  #root;

  /** Output key → what its directory holds. @type {Map<string, HeldContents>} */
  #held = new Map();

  /** Output key → how to read its file names. @type {Map<string, object>} */
  #formats = new Map();

  /** Output key → when it was last asked for. @type {Map<string, number>} */
  #touched = new Map();

  /** @type {{ info: Function, warn: Function }} */
  #logger;

  /** @type {() => number} */
  #now;

  /**
   * @param {object} [params]
   * @param {string} [params.root] - Where the directories live.
   * @param {{ info: Function, warn: Function }} [params.logger]
   * @param {() => number} [params.now]
   */
  constructor({ root = DEFAULT_STORE_ROOT, logger = null, now = Date.now } = {}) {
    this.#root = root;
    this.#logger = logger ?? { info: () => {}, warn: () => {} };
    this.#now = now;
  }

  /** @returns {string} */
  get root() {
    return this.#root;
  }

  /**
   * Where this output's segments live, without making anything.
   *
   * Separate from {@link directoryFor} because a session works out its path
   * long before it is sure it will exist: a probe or a keyframe read between
   * the two can still fail, and a directory made in advance of that is a
   * leftover nothing tracks — proxy 2.9.101 failed on every request and its
   * abandoned directories were the only trace on disk.
   *
   * @param {string} key - `OutputSpec.toKey()`.
   * @returns {string}
   */
  pathFor(key) {
    return path.join(this.#root, directoryNameFor(key));
  }

  /**
   * The directory this output's segments live in, made if it is not there.
   *
   * @param {string} key - `OutputSpec.toKey()`.
   * @returns {string}
   */
  directoryFor(key) {
    const dir = path.join(this.#root, directoryNameFor(key));
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      // What this directory is, for whoever finds it after this process has
      // been killed. Without it the sweep can only throw everything away.
      writeFileSync(path.join(dir, KEY_FILE), `${key}\n`, "utf8");
    }
    this.#touched.set(key, this.#now());
    return dir;
  }

  /**
   * Say how this output's files are named, so the store can read its directory.
   *
   * @param {string} key
   * @param {{ isSegmentFileName: (name: string) => boolean, segmentIndexFromName: (name: string) => number }} segmentFormat
   */
  useFormat(key, segmentFormat) {
    if (segmentFormat && typeof segmentFormat.isSegmentFileName === "function") {
      this.#formats.set(key, segmentFormat);
    }
  }

  /**
   * Re-read this output's directory if it has moved since last time.
   *
   * A directory's modification time changes when an entry is added or removed,
   * so a quiet request costs one `stat` rather than a listing.
   *
   * @param {string} key
   * @returns {HeldContents}
   */
  refresh(key) {
    const format = this.#formats.get(key);
    const empty = { readAt: 0, byNumber: new Map(), bytes: 0, unproven: -1, largest: { index: -1, size: 0 } };
    if (!format) {
      return this.#held.get(key) ?? empty;
    }
    const dir = path.join(this.#root, directoryNameFor(key));
    let mtime = 0;
    try {
      mtime = statSync(dir).mtimeMs;
    } catch {
      this.#held.delete(key);
      return empty;
    }
    const known = this.#held.get(key);
    if (known && known.readAt === mtime) {
      return known;
    }
    const byNumber = new Map();
    let bytes = 0;
    let highest = -1;
    // The biggest piece and which number it is. What reads it is the figure the
    // master playlist declares: `BANDWIDTH` is the PEAK a link must carry, and
    // the peak of a variable-bitrate source is nothing like its average — the
    // field file of 2026-09-08 ran at 17.1 Mbit/s with a piece at 73. Which
    // number it is matters because pieces are not all the same length, and only
    // whoever holds the cut table can turn bytes into bits per second.
    let largest = { index: -1, size: 0 };
    try {
      for (const name of readdirSync(dir)) {
        if (!format.isSegmentFileName(name)) {
          continue;
        }
        const index = format.segmentIndexFromName(name);
        if (!Number.isInteger(index) || index < 0) {
          continue;
        }
        const full = path.join(dir, name);
        let size = 0;
        try {
          size = statSync(full).size;
        } catch {
          continue;
        }
        // A file of no bytes is not a segment, whatever its name says. It is
        // what a run killed the instant after opening its next piece leaves,
        // and taking it for a segment once convinced the look-ahead that a
        // number had been produced and kept the encoder stopped for it.
        if (size <= 0) {
          continue;
        }
        byNumber.set(index, full);
        bytes += size;
        if (index > highest) {
          highest = index;
        }
        if (size > largest.size) {
          largest = { index, size };
        }
      }
    } catch {
      this.#held.delete(key);
      return empty;
    }
    const contents = { readAt: mtime, byNumber, bytes, unproven: highest, largest };
    this.#held.set(key, contents);
    return contents;
  }

  /**
   * The segment numbers this output holds that are finished.
   *
   * ONE PROOF, AND IT IS THE PIECE'S OWN NAME. A piece being written is called
   * `making-40-00042.mp4`; it is renamed to `segment-00042.mp4` when its writer
   * says it has closed it, and on the `hls` branch — which has no such channel —
   * the muxer's own `+temp_file` does the same rename for the same reason. So a
   * file under the served name is complete, whoever made it and whenever.
   *
   * WHAT THIS REPLACED, because the difference is what a viewer felt. Closure
   * used to be inferred from the NEXT number existing, which is sound for one
   * writer walking forward and false the moment two runs share an output — and
   * one-piece intervals guarantee that. Field 2026-09-08:
   * `segment-00057.mp4` was served at 2 268 361 bytes and then at 4 510 940, the
   * browser appended the truncated body, and `bufferAppendError` repeated to the
   * end of the log with the picture frozen at 319.66 s. It also left the last
   * piece of every run unprovable for ever, since nothing follows it.
   *
   * @param {string} key
   * @returns {number[]}
   */
  provenNumbers(key) {
    return [...this.refresh(key).byNumber.keys()].sort((left, right) => left - right);
  }

  /**
   * How many numbered files this output holds, closed or not.
   *
   * What the disk has, against what has been proven closed: the two are printed
   * side by side, so "the files are there and nobody reported them" reads
   * differently from "there is nothing there".
   *
   * @param {string} key
   * @returns {number}
   */
  filesHeld(key) {
    return this.refresh(key).byNumber.size;
  }

  /**
   * The biggest piece this output has made, and which number it is.
   *
   * Read by whoever declares the variant's peak rate. Bytes alone cannot say
   * it — pieces are not all the same length — so the number comes with them and
   * whoever holds the cut table does the division.
   *
   * @param {string} key
   * @returns {{ index: number, size: number }} An index of `-1` while nothing
   *   has been made, which is a statement and not a zero.
   */
  largestPiece(key) {
    return this.refresh(key).largest ?? { index: -1, size: 0 };
  }


  /**
   * Whether this piece is finished, and may therefore be served.
   *
   * Its NAME is the proof, and there is no second one: a piece being written is
   * called something else until whoever writes it says it is closed. That holds
   * for a piece a live run is rewriting — the file standing there was closed by
   * somebody, and it is replaced whole or not at all — and for a piece left by an
   * earlier life of this process, which the startup sweep answers the same way.
   *
   * @param {string} key
   * @param {number} index
   * @returns {boolean}
   */
  isClosed(key, index) {
    return this.refresh(key).byNumber.has(index);
  }

  /**
   * Remove the pieces an output was in the middle of writing.
   *
   * They are under working names, so they were never servable and nothing has
   * to be un-proven — this is disk, not correctness. A process killed by the
   * kernel leaves one per live run, and the kernel takes this process often
   * enough for that to matter.
   *
   * @param {string} key
   * @param {string} dir
   * @param {{ makingTagOf?: (name: string) => string | null }} format
   * @param {string | null} [tag] - One run's own tag, or null for every run's.
   * @returns {number} How many were removed.
   */
  #sweepUnfinished(key, dir, format, tag = null) {
    let removed = 0;
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      return 0;
    }
    for (const name of names) {
      const wroteIt = format?.makingTagOf?.(name) ?? null;
      if (wroteIt === null || (tag !== null && wroteIt !== tag)) {
        continue;
      }
      try {
        rmSync(path.join(dir, name), { force: true });
        removed += 1;
      } catch {
        // Then it stays, costing disk and nothing else.
      }
    }
    if (removed > 0) {
      this.#held.delete(key);
    }
    return removed;
  }

  /**
   * The encoder has closed a piece: give it the name it is served under.
   *
   * One rename inside the output's own directory — one filesystem operation, and
   * atomic there. Before it the file is not a segment and no request can reach
   * it; after it, its existence IS the proof that it is whole, and that is one
   * rule for every branch whether or not our own process is alive.
   *
   * It replaced a rule that served half a segment: a piece was taken as finished
   * when the NEXT file existed. That is true of one writer walking forward and
   * false the moment two runs share an output, because the next file is then
   * written by another process while this one is still open — and two runs on one
   * output is not a rare state, it is what the plan gives an output whenever it
   * places a second encoder.
   *
   * Field 2026-09-08: `segment-00057.mp4` was served at 2 268 361 bytes and then
   * at 4 510 940 — exactly half of it. The browser appended the half and refused
   * the whole for the rest of the session, `bufferAppendError` fourteen times
   * over with the picture frozen at 319.66 s. `segment-00055.mp4` went the same
   * way, 211 957 against 2 620 617.
   *
   * @param {string} key
   * @param {string} makingName - What the encoder called it while writing.
   * @param {{ servedNameOf?: (name: string) => string | null }} format
   * @returns {string | null} The served name, or null where nothing was renamed.
   */
  publish(key, makingName, format) {
    const served = format?.servedNameOf?.(makingName) ?? null;
    if (!served) {
      return null;
    }
    const dir = path.join(this.#root, directoryNameFor(key));
    try {
      renameSync(path.join(dir, makingName), path.join(dir, served));
    } catch (error) {
      // The file may already be gone — a process killed between closing the
      // piece and this line. Said rather than swallowed: a piece the encoder
      // reported and the disk does not have is worth knowing about.
      this.#logger?.warn?.(
        `segment store: could not publish ${makingName} of ${key.slice(0, 60)}: ` +
        `${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
    // What the directory holds has changed, so the memory of it is stale.
    this.#held.delete(key);
    return served;
  }

  /**
   * Clear up after a run that has ended: remove what it left unfinished.
   *
   * Every file it left open carries its own tag, so this is a name match and
   * nothing else — no stretch to search, no bytes to judge, and no chance of
   * removing a piece somebody else closed.
   *
   * WHAT IT REPLACED, because the difference is the whole of the rename design.
   * It used to take the highest SERVED name inside the stretch the ended run was
   * given and judge whether its bytes looked usable — a guess, needed only
   * because an unfinished piece was indistinguishable from a finished one. Under
   * the naming rule it would now remove a complete segment: the highest served
   * name in a dead run's stretch is a piece it closed.
   *
   * @param {string} key
   * @param {number} startedAt - The run's first segment number, which is its tag.
   * @returns {number} How many unfinished pieces were removed.
   */
  clearUpAfter(key, startedAt) {
    const format = this.#formats.get(key);
    if (!format) {
      return 0;
    }
    const removed = this.#sweepUnfinished(
      key,
      this.directoryFor(key),
      format,
      String(Number.isInteger(startedAt) && startedAt > 0 ? startedAt : 0)
    );
    if (removed > 0) {
      this.#logger?.info?.(
        `segment store: cleared up ${removed} unfinished piece(s) of the run at ` +
        `#${startedAt} on ${key.slice(0, 60)}`
      );
    }
    return removed;
  }


  /**
   * Where a segment is, or null when this output does not hold it.
   *
   * @param {string} key
   * @param {number} index
   * @returns {string | null}
   */
  pathOf(key, index) {
    this.#touched.set(key, this.#now());
    return this.refresh(key).byNumber.get(index) ?? null;
  }

  /**
   * What every output in the store weighs.
   *
   * @returns {{ outputs: number, bytes: number }}
   */
  stats() {
    let bytes = 0;
    for (const key of this.#formats.keys()) {
      bytes += this.refresh(key).bytes;
    }
    return { outputs: this.#formats.size, bytes };
  }

  /**
   * Throw one output's segments away.
   *
   * @param {string} key
   * @param {string} because
   */
  drop(key, because) {
    const dir = path.join(this.#root, directoryNameFor(key));
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Already gone, or in use; the next sweep sees it either way.
    }
    this.#held.delete(key);
    this.#formats.delete(key);
    this.#touched.delete(key);
    this.#logger.info(`segment-store dropped ${directoryNameFor(key)} (${because})`);
  }

  /**
   * When this output was last asked for, or null where it has never been.
   *
   * The one reading that makes the keeping period measurable rather than
   * guessed: a session opened on an output this answers for IS a return, and
   * this is its age.
   *
   * @param {string} key
   * @returns {number | null}
   */
  lastReadAt(key) {
    return this.#touched.get(key) ?? null;
  }

  /**
   * Throw away everything this store owns, and the root with it.
   *
   * For a clean exit. What is left on disk afterwards is by definition from a
   * kill, which is the case the startup sweep exists for — and without this the
   * sweep adopts, the exit leaves, and the next start adopts again, for ever.
   *
   * @param {string} because
   * @returns {number} How many outputs went.
   */
  dropAll(because) {
    let dropped = 0;
    for (const key of [...this.#formats.keys()]) {
      this.drop(key, because);
      dropped += 1;
    }
    try {
      rmSync(this.#root, { recursive: true, force: true });
    } catch {
      // Another process may share the root and hold a directory open. What is
      // ours is gone either way.
    }
    return dropped;
  }

  /**
   * Keep only what is still being read, and only as much of it as there is room
   * for.
   *
   * **Not tied to a session.** An output is worth keeping while somebody may
   * still ask for it, and a session ending says nothing about that: the viewer
   * who left may come back, and a viewer who never had a session here may open
   * the same film a minute later and find every segment already made. So the
   * only question asked is when this output was last READ, and the only bound
   * is the disk.
   *
   * The idle period is deliberately long. Its job is not to reclaim space —
   * that is the cap's — but to stop an output nobody has touched in hours from
   * sitting there for the life of the process.
   *
   * TWO RULES, ANSWERING TWO QUESTIONS. Kept apart because they were briefly
   * proposed as one and that was wrong: material nobody needs should not sit on
   * the owner's disk merely because there is room for it, and material everyone
   * needs must still go when there is no room. The first is time, the second is
   * space.
   *
   * WHAT GOES FIRST WHEN THERE IS NO ROOM is decided by where the viewers are,
   * not by when a directory was last read. Behind every viewer of an output is
   * material that has been played and will not be asked for again unless
   * somebody seeks back; ahead of the furthest viewer is material that will be
   * asked for, eventually. So the order is: outputs nobody is watching at all,
   * then what lies behind the earliest viewer, furthest behind first, then what
   * lies ahead of the furthest viewer, furthest ahead first. It is the priority
   * map's own order read from the other end.
   *
   * A segment a viewer is standing on is never a victim.
   *
   * @param {object} params
   * @param {number} params.idleMs - Untouched for longer than this, and it goes.
   * @param {number} params.maxBytes - The most the whole store may hold.
   * @param {(key: string) => number[]} [params.viewersAt] - Where the viewers of
   *   an output stand, as segment numbers. An empty answer means nobody is
   *   watching it, which is what makes its segments the first to go. Absent, the
   *   store has nothing to order by and falls back to the oldest directory —
   *   which is what it did before it could be told.
   * @returns {{ droppedIdle: number, droppedForRoom: number, segmentsRemoved: number, bytes: number }}
   */
  enforce({ idleMs, maxBytes, viewersAt = null }) {
    const now = this.#now();
    let droppedIdle = 0;
    for (const [key, touchedAt] of [...this.#touched]) {
      if (now - touchedAt > idleMs) {
        this.drop(key, `nothing has read it for ${Math.round((now - touchedAt) / 60000)} minutes`);
        droppedIdle += 1;
      }
    }
    let held = this.stats().bytes;
    if (!Number.isFinite(maxBytes) || maxBytes <= 0 || held <= maxBytes) {
      return { droppedIdle, droppedForRoom: 0, segmentsRemoved: 0, bytes: held };
    }
    if (typeof viewersAt !== "function") {
      let droppedForRoom = 0;
      const byAge = [...this.#touched.entries()].sort((left, right) => left[1] - right[1]);
      for (const [key] of byAge) {
        if (held <= maxBytes) {
          break;
        }
        const size = this.refresh(key).bytes;
        this.drop(key, `the store is over its ${(maxBytes / 1073741824).toFixed(1)}GB allowance`);
        held -= size;
        droppedForRoom += 1;
      }
      return { droppedIdle, droppedForRoom, segmentsRemoved: 0, bytes: held };
    }

    let segmentsRemoved = 0;
    for (const victim of this.#leastWantedFirst(viewersAt)) {
      if (held <= maxBytes) {
        break;
      }
      held -= this.#removeSegment(victim.key, victim.index);
      segmentsRemoved += 1;
    }
    if (segmentsRemoved > 0) {
      this.#logger.info(
        `segment-store removed ${segmentsRemoved} segment(s) for room: ` +
        `${megabytes(held)} of ${megabytes(maxBytes)} allowed`
      );
    }
    return { droppedIdle, droppedForRoom: 0, segmentsRemoved, bytes: held };
  }

  /**
   * Every segment in the store, least wanted first.
   *
   * @param {(key: string) => number[]} viewersAt
   * @returns {{ key: string, index: number }[]}
   */
  #leastWantedFirst(viewersAt) {
    const candidates = [];
    for (const key of this.#formats.keys()) {
      const positions = (viewersAt(key) ?? []).filter((at) => Number.isInteger(at));
      const earliest = positions.length > 0 ? Math.min(...positions) : null;
      const furthest = positions.length > 0 ? Math.max(...positions) : null;
      for (const index of this.refresh(key).byNumber.keys()) {
        if (earliest === null) {
          // Nobody is watching this output at all. Everything it holds is worth
          // less than anything somebody is on their way to.
          candidates.push({ key, index, rank: 0, distance: index });
          continue;
        }
        if (positions.includes(index)) {
          continue;
        }
        if (index < earliest) {
          candidates.push({ key, index, rank: 1, distance: earliest - index });
        } else {
          candidates.push({ key, index, rank: 2, distance: index - /** @type {number} */ (furthest) });
        }
      }
    }
    return candidates
      .sort((left, right) => (left.rank !== right.rank ? left.rank - right.rank : right.distance - left.distance))
      .map(({ key, index }) => ({ key, index }));
  }

  /**
   * Take one segment off the disk.
   *
   * @param {string} key
   * @param {number} index
   * @returns {number} What it weighed.
   */
  #removeSegment(key, index) {
    const full = this.refresh(key).byNumber.get(index);
    if (!full) {
      return 0;
    }
    let size = 0;
    try {
      size = statSync(full, { throwIfNoEntry: false })?.size ?? 0;
      rmSync(full, { force: true });
    } catch {
      // Gone already, or refused. The next refresh reports what is really there.
    }
    this.#held.delete(key);
    return size;
  }

  /**
   * What a previous life of this process left on the disk.
   *
   * This is the only record there is of a death nobody saw. The kernel kills
   * this process often enough to matter — two kills in one viewing on
   * 2026-09-02 — and when it does, no exit handler runs, nothing is cleared up,
   * and memory is reclaimed while the disk is not: `/tmp` in the addon
   * container is on the overlay filesystem, measured 2026-09-04, so the files
   * survive the process and its restart.
   *
   * So the sweep reports rather than deletes quietly. What it finds is the
   * evidence, and every directory it names is one abnormal ending that went
   * unrecorded.
   *
   * @returns {{ directories: number, segments: number, bytes: number, unidentified: number, found: {key: string, dir: string, segments: number, bytes: number}[] }}
   */
  sweep() {
    const found = [];
    let unidentified = 0;
    let names = [];
    try {
      names = readdirSync(this.#root);
    } catch {
      return { directories: 0, segments: 0, bytes: 0, unidentified: 0, found: [] };
    }
    for (const name of names) {
      const dir = path.join(this.#root, name);
      let key = "";
      try {
        if (!statSync(dir).isDirectory()) {
          continue;
        }
        key = readFileSync(path.join(dir, KEY_FILE), "utf8").trim();
      } catch {
        key = "";
      }
      let segments = 0;
      let bytes = 0;
      try {
        for (const entry of readdirSync(dir)) {
          if (entry === KEY_FILE) {
            continue;
          }
          try {
            bytes += statSync(path.join(dir, entry)).size;
            segments += 1;
          } catch {
            // Vanished between the listing and the question.
          }
        }
      } catch {
        continue;
      }
      if (!key) {
        // A directory that cannot say what it holds is from before this layer,
        // or its key file did not survive. Nothing can be served out of it,
        // because nothing can match it to a request.
        unidentified += 1;
      }
      found.push({ key, dir, segments, bytes });
    }
    const totals = found.reduce(
      (sum, entry) => ({ segments: sum.segments + entry.segments, bytes: sum.bytes + entry.bytes }),
      { segments: 0, bytes: 0 }
    );
    if (found.length > 0) {
      this.#logger.info(
        `segment-store startup sweep: ${found.length} directories left by a previous run, ` +
        `${totals.segments} segments, ${(totals.bytes / 1048576).toFixed(1)}MB, ` +
        `${unidentified} of them unidentifiable — each one is an encoder that ended ` +
        "without anything recording why"
      );
    }
    return {
      directories: found.length,
      segments: totals.segments,
      bytes: totals.bytes,
      unidentified,
      found
    };
  }

  /**
   * Take back what a previous life left: keep what is proven, remove the rest.
   *
   * Deliberately not "throw everything away". A killed process leaves material
   * that is valid by construction — a copied segment's bytes depend only on the
   * source — and re-encoding it costs the machine that is already known to be
   * short of processor. What cannot be kept is a directory that cannot name
   * itself, and the one file per directory whose closure nothing proves.
   *
   * @param {(key: string) => object | null} formatFor - How to read the file
   *   names of an output, given its key. Null when this proxy cannot serve that
   *   output at all, and then the directory goes.
   * @returns {{ adopted: number, dropped: number, unprovenRemoved: number }}
   */
  adoptWhatSurvived(formatFor) {
    const swept = this.sweep();
    let adopted = 0;
    let dropped = 0;
    let unprovenRemoved = 0;
    for (const entry of swept.found) {
      const format = entry.key ? formatFor(entry.key) : null;
      if (!format) {
        try {
          rmSync(entry.dir, { recursive: true, force: true });
        } catch {
          // Leave it; the next sweep reports it again.
        }
        dropped += 1;
        this.#logger.info(
          `segment-store discarded ${path.basename(entry.dir)}: ` +
          (entry.key ? "this proxy cannot serve that output" : "it does not say what it holds")
        );
        continue;
      }
      this.#formats.set(entry.key, format);
      // EVERY SEGMENT FOUND IS COMPLETE, because a piece is given its served
      // name only once the encoder has said it is closed. So there is nothing to
      // prove here and nothing to un-prove: what the directory holds under
      // served names is what a killed process finished.
      //
      // What it may also hold is pieces it was in the middle of, under their
      // working names, and those are swept — the file a run was writing when the
      // kernel took the process is exactly this.
      unprovenRemoved += this.#sweepUnfinished(entry.key, entry.dir, format);
      adopted += 1;
      this.#logger.info(
        `segment-store adopted ${path.basename(entry.dir)}: ${this.provenNumbers(entry.key).length} ` +
        "segments a killed process had already finished"
      );
    }
    return { adopted, dropped, unprovenRemoved };
  }
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function megabytes(bytes) {
  return `${Math.round(Math.max(0, bytes) / (1024 * 1024))}MB`;
}
