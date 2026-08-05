/**
 * @file The JavaScript WebRTC stack the torrent thread uses instead of the native one.
 *
 * Covers the regression that took the whole proxy down from 2.9.71: a torrent
 * carrying a `wss://` tracker made the worker create a peer connection, and a
 * second isolate touching node-datachannel aborts the process outright.
 *
 * Also covers the two places werift's data channel differs from the browser's,
 * because `simple-peer` depends on both: binary payloads must arrive as
 * `ArrayBuffer` (anything else it pushes through a text decoder, corrupting
 * torrent data), and the buffered-amount-low event must exist (its backpressure
 * never resumes without it).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import {
  RTCPeerConnection,
  RTCSessionDescription
} from "../services/torrent-worker/webrtc-shim.js";

/**
 * Run a snippet on a worker thread and return what it reports.
 *
 * @param {string} source
 * @returns {Promise<unknown>}
 */
function onWorker(source) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, { eval: true });
    const done = (settle) => (value) => {
      void worker.terminate();
      settle(value);
    };
    worker.once("message", done(resolve));
    worker.once("error", done(reject));
  });
}

test("the worker resolves webrtc-polyfill to the JavaScript stack", async () => {
  const installUrl = new URL("../services/torrent-worker/install-webrtc-shim.js", import.meta.url).href;
  const reported = await onWorker(`
    import { parentPort } from "node:worker_threads";
    await import(${JSON.stringify(installUrl)});
    const polyfill = await import("webrtc-polyfill");
    const pc = new polyfill.RTCPeerConnection({});
    const channel = pc.createDataChannel("probe");
    parentPort.postMessage({
      connection: pc.constructor.name,
      channel: channel.constructor.name,
      hasBinaryType: "binaryType" in channel,
      hasBufferedAmountLow: "onbufferedamountlow" in channel
    });
    pc.close();
  `);

  assert.equal(reported.connection, "ShimPeerConnection");
  assert.equal(reported.channel, "ShimDataChannel");
  assert.ok(reported.hasBinaryType, "simple-peer sets binaryType and would get a silent no-op");
  assert.ok(reported.hasBufferedAmountLow, "simple-peer's backpressure needs this event");
});

test("a native connection on this thread does not stop the worker's stack", async () => {
  // The exact pairing that aborted the process before: native here, JavaScript
  // there, both live at once.
  const nodeDataChannel = (await import("node-datachannel")).default;
  const native = new nodeDataChannel.PeerConnection("main-side", { iceServers: [] });
  native.createDataChannel("keepalive");

  try {
    const installUrl = new URL("../services/torrent-worker/install-webrtc-shim.js", import.meta.url).href;
    const reported = await onWorker(`
      import { parentPort } from "node:worker_threads";
      await import(${JSON.stringify(installUrl)});
      const polyfill = await import("webrtc-polyfill");
      const pc = new polyfill.RTCPeerConnection({});
      pc.createDataChannel("probe");
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      parentPort.postMessage({ ok: String(pc.localDescription.sdp).startsWith("v=0") });
      pc.close();
    `);
    assert.equal(reported.ok, true);
  } finally {
    native.close();
  }
});

test("a session description is built from one object, as callers write it", async () => {
  // simple-peer does `new RTCSessionDescription(data)` with `{ type, sdp }`.
  // werift's own class takes `(sdp, type)` positionally, so the type would land
  // in the sdp slot and every peer connection would be rejected with
  // "invalid sessionDescription" — which is exactly what the field showed.
  const description = new RTCSessionDescription({ type: "offer", sdp: "v=0\r\n" });
  assert.equal(description.type, "offer");
  assert.equal(description.sdp, "v=0\r\n");

  const answerer = new RTCPeerConnection({});
  const offerer = new RTCPeerConnection({});
  try {
    offerer.createDataChannel("probe");
    const offer = await offerer.createOffer();
    await offerer.setLocalDescription(offer);

    // The round trip a tracker peer actually performs.
    await answerer.setRemoteDescription(
      new RTCSessionDescription({ type: offerer.localDescription.type, sdp: offerer.localDescription.sdp })
    );
    assert.equal(answerer.remoteDescription.type, "offer");
  } finally {
    answerer.close();
    offerer.close();
  }
});

test("binary payloads reach the reader as ArrayBuffer, byte for byte", async () => {
  const sender = new RTCPeerConnection({});
  const receiver = new RTCPeerConnection({});
  const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff, 0x7f, 0x80]);

  try {
    const received = new Promise((resolve, reject) => {
      receiver.ondatachannel = ({ channel }) => {
        channel.binaryType = "arraybuffer";
        channel.onmessage = (event) => resolve(event.data);
      };
      setTimeout(() => reject(new Error("nothing arrived within 30s")), 30_000);
    });

    sender.onicecandidate = ({ candidate }) => candidate && receiver.addIceCandidate(candidate);
    receiver.onicecandidate = ({ candidate }) => candidate && sender.addIceCandidate(candidate);

    const channel = sender.createDataChannel("payload");
    await sender.setLocalDescription(await sender.createOffer());
    await receiver.setRemoteDescription(sender.localDescription);
    await receiver.setLocalDescription(await receiver.createAnswer());
    await sender.setRemoteDescription(receiver.localDescription);

    channel.onopen = () => channel.send(payload);

    const data = await received;
    assert.ok(data instanceof ArrayBuffer, `simple-peer would run this through a text decoder: ${Object.prototype.toString.call(data)}`);
    assert.deepEqual(Buffer.from(data), payload, "payload was altered in transit");
  } finally {
    sender.close();
    receiver.close();
  }
});
