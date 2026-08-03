/**
 * @file `webrtc-polyfill`'s interface, served by a pure-JavaScript WebRTC stack.
 *
 * **Why this exists.** node-datachannel is native, and its native side is not
 * safe to use from two V8 isolates at once: the process aborts with
 * `HandleScope: Entering the V8 API without proper locking in place`. Measured
 * on win32/x64 and linux/arm64 alike — one isolate is fine (either the main
 * thread or a worker), two at the same time is fatal, and preloading in both
 * does not help. The upstream issue about workers (#129) was closed in 0.4.0
 * but only covers use from a worker ALONE, which does work.
 *
 * We need it twice: `webrtc-manager.js` runs the video channel to the browser on
 * the main thread, and the torrent client — which is now on its own thread —
 * creates peer connections of its own to announce on `wss://` trackers. Before
 * the thread split both lived in one isolate and nothing was wrong; afterwards
 * any torrent carrying a wss tracker took the whole proxy down.
 *
 * So the native stack stays where it earns its keep — the main thread, carrying
 * video — and the torrent's trackers get a JavaScript implementation, where the
 * traffic is a handful of signalling messages. `services/torrent-worker/worker.js`
 * installs a module resolution hook that points `webrtc-polyfill` here; nothing
 * outside the worker thread is affected, and no dependency is patched (the addon
 * installs with `--ignore-scripts`, so a postinstall patch would never run).
 *
 * **What the shim has to fix.** werift's peer connection matches the interface
 * `simple-peer` expects, but its data channel differs in two ways that matter:
 *
 *  - it has no `binaryType`, and hands `onmessage` a `Buffer`. `simple-peer`
 *    only recognises `ArrayBuffer`; anything else goes through `text2arr`,
 *    which would corrupt every byte of torrent payload.
 *  - it has no `onbufferedamountlow`. `simple-peer` builds its backpressure on
 *    that event, so without it a send that hits the high-water mark never
 *    resumes.
 */

import {
  RTCPeerConnection as WeriftPeerConnection,
  RTCIceCandidate
} from "werift";

/**
 * A session description built the way browsers build it — from one object.
 *
 * werift's own class takes two positional arguments, `(sdp, type)`. Callers
 * written against the browser pass `{ type, sdp }`, so with werift's class the
 * type lands in the sdp slot and the description is rejected: field 2026-08-03,
 * wss announces succeeded but every peer connection died with "Connection
 * error: invalid sessionDescription".
 *
 * `RTCIceCandidate` needs no such treatment — werift already takes an object.
 */
class ShimSessionDescription {
  /**
   * @param {{ type?: string, sdp?: string } | string} init
   * @param {string} [type] - Tolerated for callers using werift's own order.
   */
  constructor(init, type) {
    if (typeof init === "string") {
      this.sdp = init;
      this.type = type;
      return;
    }
    this.type = init?.type;
    this.sdp = init?.sdp;
  }

  toJSON() {
    return { type: this.type, sdp: this.sdp };
  }
}

/**
 * A werift data channel wearing the browser's interface.
 *
 * Only what `simple-peer` touches is implemented — promising more would be
 * pretending, since anything else has no caller and would never be exercised.
 */
class ShimDataChannel {
  #channel;
  /** @type {"blob" | "arraybuffer"} */
  binaryType = "blob";
  /** @type {((event: { data: ArrayBuffer | Buffer }) => void) | null} */
  onmessage = null;
  /** @type {(() => void) | null} */
  onopen = null;
  /** @type {(() => void) | null} */
  onclose = null;
  /** @type {((event: { error?: Error }) => void) | null} */
  onerror = null;
  /** @type {(() => void) | null} */
  onbufferedamountlow = null;

  /**
   * @param {object} channel - werift's `RTCDataChannel`.
   */
  constructor(channel) {
    this.#channel = channel;

    channel.onmessage = (event) => {
      const data = event?.data ?? event;
      this.onmessage?.({ data: this.#toWireFormat(data) });
    };
    channel.onopen = () => this.onopen?.();
    channel.onclose = () => this.onclose?.();
    channel.onerror = (event) => this.onerror?.(event ?? {});

    // werift reports this as an observable rather than a handler property.
    channel.bufferedAmountLow?.subscribe?.(() => this.onbufferedamountlow?.());
  }

  /**
   * Match what a browser would deliver for the requested `binaryType`.
   *
   * `simple-peer` checks `instanceof ArrayBuffer` and sends everything else
   * through a text decoder, so a `Buffer` handed over unchanged arrives
   * mangled.
   *
   * @param {unknown} data
   * @returns {ArrayBuffer | unknown}
   */
  #toWireFormat(data) {
    if (this.binaryType !== "arraybuffer" || typeof data === "string") {
      return data;
    }
    if (ArrayBuffer.isView(data)) {
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    }
    return data;
  }

  get label() {
    return this.#channel.label;
  }

  get readyState() {
    return this.#channel.readyState;
  }

  get bufferedAmount() {
    return this.#channel.bufferedAmount;
  }

  get bufferedAmountLowThreshold() {
    return this.#channel.bufferedAmountLowThreshold;
  }

  set bufferedAmountLowThreshold(value) {
    this.#channel.bufferedAmountLowThreshold = value;
  }

  /**
   * @param {string | ArrayBuffer | ArrayBufferView} data
   * @returns {void}
   */
  send(data) {
    if (typeof data === "string") {
      this.#channel.send(data);
      return;
    }
    this.#channel.send(ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(data));
  }

  close() {
    this.#channel.close();
  }
}

/**
 * werift's peer connection, handing out data channels that carry the browser's
 * interface. Everything else is inherited unchanged — the peer connection side
 * already matches.
 */
class ShimPeerConnection extends WeriftPeerConnection {
  /**
   * @param {...unknown} args - Passed through to werift.
   */
  constructor(...args) {
    super(...args);

    // `ondatachannel` has to be redefined on the instance, not declared as an
    // accessor on this class: werift assigns it as an own field in its own
    // constructor, and an own property shadows a prototype accessor — so a
    // subclass setter is simply never called, and the caller receives werift's
    // bare channel instead of the wrapped one.
    let handler = null;
    const deliver = (event) => {
      handler?.({ ...event, channel: new ShimDataChannel(event?.channel ?? event) });
    };
    Object.defineProperty(this, "ondatachannel", {
      configurable: true,
      // werift reads this property to dispatch, so it must hand back the
      // wrapper rather than what the caller assigned.
      get: () => (handler ? deliver : null),
      set: (value) => {
        handler = value;
      }
    });
  }

  /**
   * @param {string} label
   * @param {object} [options]
   * @returns {ShimDataChannel}
   */
  createDataChannel(label, options) {
    return new ShimDataChannel(super.createDataChannel(label, options));
  }
}

export {
  ShimPeerConnection as RTCPeerConnection,
  ShimSessionDescription as RTCSessionDescription,
  RTCIceCandidate
};
export default {
  RTCPeerConnection: ShimPeerConnection,
  RTCSessionDescription: ShimSessionDescription,
  RTCIceCandidate
};
