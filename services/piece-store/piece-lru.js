/**
 * @file Which piece leaves memory next — and which one may not.
 *
 * Two responsibilities, deliberately kept apart from any storage:
 *
 *  - **recency**, so the piece evicted is the one least likely to be wanted;
 *  - **pinning**, so a piece being read cannot be evicted at all.
 *
 * The second is not a refinement of the first. webtor's seeder relies on recency
 * alone and guards the actual eviction with a read/write lock per piece
 * (`mmap.go`, 1024 shards) — because ordering says a piece is *unlikely* to be
 * in use, never that it is not. We have already paid for that difference once:
 * proxy 2.9.71 removed a torrent, and its data, out from under an active reader,
 * after which every read hung and ffmpeg saw an empty input. Here the guarantee
 * is explicit: a pinned piece is never returned as an eviction candidate, and
 * pins nest, because a piece can be read by several sessions at once.
 */

/**
 * Recency and pin bookkeeping for one torrent's pieces.
 *
 * Holds no data — it answers "what may go" and nothing else, which is what
 * makes it testable without a torrent, a disk or a thread.
 */
export class PieceLru {
  /** Insertion-ordered: the first key is the least recently used. */
  #order = new Set();
  /** Piece index → number of readers currently holding it. */
  #pins = new Map();
  /**
   * Reader id → the piece range it expects to read next.
   *
   * Recency alone does not describe this. A reader walking a film touches its
   * pieces once, so the piece the decoder will want in two seconds looks
   * exactly as stale as one fetched forty minutes ago and never read again —
   * and with the encoder running ahead of the viewer, the second kind is what
   * fills the store. Measured 2026-08-04: the hit rate fell from 100% to 45.7%
   * with 221 pieces read back from disk in one session.
   *
   * A preference, not a pin. At the smallest budget the store guarantees only
   * two resident pieces, so a hard hold on a window would deadlock it; when
   * nothing unprotected is left, protection is ignored rather than obeyed.
   */
  #protected = new Map();
  #capacity;

  /**
   * @param {number} capacity - How many pieces may be resident at once.
   */
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`Piece capacity must be a positive integer, got ${capacity}.`);
    }
    this.#capacity = capacity;
  }

  /** How many pieces are resident. */
  get size() {
    return this.#order.size;
  }

  /** How many pieces may be resident at once. */
  get capacity() {
    return this.#capacity;
  }

  /**
   * How many pieces are currently held by a reader.
   *
   * Reported rather than merely tracked: a pin that is never released is
   * invisible until eviction has nothing left to take, and by then the store is
   * already failing. A count that keeps climbing between reports names the leak
   * long before that.
   */
  get pinnedCount() {
    return this.#pins.size;
  }

  /**
   * Mark a piece as resident, or as used again if it already was.
   *
   * A `Set` preserves insertion order, so deleting and re-adding is what moves
   * a piece to the most-recent end.
   *
   * @param {number} index
   * @returns {void}
   */
  touch(index) {
    this.#order.delete(index);
    this.#order.add(index);
  }

  /**
   * @param {number} index
   * @returns {boolean}
   */
  has(index) {
    return this.#order.has(index);
  }

  /**
   * Stop tracking a piece — it is no longer resident.
   *
   * @param {number} index
   * @returns {void}
   */
  remove(index) {
    this.#order.delete(index);
  }

  /**
   * Hold a piece in memory for the duration of a read.
   *
   * Nested: two readers of the same piece take two pins, and the piece stays
   * held until both let go.
   *
   * @param {number} index
   * @returns {void}
   */
  pin(index) {
    this.#pins.set(index, (this.#pins.get(index) ?? 0) + 1);
  }

  /**
   * Release one pin taken with {@link pin}.
   *
   * @param {number} index
   * @returns {void}
   */
  unpin(index) {
    const held = this.#pins.get(index);
    if (held === undefined) {
      return;
    }
    if (held <= 1) {
      this.#pins.delete(index);
      return;
    }
    this.#pins.set(index, held - 1);
  }

  /**
   * @param {number} index
   * @returns {boolean}
   */
  isPinned(index) {
    return this.#pins.has(index);
  }

  /**
   * The least recently used piece that is free to go, or `null` when every
   * resident piece is pinned.
   *
   * Returning `null` rather than evicting a pinned piece is the whole point:
   * the caller must then wait or fail, never take memory out from under a
   * reader.
   *
   * @returns {number | null}
   */
  evictionCandidate() {
    // First choice: the least recently used piece nobody is reading and nobody
    // is about to read.
    for (const index of this.#order) {
      if (!this.#pins.has(index) && !this.#isProtected(index)) {
        return index;
      }
    }
    // Nothing spare left. Protection yields — it is a preference, and refusing
    // here would leave the store unable to admit anything at all. Pins do not
    // yield: a piece being read now cannot have its memory taken away.
    for (const index of this.#order) {
      if (!this.#pins.has(index)) {
        return index;
      }
    }
    return null;
  }

  /**
   * Declare the pieces a reader expects to need next, replacing whatever it
   * declared before. Ranges from different readers add up.
   *
   * @param {string|number} readerId - Identity of the reader, so its own range
   *   is replaced rather than accumulated.
   * @param {number} from - First piece, inclusive.
   * @param {number} to - Last piece, inclusive.
   * @returns {void}
   */
  protect(readerId, from, to) {
    if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) {
      return;
    }
    this.#protected.set(readerId, { from, to });
  }

  /**
   * Drop a reader's declared range. Must be called when the reader ends, or its
   * window keeps occupying the store for a reader that no longer exists.
   *
   * @param {string|number} readerId
   * @returns {void}
   */
  /**
   * Every live reader's declared window. Read by the pool to check that the
   * torrent has actually been asked for those pieces — WebTorrent deletes a
   * selection of its own accord once it is fully downloaded, so a claim made
   * once does not stay made.
   *
   * @returns {Array<{ from: number, to: number }>}
   */
  protectedRanges() {
    return [...this.#protected.values()].map((range) => ({ from: range.from, to: range.to }));
  }

  unprotect(readerId) {
    this.#protected.delete(readerId);
  }

  /** How many readers currently declare a range. */
  get protectedCount() {
    return this.#protected.size;
  }

  /**
   * @param {number} index
   * @returns {boolean}
   */
  #isProtected(index) {
    for (const range of this.#protected.values()) {
      if (index >= range.from && index <= range.to) {
        return true;
      }
    }
    return false;
  }

  /**
   * Whether admitting one more piece would exceed the capacity.
   *
   * @returns {boolean}
   */
  isFull() {
    return this.#order.size >= this.#capacity;
  }
}
