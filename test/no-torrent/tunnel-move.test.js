/**
 * @file A server being replaced asks its proxies to move, and the move leaves
 * no moment in which the tunnel is missing or a reply goes to the wrong server.
 *
 * During a server release the old instance sends `server-moving`. The proxy
 * opens a second connection, which reaches the new instance, and keeps the
 * first until the old instance closes it. A browser that was signalling
 * through the old instance is known only there, so every reply to a request
 * that arrived on the old connection must go back over it.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketServer } from "ws";

import { createTunnelClient } from "../../services/transport/tunnel-client.js";

/**
 * Wait for the condition being asserted; the deadline only turns a hang into
 * a failure.
 *
 * @param {() => boolean} until
 * @param {string} what
 * @param {number} [limit]
 * @returns {Promise<void>}
 */
async function waitFor(until, what, limit = 10_000) {
  const deadline = Date.now() + limit;
  while (!until()) {
    if (Date.now() > deadline) {
      throw new Error(`${what} never happened`);
    }
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
}

/**
 * A tunnel endpoint that keeps every connection it accepted, with what arrived
 * on each and the headers it was opened with. `refuse` turns away upgrades
 * while it returns true, which is what a server instance that is leaving does.
 *
 * @param {{ refuse?: () => boolean }} [options]
 */
async function startRegistry({ refuse = () => false } = {}) {
  /** @type {{ socket: import("ws").WebSocket, headers: import("node:http").IncomingHttpHeaders, received: any[] }[]} */
  const accepted = [];
  const server = new WebSocketServer({
    port: 0,
    verifyClient: (_info, done) => {
      if (refuse()) {
        done(false, 503);
        return;
      }
      done(true);
    }
  });
  await new Promise((resolve) => { server.on("listening", resolve); });
  server.on("connection", (socket, req) => {
    const entry = { socket, headers: req.headers, received: [] };
    accepted.push(entry);
    socket.on("message", (data) => { entry.received.push(JSON.parse(data.toString())); });
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    accepted,
    close: () => new Promise((resolve) => {
      for (const { socket } of accepted) {
        socket.terminate();
      }
      server.close(() => resolve());
    })
  };
}

test("a move opens a second connection and answers each request where it arrived", async (t) => {
  const registry = await startRegistry();
  /** @type {string[]} */
  const lines = [];
  /** @type {ReturnType<typeof createTunnelClient>} */
  let client;
  client = createTunnelClient({
    serverUrl: registry.url,
    proxyId: "p1",
    token: "t",
    proxyPort: 9090,
    name: "Кухня",
    baseUrl: "http://192.168.1.5:9090",
    onLog: (line) => lines.push(line),
    onHealthRequest: () => ({ metrics: { cpuLoad: 0.1 }, holds: [] }),
    // The proxy's WebRTC manager answers an offer through `sendSignal`.
    onSignal: (sessionId) => { client.sendSignal(sessionId, { type: "answer", sdp: "x" }); },
    connectionLifetimeMs: 60_000
  });
  t.after(async () => {
    client.disconnect();
    await registry.close();
  });

  client.connect();
  await waitFor(() => registry.accepted.length === 1 && registry.accepted[0].socket.readyState === 1, "the first connection");
  const [old] = registry.accepted;
  assert.equal(decodeURIComponent(old.headers["x-proxy-name"]), "Кухня");
  assert.equal(old.headers["x-proxy-base-url"], "http://192.168.1.5:9090");
  assert.equal(old.headers["x-proxy-follows-moves"], "1");

  // A browser starts signalling through the old server, then the old server
  // is replaced.
  old.socket.send(JSON.stringify({ type: "signal", sessionId: "s-old", signal: { type: "offer", sdp: "o" } }));
  await waitFor(() => old.received.some((m) => m.type === "signal"), "the answer on the old connection");
  old.socket.send(JSON.stringify({ type: "server-moving" }));
  await waitFor(() => registry.accepted.length === 2 && registry.accepted[1].socket.readyState === 1, "the second connection");
  const fresh = registry.accepted[1];

  // Both open now. A late request on the old connection is answered there.
  old.socket.send(JSON.stringify({ type: "health-request", requestId: "h-old" }));
  old.socket.send(JSON.stringify({ type: "signal", sessionId: "s-old", signal: { type: "candidate", candidate: "c" } }));
  fresh.socket.send(JSON.stringify({ type: "health-request", requestId: "h-new" }));
  await waitFor(() => old.received.some((m) => m.requestId === "h-old"), "the old health answer");
  await waitFor(() => fresh.received.some((m) => m.requestId === "h-new"), "the new health answer");
  await waitFor(() => old.received.filter((m) => m.type === "signal").length === 2, "the second answer to the old session");
  assert.equal(fresh.received.some((m) => m.requestId === "h-old"), false);
  assert.equal(fresh.received.some((m) => m.type === "signal"), false);
  assert.equal(old.received.some((m) => m.requestId === "h-new"), false);

  // The old server finishes and closes. Nothing is reconnected: the tunnel
  // never went down.
  old.socket.close(1000, "moved");
  await waitFor(() => lines.some((line) => line.includes("Tunnel handed over")), "the handover");
  assert.equal(lines.filter((line) => line.includes("Reconnecting in")).length, 0, lines.join("\n"));
  assert.equal(registry.accepted.length, 2);
});

test("a move whose new connection is refused keeps the old one carrying the tunnel", async (t) => {
  let refusing = false;
  const registry = await startRegistry({ refuse: () => refusing });
  /** @type {string[]} */
  const lines = [];
  const client = createTunnelClient({
    serverUrl: registry.url,
    proxyId: "p2",
    token: "t",
    proxyPort: 9090,
    onLog: (line) => lines.push(line),
    onHealthRequest: () => ({ metrics: {}, holds: [] }),
    connectionLifetimeMs: 60_000
  });
  t.after(async () => {
    client.disconnect();
    await registry.close();
  });

  client.connect();
  await waitFor(() => registry.accepted.length === 1 && registry.accepted[0].socket.readyState === 1, "the first connection");
  const [old] = registry.accepted;

  refusing = true;
  old.socket.send(JSON.stringify({ type: "server-moving" }));
  await waitFor(() => lines.some((line) => line.includes("while the previous one is still open")), "the refused move");

  // The old connection still answers, and it is what the proxy speaks on.
  client.sendEndpoint({ externalIp: null, externalPort: 9090, protocol: "TCP" });
  await waitFor(() => old.received.some((m) => m.type === "proxy-endpoint"), "the endpoint on the old connection");
  assert.equal(lines.filter((line) => line.includes("Tunnel disconnected")).length, 0, lines.join("\n"));
});
