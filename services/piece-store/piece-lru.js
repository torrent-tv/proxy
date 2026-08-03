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
    for (const index of this.#order) {
      if (!this.#pins.has(index)) {
        return index;
      }
    }
    return null;
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
