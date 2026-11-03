/**
 * @file Decide when a second copy of a late missing block is useful.
 *
 * WebTorrent normally owns picking, queues and request reassignment. This
 * exception is bounded to the currently required urgent pieces, a tail of at
 * most 16 missing blocks, requests older than one wire queue, and two copies
 * per block. The injected adapter is the only place that touches WebTorrent's
 * private piece/reservation/request state.
 */

/** `PIPELINE_MAX_DURATION`: WebTorrent sizes each wire queue to one second. */
const WIRE_QUEUE_MS = 1000;
const SHORT_TAIL_BLOCKS = 16;
const MAX_COPIES = 2;

export class TailRepeat {
  #requiredPieces;
  #adapter;
  #schedule;
  #wake;
  #clear;
  #scheduled = false;
  #timer = null;
  #timerAt = Number.POSITIVE_INFINITY;
  #disposed = false;
  #unwatch;
  #log;
  #now;
  #reportedUnavailable = false;

  /**
   * @param {object} params
   * @param {() => Array<{ from: number, to: number }>} params.requiredPieces
   * @param {{ observe: Function, repeatBlock: Function, watch: Function }} params.adapter
   * @param {(work: () => void) => void} [params.schedule]
   * @param {(work: () => void, ms: number) => unknown} [params.wake]
   * @param {(handle: unknown) => void} [params.clear]
   * @param {(line: string) => void} [params.log]
   * @param {() => number} [params.now]
   */
  constructor({ requiredPieces, adapter, schedule = setImmediate, wake = setTimeout, clear = clearTimeout, log = null, now = Date.now }) {
    this.#requiredPieces = requiredPieces;
    this.#adapter = adapter;
    this.#schedule = schedule;
    this.#wake = wake;
    this.#clear = clear;
    this.#log = log;
    this.#now = now;
    this.totals = { duplicated: 0, looks: 0, lateBlocks: 0 };
    try {
      this.#unwatch = adapter.watch(() => this.poke(), () => { this.totals.lateBlocks += 1; });
    } catch {
      this.#reportUnavailable();
      this.#unwatch = null;
    }
  }

  /** Look at the tails once this turn of the event loop is over. */
  poke() {
    if (this.#scheduled || this.#disposed) return;
    this.#scheduled = true;
    this.#schedule(() => this.#look());
  }

  /** Stop watching and cancel the one armed age check. */
  dispose() {
    this.#disposed = true;
    this.#unwatch?.();
    this.#unwatch = null;
    if (this.#timer !== null) this.#clear(this.#timer);
    this.#timer = null;
  }

  #lookAgainAt(at, now) {
    if (!Number.isFinite(at) || at >= this.#timerAt || this.#disposed) return;
    if (this.#timer !== null) this.#clear(this.#timer);
    this.#timerAt = at;
    this.#timer = this.#wake(() => {
      this.#timer = null;
      this.#timerAt = Number.POSITIVE_INFINITY;
      this.poke();
    }, Math.max(0, at - now));
    this.#timer?.unref?.();
  }

  #look() {
    this.#scheduled = false;
    if (this.#disposed) return;
    this.totals.looks += 1;
    const now = this.#now();
    let dueAt = Number.POSITIVE_INFINITY;
    let unplaced = 0;
    const asked = [];

    for (const { from, to } of this.#requiredPieces()) {
      for (let pieceIndex = from; pieceIndex <= to; pieceIndex += 1) {
        if (this.#disposed) return;
        let observation;
        try {
          observation = this.#adapter.observe(pieceIndex, SHORT_TAIL_BLOCKS);
        } catch {
          this.#reportUnavailable();
          continue;
        }
        if (!observation?.available) {
          this.#reportUnavailable();
          continue;
        }
        if (observation.missingCount === 0 || observation.missingCount > SHORT_TAIL_BLOCKS) continue;

        let pieceCopies = 0;
        for (const block of observation.blocks) {
          if (block.copies === 0 || block.copies >= MAX_COPIES) continue;
          const firstAskedAt = block.firstAskedAt ?? Number.NEGATIVE_INFINITY;
          if (now - firstAskedAt < WIRE_QUEUE_MS) {
            dueAt = Math.min(dueAt, firstAskedAt + WIRE_QUEUE_MS);
            continue;
          }
          let result;
          try {
            result = this.#adapter.repeatBlock(pieceIndex, block.index);
          } catch {
            this.#reportUnavailable();
            continue;
          }
          if (result === "unavailable") {
            this.#reportUnavailable();
            continue;
          }
          if (result === "placed") {
            pieceCopies += 1;
            this.totals.duplicated += 1;
          } else {
            unplaced += 1;
          }
        }
        if (pieceCopies > 0) asked.push(`${pieceIndex}:${pieceCopies}/${observation.missingCount}`);
      }
    }

    if (asked.length > 0) {
      this.#log?.(`tail: asked a second peer for the last blocks of piece:blocks/missing ${asked.join(" ")}; ` +
        `${this.totals.duplicated} block copies asked so far, ${this.totals.lateBlocks} block(s) arrived after their piece was complete`);
    }
    if (unplaced > 0) dueAt = Math.min(dueAt, now + WIRE_QUEUE_MS);
    this.#lookAgainAt(dueAt, now);
  }

  #reportUnavailable() {
    if (this.#reportedUnavailable) return;
    this.#reportedUnavailable = true;
    this.#adapter.disable?.();
    this.#log?.("tail: bounded repeat unavailable; using WebTorrent's ordinary picker");
  }
}
