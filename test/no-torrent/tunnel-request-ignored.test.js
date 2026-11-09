/**
 * @file The server tunnel does not relay HTTP requests (torrent-tv/meta#281).
 *
 * The browser reaches the proxy's HTTP routes only over the data channel. A
 * `request` frame arriving over the tunnel is ignored like any unknown frame:
 * nothing is forwarded to the proxy's own HTTP server, where loopback-only
 * routes would trust it, and nothing is sent back.
 *
 * The registry is a WebSocket server and the proxy's HTTP server a stand-in,
 * both on 127.0.0.1 at free ports; no proxy route and no torrent is started.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketServer } from "ws";

import { createTunnelClient } from "../../services/transport/tunnel-client.js";
import { startLoopbackServer } from "./helpers/loopback-server.js";
import { until } from "./helpers/wait.js";

/** A registry that keeps the one connection it accepts and what arrived on it. */
async function startRegistry() {
  /** @type {{ socket: import("ws").WebSocket | null, received: any[] }} */
  const peer = { socket: null, received: [] };
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => { server.on("listening", resolve); });
  server.on("connection", (socket) => {
    peer.socket = socket;
    socket.on("message", (data) => { peer.received.push(JSON.parse(data.toString())); });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    peer,
    close: () => new Promise((resolve) => {
      peer.socket?.terminate();
      server.close(() => resolve());
    })
  };
}

test("a request frame over the tunnel is neither forwarded to the local server nor answered", async (t) => {
  const local = await startLoopbackServer();
  const registry = await startRegistry();
  const fetchCalls = t.mock.method(globalThis, "fetch", async () => new Response("relayed"));
  const client = createTunnelClient({
    serverUrl: registry.url,
    proxyId: "p1",
    token: "t",
    proxyPort: local.port,
    onLog: () => {}
  });
  t.after(async () => {
    client.disconnect();
    await registry.close();
    await local.close();
  });

  client.connect();
  await until(() => registry.peer.socket?.readyState === 1, "the tunnel connection");
  const { peer } = registry;

  peer.socket.send(JSON.stringify({
    type: "request",
    requestId: "tun-1",
    method: "GET",
    path: "/encode-input/1/0",
    query: "",
    headers: {},
    body: null
  }));
  // Frames are handled in order: once the probe sent after it is echoed, the
  // request frame has been handled.
  peer.socket.send(JSON.stringify({ type: "rtt-probe", sentAt: 123 }));
  await until(() => peer.received.some((message) => message.type === "rtt-echo"), "the echo after the request frame");

  assert.equal(fetchCalls.mock.callCount(), 0, "the request frame was forwarded");
  assert.equal(local.connections(), 0);
  assert.deepEqual(peer.received.filter((message) => message.requestId === "tun-1"), []);
});
