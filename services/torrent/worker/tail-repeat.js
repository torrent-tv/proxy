/**
 * @file Ask a second peer for the last blocks of a piece somebody is waiting
 * for, when one slow peer holds them (torrent-tv/meta#178).
 *
 * Field r40 (Home Assistant, 2026-10-14, a cold 1080p MKV): the first run's
 * input waited 10.0 s, last for piece 8, whose slowest block was 4.5 s in
 * flight from one peer; pieces 14-16 waited 10.0-11.5 s on one peer each. A
 * block is reserved for one wire, and the piece completes when its slowest
 * holder delivers (`duplicateTailFor`). Nothing had asked a second peer since
 * the blocked-read path that did so was removed (`0e38ec3`, torrent-tv/meta#95).
 *
 * Which pieces: those of the urgent first class the swarm was last told
 * (`SwarmSelection.requiredPieces`) — what somebody waits for now. A map that
 * withdraws them, or an input that is ready, takes them out, and nothing more
 * is asked for them.
 *
 * When: a tail changes when a block arrives, a wire's queue moves on, or a
 * peer becomes able or unable to give the piece; so it is looked at on those —
 * a block arriving, a wire unchoking, a peer stating a piece, a wire joining
 * or closing, a piece verified, a new map. Several in one turn of the event
 * loop are one look. A block is asked again only once its request has been out
 * a wire's queue time (`duplicateTailFor`), so a block not yet late is looked
 * at again when it becomes late, and a late one no other wire could take is
 * looked at again a queue time later — once, in case nothing else happens in
 * between. WebTorrent sizes a wire's queue to one second of its speed
 * (`PIPELINE_MAX_DURATION`).
 */

import { duplicateTailFor } from "./fastest-wires.js";

/** WebTorrent's `PIPELINE_MAX_DURATION`: a wire is given one second of its speed to fetch. */
const WIRE_QUEUE_SECONDS = 1;

/** What a wire says, besides a block arriving, that can change who could be asked for a piece. */
const WIRE_EVENTS = ["unchoke", "have", "bitfield"];

export class TailRepeat {
  #torrent;
  #requiredPieces;
  #duplicate;
  #schedule;
  #wake;
  #clear;
  #scheduled = false;
  #timer = null;
  /** When the armed look runs, wall clock ms. */
  #timerAt = Number.POSITIVE_INFINITY;
  #disposed = false;
  /** @type {Map<object, { onBlock: (index: number) => void, onPeer: () => void }>} */
  #wires = new Map();
  #onWire;
  #onPoke;
  #log;
  #now;
  /**
   * Grow-only, for the log: block copies asked, looks taken, and blocks that
   * arrived after their piece was complete — what the copies cost.
   */
  totals = { duplicated: 0, looks: 0, lateBlocks: 0 };

  /**
   * @param {object} params
   * @param {object} params.torrent
   * @param {() => Array<{ from: number, to: number }>} params.requiredPieces
   * @param {typeof duplicateTailFor} [params.duplicate]
   * @param {(work: () => void) => void} [params.schedule] - Runs work once this turn of the event loop is over.
   * @param {(work: () => void, ms: number) => unknown} [params.wake]
   * @param {(handle: unknown) => void} [params.clear]
   * @param {(line: string) => void} [params.log]
   * @param {() => number} [params.now]
   */
  constructor({ torrent, requiredPieces, duplicate = duplicateTailFor, schedule = setImmediate, wake = setTimeout, clear = clearTimeout, log = null, now = Date.now }) {
    this.#log = log;
    this.#now = now;
    this.#torrent = torrent;
    this.#requiredPieces = requiredPieces;
    this.#duplicate = duplicate;
    this.#schedule = schedule;
    this.#wake = wake;
    this.#clear = clear;
    this.#onWire = (wire) => this.#watch(wire);
    this.#onPoke = () => this.poke();
    torrent.on?.("wire", this.#onWire);
    torrent.on?.("verified", this.#onPoke);
    for (const wire of Array.isArray(torrent.wires) ? torrent.wires : []) this.#watch(wire);
  }

  /** Look at the tails once this turn of the event loop is over. */
  poke() {
    if (this.#scheduled || this.#disposed) return;
    this.#scheduled = true;
    this.#schedule(() => this.#look());
  }

  /** Stop watching: the torrent is going. */
  dispose() {
    this.#disposed = true;
    this.#torrent.removeListener?.("wire", this.#onWire);
    this.#torrent.removeListener?.("verified", this.#onPoke);
    for (const wire of [...this.#wires.keys()]) this.#forget(wire);
    if (this.#timer !== null) this.#clear(this.#timer);
    this.#timer = null;
  }

  /** One look armed at a time, at the earliest moment asked for. */
  #lookAgainAt(at, now) {
    if (!Number.isFinite(at) || at >= this.#timerAt) return;
    if (this.#timer !== null) this.#clear(this.#timer);
    this.#timerAt = at;
    this.#timer = this.#wake(() => {
      this.#timer = null;
      this.#timerAt = Number.POSITIVE_INFINITY;
      this.poke();
    }, Math.max(0, at - now));
    this.#timer?.unref?.();
  }

  #watch(wire) {
    if (!wire || this.#wires.has(wire) || typeof wire.on !== "function") return;
    const listeners = {
      onBlock: (index) => {
        // A block of a piece already verified is a copy that came second; the
        // block that completes a piece arrives before the piece is verified.
        if (Number.isInteger(index) && this.#torrent.bitfield?.get?.(index)) this.totals.lateBlocks += 1;
        this.poke();
      },
      onPeer: () => this.poke()
    };
    this.#wires.set(wire, listeners);
    wire.on("piece", listeners.onBlock);
    for (const event of WIRE_EVENTS) wire.on(event, listeners.onPeer);
    wire.once?.("close", () => {
      this.#forget(wire);
      this.poke();
    });
    this.poke();
  }

  #forget(wire) {
    const listeners = this.#wires.get(wire);
    if (!listeners) return;
    wire.removeListener?.("piece", listeners.onBlock);
    for (const event of WIRE_EVENTS) wire.removeListener?.(event, listeners.onPeer);
    this.#wires.delete(wire);
  }

  #look() {
    this.#scheduled = false;
    if (this.#disposed) return;
    this.totals.looks += 1;
    const now = this.#now();
    let unplaced = 0, dueAt = Number.POSITIVE_INFINITY;
    const asked = [];
    for (const { from, to } of this.#requiredPieces()) {
      for (let index = from; index <= to; index += 1) {
        if (this.#torrent.bitfield?.get?.(index)) continue;
        const result = this.#duplicate(this.#torrent, index, { minAgeMs: WIRE_QUEUE_SECONDS * 1000, now });
        this.totals.duplicated += result.duplicated;
        unplaced += result.unplaced;
        if (Number.isFinite(result.dueAt)) dueAt = Math.min(dueAt, result.dueAt);
        if (result.duplicated > 0) asked.push(`${index}:${result.duplicated}/${result.missing}`);
      }
    }
    if (asked.length > 0) {
      this.#log?.(`tail: asked a second peer for the last blocks of piece:blocks/missing ${asked.join(" ")}; ` +
        `${this.totals.duplicated} block copies asked so far, ${this.totals.lateBlocks} block(s) arrived after their piece was complete`);
    }
    if (unplaced > 0) dueAt = Math.min(dueAt, now + WIRE_QUEUE_SECONDS * 1000);
    this.#lookAgainAt(dueAt, now);
  }
}
