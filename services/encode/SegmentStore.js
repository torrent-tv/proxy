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
 * **What proves a segment is closed.** On the `hls` output branch ffmpeg
 * renames a temporary file into place, so a file that exists is complete. On
 * the `segment` branch — every copied picture and every rung forced onto the
 * source's keyframes — it does not, and a file appears and grows. So the rule
 * this store applies to the disk is the one the serving path has always used:
 * **a segment is closed when the NEXT number exists.** The highest number in a
 * directory is therefore the only unproven one, which is exactly the file a run
 * killed mid-write leaves behind.
 *
 * **A live run does not need that rule.** While this process is alive the
 * coverage map is told what has been closed as it happens; the disk rule is for
 * what a previous life left behind, and for a run that died without saying so.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { discardOpenPiece } from "./open-piece.js";

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

  /**
   * Numbers known closed for a reason other than a successor on the disk.
   *
   * Two things fill it. A live run says what it has finished as it finishes it.
   * And adoption records what the successor rule proved BEFORE it removes the
   * unproven piece — otherwise removing that piece would un-prove the segment
   * below it, which is a file that was demonstrably closed a moment earlier.
   *
   * @type {Map<string, Set<number>>}
   */
  #closed = new Map();

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
    const empty = { readAt: 0, byNumber: new Map(), bytes: 0, unproven: -1 };
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
      }
    } catch {
      this.#held.delete(key);
      return empty;
    }
    const contents = { readAt: mtime, byNumber, bytes, unproven: highest };
    this.#held.set(key, contents);
    return contents;
  }

  /**
   * The segment numbers this output holds that are PROVEN closed.
   *
   * The proof is the successor: a segment ffmpeg has moved past is finished,
   * whatever branch wrote it. The highest number is left out, because nothing
   * on the disk distinguishes a finished last segment from one that was being
   * written when its run died.
   *
   * @param {string} key
   * @returns {number[]}
   */
  provenNumbers(key) {
    const contents = this.refresh(key);
    const stated = this.#closed.get(key);
    const proven = [];
    for (const index of contents.byNumber.keys()) {
      if (contents.byNumber.has(index + 1) || stated?.has(index)) {
        proven.push(index);
      }
    }
    return proven.sort((left, right) => left - right);
  }

  /**
   * A run is about to write these numbers again: forget that they were closed.
   *
   * A number closed once is not closed for ever. An encoder started at #N
   * rewrites #N and everything after it, and while it is doing so the file
   * under that name is half a segment — but the store remembered the earlier
   * closing and would call it whole. Field 2026-09-05: seventeen runs were
   * stopped and none ended normally, so numbers were being rewritten
   * constantly, and the player met a fatal append error it never recovered
   * from — an empty picture for the six minutes that followed.
   *
   * @param {string} key
   * @param {number} from
   */
  forgetClosedFrom(key, from) {
    const known = this.#closed.get(key);
    if (!known || !Number.isInteger(from)) {
      return;
    }
    for (const index of known) {
      if (index >= from) {
        known.delete(index);
      }
    }
    // What the directory says has to be read again too: the successor rule
    // would otherwise prove the rewritten piece from a file made before it.
    this.#held.delete(key);
  }

  /**
   * Whether this piece is finished, and may therefore be served.
   *
   * Two proofs, and the first is the good one:
   *
   * 1. **the encoder said so** — it names each file on a channel of its own the
   *    moment it closes it, so the name is the writer's own statement that the
   *    piece is whole;
   * 2. **the next file exists** — which only proves it for pieces this process
   *    did not watch being written, left by an earlier life of it. It is not
   *    true of the last piece of any run, and that is what used to hold the
   *    first segment of every run from the viewer.
   *
   * @param {string} key
   * @param {number} index
   * @returns {boolean}
   */
  isClosed(key, index) {
    if (this.#closed.get(key)?.has(index)) {
      return true;
    }
    return this.refresh(key).byNumber.has(index + 1);
  }

  /**
   * Say that a segment is closed for a reason the disk cannot show.
   *
   * A run reports what it has finished; the successor rule is only for what
   * this process did not watch being written.
   *
   * @param {string} key
   * @param {number} index
   */
  markClosed(key, index) {
    if (!Number.isInteger(index) || index < 0) {
      return;
    }
    let known = this.#closed.get(key);
    if (!known) {
      known = new Set();
      this.#closed.set(key, known);
    }
    known.add(index);
  }

  /**
   * Throw away the piece a run had open when it ended, if it is unusable.
   *
   * The store owns this output's directory and knows how its files are named,
   * so it is the one place that can answer which file a run left open. The
   * judging of a NON-EMPTY file — does it carry every track it should — needs
   * the output's init bytes and belongs to whoever holds them; passed in, and
   * absent it only an empty file is removed, which is the case that caused this
   * to be written (a run stopped 548 ms after starting left a zero-byte file
   * whose name then read as a segment made).
   *
   * @param {string} key
   * @param {{ from: number, to: number } | null} within - The run's own
   *   numbers: several runs write into one directory, so the piece to discard
   *   has to be looked for inside the stretch the ended run was given.
   * @param {((raw: Buffer) => boolean) | null} [judgeUsable]
   * @returns {Promise<number | null>} The segment number removed, or null.
   */
  async discardOpenPieceOf(key, within, judgeUsable = null) {
    const format = this.#formats.get(key);
    if (!format) {
      return null;
    }
    const removed = await discardOpenPiece(this.directoryFor(key), format, within, judgeUsable);
    if (removed !== null) {
      this.#held.delete(key);
      this.#logger?.info?.(
        `segment store: discarded the open piece #${removed} of ${key.slice(0, 60)}`
      );
    }
    return removed;
  }

  /**
   * The one number in this output whose closure nothing on disk proves.
   *
   * @param {string} key
   * @returns {number} -1 when the directory holds no segments.
   */
  unprovenNumber(key) {
    return this.refresh(key).unproven;
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
    this.#closed.delete(key);
    this.#logger.info(`segment-store dropped ${directoryNameFor(key)} (${because})`);
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
   * @param {object} params
   * @param {number} params.idleMs - Untouched for longer than this, and it goes.
   * @param {number} params.maxBytes - The most the whole store may hold. What
   *   was read longest ago goes first.
   * @returns {{ droppedIdle: number, droppedForRoom: number, bytes: number }}
   */
  enforce({ idleMs, maxBytes }) {
    const now = this.#now();
    let droppedIdle = 0;
    for (const [key, touchedAt] of [...this.#touched]) {
      if (now - touchedAt > idleMs) {
        this.drop(key, `nothing has read it for ${Math.round((now - touchedAt) / 60000)} minutes`);
        droppedIdle += 1;
      }
    }
    let droppedForRoom = 0;
    let held = this.stats().bytes;
    if (Number.isFinite(maxBytes) && maxBytes > 0 && held > maxBytes) {
      // Least recently read first: what nobody has asked for in the longest
      // time is what a viewer is least likely to want next.
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
    }
    return { droppedIdle, droppedForRoom, bytes: held };
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
      // Recorded BEFORE the unproven piece goes: taking that file away would
      // otherwise leave the segment below it without a successor, and a file
      // that was demonstrably closed a moment ago would stop being servable.
      for (const index of this.provenNumbers(entry.key)) {
        this.markClosed(entry.key, index);
      }
      const unproven = this.unprovenNumber(entry.key);
      if (unproven >= 0) {
        const held = this.refresh(entry.key);
        const filePath = held.byNumber.get(unproven);
        if (filePath) {
          try {
            rmSync(filePath, { force: true });
            unprovenRemoved += 1;
          } catch {
            // Then it stays unproven and is simply never served.
          }
        }
        this.#held.delete(entry.key);
      }
      adopted += 1;
      this.#logger.info(
        `segment-store adopted ${path.basename(entry.dir)}: ${this.provenNumbers(entry.key).length} ` +
        `segments a killed process had already made, ${unproven >= 0 ? "1" : "no"} unfinished piece removed`
      );
    }
    return { adopted, dropped, unprovenRemoved };
  }
}
