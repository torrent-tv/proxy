/**
 * @file The transport both sides of the torrent worker share.
 *
 * One place holds the request/reply bookkeeping and the streaming rules, so the
 * worker and its main-thread client cannot drift apart on the details that
 * matter: which side transfers, which side acknowledges, and when a stream is
 * allowed to keep going.
 *
 * See `protocol.js` for why the design is what it is — every number in it came
 * from a measurement, not a preference.
 */

import { Event, STREAM_HIGH_WATER_CHUNKS } from "./protocol.js";

/**
 * Issue request ids that stay unique for the life of a thread.
 *
 * @returns {() => number}
 */
export function createRequestIds() {
  let next = 0;
  return () => (next += 1);
}

/**
 * Wrap a port's messages into request/reply calls.
 *
 * Callers get promises; the plumbing of matching replies to requests, and of
 * turning a worker-side failure back into a rejection, lives here. `Error`
 * objects do not survive a thread boundary, so failures cross as messages and
 * are rebuilt into `Error`s on arrival — a caller sees an ordinary rejection.
 *
 * @param {import("node:worker_threads").MessagePort | import("node:worker_threads").Worker} port
 * @returns {{
 *   call: (command: string, params?: object) => Promise<unknown>,
 *   handleReply: (message: object) => boolean,
 *   rejectAll: (reason: Error) => void
 * }}
 */
export function createCaller(port) {
  const nextId = createRequestIds();
  const pending = new Map();

  return {
    call(command, params = {}) {
      return new Promise((resolve, reject) => {
        const id = nextId();
        pending.set(id, { resolve, reject });
        port.postMessage({ command, id, params });
      });
    },

    /**
     * Feed a message in; returns true when it was a reply this caller owned.
     */
    handleReply(message) {
      const entry = pending.get(message?.id);
      if (!entry) {
        return false;
      }
      if (message.type === Event.RESULT) {
        pending.delete(message.id);
        entry.resolve(message.result);
        return true;
      }
      if (message.type === Event.ERROR) {
        pending.delete(message.id);
        entry.reject(new Error(message.error ?? "Torrent worker request failed."));
        return true;
      }
      return false;
    },

    /**
     * Fail everything outstanding — the worker died, or is being shut down.
     */
    rejectAll(reason) {
      for (const [, entry] of pending) {
        entry.reject(reason);
      }
      pending.clear();
    }
  };
}

/**
 * Receive a chunked body as an ordinary `ReadableStream`.
 *
 * This is the half that makes the design pay off: chunks arrive as transferred
 * buffers (no copying), and are handed on through a standard stream, so callers
 * treat it exactly like any other body. Each chunk is acknowledged as it is
 * enqueued, which is what lets the worker keep only
 * {@link STREAM_HIGH_WATER_CHUNKS} in flight.
 *
 * Cancelling the stream — a viewer navigating away, a superseded seek — sends
 * the cancel command, so the worker stops reading rather than filling a queue
 * nobody will drain.
 *
 * @param {object} params
 * @param {import("node:worker_threads").Worker} params.port
 * @param {number} params.requestId
 * @param {() => void} params.onCancel - Sends CANCEL_READ for this request.
 * @returns {{ stream: ReadableStream<Uint8Array>, push: (bytes: Uint8Array) => void, close: () => void, fail: (error: Error) => void }}
 */
export function createReceiveStream({ port, requestId, onCancel }) {
  let controller = null;
  let finished = false;

  const stream = new ReadableStream({
    start(streamController) {
      controller = streamController;
    },
    cancel() {
      if (!finished) {
        finished = true;
        onCancel();
      }
    }
  });

  return {
    stream,

    push(bytes) {
      if (finished || !controller) {
        return;
      }
      controller.enqueue(bytes);
      // Acknowledge only once the data is in the stream's own queue, so the
      // worker's in-flight count reflects what has actually been taken up.
      port.postMessage({ type: Event.CHUNK_ACK, id: requestId });
    },

    close() {
      if (finished || !controller) {
        return;
      }
      finished = true;
      controller.close();
    },

    fail(error) {
      if (finished || !controller) {
        return;
      }
      finished = true;
      controller.error(error);
    }
  };
}

/**
 * Send a body as chunks, pausing when too many are unacknowledged.
 *
 * The worker side of the same arrangement. `waitForCapacity` resolves when the
 * main thread has taken up enough of what was sent; without it a fast disk
 * would outrun the channel and rebuild in the message queue exactly the memory
 * the transfers were saving.
 *
 * @param {object} params
 * @param {import("node:worker_threads").MessagePort} params.port
 * @param {number} params.requestId
 * @returns {{ send: (bytes: Buffer) => Promise<void>, end: () => void, ack: () => void, cancel: () => void, isCancelled: () => boolean }}
 */
export function createSendStream({ port, requestId }) {
  let inFlight = 0;
  let cancelled = false;
  let wake = null;

  const waitForCapacity = () => {
    if (cancelled || inFlight < STREAM_HIGH_WATER_CHUNKS) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      wake = resolve;
    });
  };

  return {
    async send(bytes) {
      await waitForCapacity();
      if (cancelled) {
        return;
      }
      inFlight += 1;
      // Copy into memory this transport allocated, then transfer THAT.
      //
      // Transferring the caller's buffer is faster and was what shipped, but it
      // is only correct if the caller owns the memory outright — and no test at
      // this boundary can establish that. 2.9.73 tried to decide it by
      // inspection (`byteOffset === 0 && byteLength === buffer.byteLength`),
      // which answers "does this view cover its region", not "did we allocate
      // it". WebTorrent's piece cache returns a buffer covering its whole
      // region and keeps using it, so the check passed and the transfer
      // detached the cache: every later read failed with a detached
      // ArrayBuffer, and because the error never reached the reader it looked
      // like an empty file (`Stream ends prematurely at 0`).
      //
      // The copy costs 3.64 ms per 8 MB on the field host, against 37 ms for a
      // structured clone. It disappears entirely for pieces read through the
      // shared piece store, which the main thread reads by offset without any
      // hand-over at all.
      const payload = new Uint8Array(bytes);
      port.postMessage(
        { type: Event.CHUNK, id: requestId, bytes: payload },
        [payload.buffer]
      );
    },

    end() {
      if (!cancelled) {
        port.postMessage({ type: Event.READ_END, id: requestId });
      }
    },

    ack() {
      inFlight = Math.max(0, inFlight - 1);
      if (wake) {
        const resume = wake;
        wake = null;
        resume();
      }
    },

    cancel() {
      cancelled = true;
      if (wake) {
        const resume = wake;
        wake = null;
        resume();
      }
    },

    isCancelled() {
      return cancelled;
    }
  };
}
