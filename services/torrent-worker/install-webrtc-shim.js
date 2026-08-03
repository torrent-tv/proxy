/**
 * @file Point `webrtc-polyfill` at the JavaScript WebRTC stack, in this thread only.
 *
 * Imported for its side effect, and imported FIRST by `worker.js` — ES module
 * bodies run in import order, so registering the hook here happens before
 * `torrent-pool.js` pulls in WebTorrent, which is what reaches
 * `@thaunknown/simple-peer` and, through it, `webrtc-polyfill`.
 *
 * Scope is deliberately narrow. The hook lives in the worker's isolate, so the
 * main thread keeps using node-datachannel directly for the browser's video
 * channel — see `webrtc-shim.js` for why the two cannot share one process
 * isolate at all.
 */

import { registerHooks } from "node:module";

const SHIM_URL = new URL("./webrtc-shim.js", import.meta.url).href;

registerHooks({
  /**
   * @param {string} specifier
   * @param {object} context
   * @param {(specifier: string, context: object) => { url: string }} nextResolve
   * @returns {{ url: string, shortCircuit?: boolean }}
   */
  resolve(specifier, context, nextResolve) {
    if (specifier === "webrtc-polyfill") {
      return { url: SHIM_URL, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
});
