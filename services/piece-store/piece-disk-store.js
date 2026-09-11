/**
 * @file Where downloaded pieces live once memory cannot hold them.
 *
 * The second tier of the piece store, and — unlike what it replaces — an owner
 * of what it takes: it knows how many bytes it holds, it is told how many it
 * may hold, and when it is over that it gives disk back.
 *
 * WHAT IT REPLACED, because the difference is the whole of the design. `DiskTier`
 * wrote every piece into ONE sparse file at `index * chunkLength` and answered
 * `forget(index)` by dropping the number from a set. The bytes stayed: a sparse
 * file's blocks are returned only by hole punching, which Node exposes no
 * binding for, so nothing this process could do returned a single block before
 * the whole file was removed. Measured 2026-08-31: a store holding 312-424 MB
 * of pieces had written **14 400 MB** to that file in fifty minutes, and free
 * space on the host fell by every megabyte of it until the session ended. On a
 * Home Assistant install with a 32 GB card that is the card.
 *
 * A PIECE IS A FILE, and that is what makes the ceiling real. Removing a file
 * returns exactly its blocks, needs no binding this runtime lacks, and makes
 * the unit of eviction the same as the unit of storage — so the order pieces
 * leave in is the order we choose rather than the order they happen to lie in.
 * The read that the single file was chosen for is unaffected: it is still one
 * `read` into a buffer the caller already owns, which is what the 22.08 ms →
 * 7.63 ms measurement on the field host was about. What it adds is an `open`
 * per read, tens of microseconds against those milliseconds.
 *
 * Nothing here decides what the allowance should be. It is told, because the
 * disk is one and this store is not its only user — the segments an encoder
 * produces are on it too — and a ceiling that one of two users sets for itself
 * is not a ceiling.
 */

import fs from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * How a removal is asked for.
 *
 * Windows keeps a deleted file's name reserved until the last handle on it is
 * closed, and answers `rm` of the name — or `rmdir` of the directory holding it
 * — with EPERM until then. These are Node's own documented options for exactly
 * that, not a wait invented here; on POSIX they never come into play.
 */
const REMOVAL = { force: true, maxRetries: 10, retryDelay: 20 };

/**
 * One torrent's pieces on disk.
 *
 * Pieces are numbered by the torrent, so a file is named by its number. The
 * directory is the store: nothing else writes into it, and destroying the store
 * removes it whole.
 */
export class PieceDiskStore {
  #directory;

  #chunkLength;

  /** Piece index → its length on disk. @type {Map<number, number>} */
  #stored = new Map();

  /** Piece index → when it was last written or read. @type {Map<number, number>} */
  #touched = new Map();

  /** Pieces being read right now, which eviction leaves alone. @type {Map<number, number>} */
  #reading = new Map();

  /** Removals still in flight, by piece. @type {Map<number, Promise<unknown>>} */
  #removing = new Map();

  /** What this store may hold, or null while nobody has said. @type {number | null} */
  #allowanceBytes = null;

  #evictions = 0;

  /** How many were thrown away for being behind every reader. */
  #behind = 0;

  #bytes = 0;

  #now;

  /** Where the live readers stand, from whoever holds that fact. @type {() => number[]} */
  #readHeads;

  /**
   * @param {object} params
   * @param {string} params.directory - Where this torrent's pieces live.
   * @param {string} params.name - A name unique to the torrent; it becomes the
   *   directory inside `directory`.
   * @param {number} params.chunkLength - The torrent's piece length. Kept for
   *   the caller's arithmetic; a piece's own length is recorded as it is written,
   *   because the last piece of a torrent is shorter.
   * @param {number | null} [params.allowanceBytes] - What it may hold. Null
   *   means nobody has said yet, and nothing is evicted until somebody does.
   * @param {() => number} [params.now]
   */
  constructor({ directory, name, chunkLength, allowanceBytes = null, now = Date.now, readHeads = () => [] }) {
    this.#directory = path.join(directory, name);
    this.#chunkLength = chunkLength;
    this.#allowanceBytes = Number.isFinite(allowanceBytes) && allowanceBytes >= 0 ? allowanceBytes : null;
    this.#now = now;
    this.#readHeads = typeof readHeads === "function" ? readHeads : () => [];
    this.#adoptWhatIsAlreadyHere();
  }

  /**
   * Take up the pieces a previous life of this torrent left in this directory.
   *
   * The directory is the torrent's own, so what is in it belongs to it — and
   * without this, nothing ever reads those files again: a torrent that is torn
   * down and added back gets a store whose index starts empty, answers "not on
   * disk" for every piece it in fact has, and downloads the film a second time
   * while the first copy sits beside it. That is what a torrent destroyed by an
   * error left behind until 2026-09-11, and what the pool's own restart leaves
   * behind every time.
   *
   * Read once, synchronously, because `has()` is answered synchronously and the
   * torrent asks it immediately — a piece reported missing while a scan is
   * still running is a piece fetched again. One directory listing per torrent.
   *
   * Correctness is not taken on trust: the torrent hashes every piece it means
   * to use, so a file here that does not match is refused by the layer above
   * and downloaded again.
   *
   * @returns {void}
   */
  #adoptWhatIsAlreadyHere() {
    let entries = [];
    try {
      entries = readdirSync(this.#directory, { withFileTypes: true });
    } catch {
      // No directory yet: this torrent is new here, which is the ordinary case.
      return;
    }
    const born = this.#now();
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".piece")) {
        continue;
      }
      const index = Number.parseInt(entry.name.slice(0, -".piece".length), 10);
      if (!Number.isInteger(index) || index < 0) {
        continue;
      }
      try {
        const { size } = statSync(path.join(this.#directory, entry.name));
        if (size <= 0) {
          continue;
        }
        this.#stored.set(index, size);
        this.#touched.set(index, born);
        this.#bytes += size;
      } catch {
        // Gone between the listing and the reading: not ours to worry about.
      }
    }
  }

  /** Where this store's pieces live, for logging and cleanup. */
  get path() {
    return this.#directory;
  }

  /** How many pieces are on disk. */
  get size() {
    return this.#stored.size;
  }

  /** What those pieces weigh. */
  get bytes() {
    return this.#bytes;
  }

  /** What it may hold, or null while nobody has said. */
  get allowanceBytes() {
    return this.#allowanceBytes;
  }

  /**
   * Say what it may hold from now on.
   *
   * Lowering it does not free anything by itself: what is already written stays
   * until the next write needs room. A store that is over its allowance and
   * never written to again is holding disk nobody has asked for, which is the
   * same bargain memory makes.
   *
   * @param {number | null} bytes
   * @returns {number | null} What it may hold now.
   */
  reviseAllowance(bytes) {
    this.#allowanceBytes = Number.isFinite(bytes) && bytes >= 0 ? bytes : null;
    return this.#allowanceBytes;
  }

  /**
   * @param {number} index
   * @returns {boolean}
   */
  has(index) {
    return this.#stored.has(index);
  }

  /**
   * Throw away what no reader will ask for again, without waiting for the disk
   * to be short.
   *
   * THE SECOND RULE, and it answers a different question from the ceiling.
   * Material nobody needs should not sit on somebody's disk merely because
   * there is room for it — the ceiling here is a share of what is free, and on
   * a roomy host that is tens of gigabytes against a measured growth of 14 400
   * MB in one viewing, so the ceiling alone never binds and nothing is ever
   * removed until the torrent itself goes.
   *
   * A piece BEHIND every read head has been read and will not be read again
   * unless somebody seeks back — and a seek back re-downloads it, which is the
   * bargain this tier already makes when it drops a piece for room. Nothing is
   * thrown away while any reader might still reach it.
   *
   * With no reader at all nothing is removed: a store between reads is not a
   * store nobody wants, and the torrent going idle is what empties it whole.
   *
   * @param {number[]} readHeads - The first piece each live reader still wants.
   * @returns {number} How many pieces were thrown away.
   */
  forgetBehind(readHeads) {
    const heads = (readHeads ?? []).filter((at) => Number.isInteger(at));
    if (heads.length === 0) {
      return 0;
    }
    const earliest = Math.min(...heads);
    let removed = 0;
    for (const index of [...this.#stored.keys()]) {
      if (index < earliest && !this.#reading.has(index)) {
        this.forget(index);
        this.#behind += 1;
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Write a piece out, making room for it first.
   *
   * @param {number} index
   * @param {Uint8Array} bytes
   * @returns {Promise<void>}
   */
  async write(index, bytes) {
    // A piece thrown away and wanted again before its file has gone. Windows
    // holds a deleted-but-still-open file in a pending state and answers the
    // next `open` of that name with EPERM, so writing it again has to wait for
    // the removal to finish. On POSIX the wait costs a resolved promise.
    await this.#removing.get(index);
    await this.#ensureDirectory();
    await this.#makeRoomFor(bytes.length, index);
    await fs.writeFile(this.#pathOf(index), bytes);
    if (!this.#stored.has(index)) {
      this.#bytes += bytes.length;
    } else {
      this.#bytes += bytes.length - (this.#stored.get(index) ?? 0);
    }
    this.#stored.set(index, bytes.length);
    this.#touched.set(index, this.#now());
  }

  /**
   * Read a piece back into a buffer the caller already owns.
   *
   * PART of a piece, when the caller asks for one. A peer asks for 16 KB at a
   * time and a piece here is megabytes, so reading the whole of it to answer
   * one request is the difference between 16 KB and 4 MB off the disk — field
   * 2026-09-11: 63 416 reads of which 21.6 % came from memory, 49 696 pieces
   * revived whole, to serve an upload capped at 512 KB/s.
   *
   * @param {number} index
   * @param {Uint8Array} target - Destination; its length is what gets read.
   * @param {number} [at] - Offset within the piece to start at.
   * @returns {Promise<number>} Bytes read.
   */
  async read(index, target, at = 0) {
    if (!this.#stored.has(index)) {
      throw new Error(`Piece ${index} is not on disk.`);
    }
    // While this runs, eviction leaves the piece alone. Removing a file that is
    // open is safe on POSIX and the read would finish — but the open itself
    // happens below, and between the check above and that open a file removed
    // is a read that fails for a piece the caller was told is there.
    this.#reading.set(index, (this.#reading.get(index) ?? 0) + 1);
    let handle = null;
    try {
      handle = await fs.open(this.#pathOf(index), "r");
      const { bytesRead } = await handle.read(target, 0, target.length, Math.max(0, at));
      this.#touched.set(index, this.#now());
      return bytesRead;
    } finally {
      await handle?.close().catch(() => undefined);
      const outstanding = (this.#reading.get(index) ?? 1) - 1;
      if (outstanding > 0) {
        this.#reading.set(index, outstanding);
      } else {
        this.#reading.delete(index);
      }
    }
  }

  /**
   * Forget a piece and give its disk back.
   *
   * The removal itself is left to run: the caller's contract is synchronous —
   * after this returns, the store no longer has the piece — and the blocks come
   * back a moment later. A failure to remove leaves a file nobody will read;
   * the directory goes whole when the store is destroyed.
   *
   * @param {number} index
   * @returns {void}
   */
  forget(index) {
    const length = this.#stored.get(index);
    if (length === undefined) {
      return;
    }
    this.#stored.delete(index);
    this.#touched.delete(index);
    this.#bytes -= length;
    // Kept track of, because a removal still in flight holds the directory: on
    // Windows `rmdir` refuses while any handle inside is open, so `destroy`
    // waits for these before removing the directory. On Linux it would succeed
    // and the removals would then fail silently against a directory that is
    // gone — tidy either way, and correct on both.
    const removal = fs.rm(this.#pathOf(index), REMOVAL)
      .catch(() => undefined)
      .finally(() => {
        if (this.#removing.get(index) === removal) {
          this.#removing.delete(index);
        }
      });
    this.#removing.set(index, removal);
  }

  /**
   * What it holds, what it may hold, and what it has had to throw away.
   *
   * @returns {{ pieces: number, bytes: number, allowanceBytes: number | null, evictions: number, behind: number }}
   */
  stats() {
    return {
      pieces: this.#stored.size,
      bytes: this.#bytes,
      allowanceBytes: this.#allowanceBytes,
      evictions: this.#evictions,
      behind: this.#behind
    };
  }

  /**
   * Close it, leaving its contents in place.
   *
   * There is no handle to close — a read opens and closes its own — so this
   * exists for the caller's lifecycle and does nothing else.
   *
   * @returns {Promise<void>}
   */
  async close() {
    // Nothing to release: a read opens and closes its own handle.
  }

  /**
   * Close and remove everything.
   *
   * @returns {Promise<void>}
   */
  async destroy() {
    await this.close();
    await this.settled();
    this.#stored.clear();
    this.#touched.clear();
    this.#bytes = 0;
    await fs.rm(this.#directory, { ...REMOVAL, recursive: true });
  }

  /**
   * Wait for every removal this store has started.
   *
   * Removing a piece answers at once and frees the disk a moment later; this is
   * how a caller that needs the disk back NOW — a test, or `destroy` — waits for
   * it without making `forget` asynchronous for everybody else.
   *
   * @returns {Promise<void>}
   */
  async settled() {
    while (this.#removing.size > 0) {
      await Promise.all([...this.#removing.values()]);
    }
  }

  /**
   * @param {number} index
   * @returns {string}
   */
  #pathOf(index) {
    return path.join(this.#directory, `${index}.piece`);
  }

  /**
   * Make sure the directory is there, before every write.
   *
   * Deliberately not remembered. A remembered "it exists" is a statement about
   * the past: this store's own `destroy` removes the directory, a startup sweep
   * removes what a killed process left, and an operator clearing a full disk
   * removes anything. Each of those turns the memory into a lie and every write
   * after it into `ENOENT`. Creating a directory that already exists costs tens
   * of microseconds against a write measured in milliseconds.
   *
   * @returns {Promise<void>}
   */
  async #ensureDirectory() {
    await fs.mkdir(this.#directory, { recursive: true });
  }

  /**
   * Throw away the least recently used pieces until one more will fit.
   *
   * Least recently used first, and for the reason the memory tier uses the same
   * order: what nobody has read for the longest is what a viewer is least
   * likely to want next. A piece being read now is never a victim, and neither
   * is the piece about to be written.
   *
   * A piece thrown away is not lost, only un-had: the store answers `has` with
   * false, the read that wanted it gets nothing, and the torrent fetches it
   * again. That is the same bargain the memory tier makes when it spills.
   *
   * @param {number} incomingBytes
   * @param {number} incomingIndex
   * @returns {Promise<void>}
   */
  async #makeRoomFor(incomingBytes, incomingIndex) {
    if (this.#allowanceBytes === null) {
      return;
    }
    const already = this.#stored.get(incomingIndex) ?? 0;
    while (this.#bytes - already + incomingBytes > this.#allowanceBytes) {
      const victim = this.#leastRecentlyUsed(incomingIndex);
      if (victim === null) {
        // Everything left is either being read or is the piece coming in. The
        // write goes ahead: refusing it would lose a piece the swarm has
        // already paid for, and the next write finds the readers gone.
        return;
      }
      this.forget(victim);
      this.#evictions += 1;
    }
  }

  /**
   * @param {number} except
   * @returns {number | null}
   */
  #leastRecentlyUsed(except) {
    // WHERE THE READERS STAND DECIDES, and last use only settles ties.
    //
    // What lies behind every read head has been read and will not be read again
    // unless somebody seeks back, so it goes before anything ahead of them,
    // furthest behind first. It is the order the segments are given one layer
    // up, and the order the priority map states, read from the other end.
    // Without the heads there is nothing to order by and last use is all that
    // is left — which is what this was, and what said nothing about what
    // anybody is about to read.
    const heads = this.#readHeads().filter((at) => Number.isInteger(at));
    const earliest = heads.length > 0 ? Math.min(...heads) : null;
    let victim = null;
    let worst = null;
    for (const [index, at] of this.#touched) {
      if (index === except || this.#reading.has(index)) {
        continue;
      }
      const behind = earliest !== null && index < earliest;
      const score = { behind, distance: behind ? earliest - index : 0, at };
      if (
        worst === null
        || (score.behind && !worst.behind)
        || (score.behind === worst.behind && score.distance > worst.distance)
        || (score.behind === worst.behind && score.distance === worst.distance && score.at < worst.at)
      ) {
        worst = score;
        victim = index;
      }
    }
    return victim;
  }
}
