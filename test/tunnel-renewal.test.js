/**
 * @file The tunnel is replaced before anything upstream ends it, and the
 * replacement takes over first.
 *
 * Something between the proxy and the server closes the socket after exactly
 * 100 min 15 s whatever is flowing over it — measured across a day of logs on
 * 2026-08-20, `code=1006` each time, with a 30 s keepalive running throughout,
 * so it is a lifetime cap and not an idle timeout. Reconnecting afterwards
 * costs five seconds in which the proxy does not exist as far as the registry
 * is concerned, and a viewer arriving then is told there is no proxy.
 *
 * What is pinned here is the property that removes that window: at no instant
 * is the server without a registered connection for this proxy.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketServer } from "ws";

import { createTunnelClient } from "../services/tunnel-client.js";

/**
 * A stand-in for the registry's tunnel endpoint, with the one behaviour that
 * matters here: a new connection for a proxy REPLACES the previous one, which
 * is what `registerConnection` does in `server/services/proxy-tunnel-server.js`.
 *
 * @returns {Promise<{ url: string, close: () => Promise<void>, registered: () => number, opened: () => number, everEmpty: () => boolean }>}
 */
async function startRegistry() {
  const server = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => { server.on("listening", resolve); });
  /** @type {import("ws").WebSocket | null} */
  let current = null;
  let opened = 0;
  let everEmpty = false;
  server.on("connection", (socket) => {
    opened += 1;
    const previous = current;
    current = socket;
    // The replacement is registered BEFORE the old one is closed, so a reader
    // of `current` never sees nothing.
    if (previous && previous.readyState < 2) {
      previous.close(1000, "replaced");
    }
    socket.on("close", () => {
      if (current === socket) {
        current = null;
        everEmpty = true;
      }
    });
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => { server.close(resolve); }),
    registered: () => (current && current.readyState === 1 ? 1 : 0),
    killCurrent: () => { current?.terminate(); },
    opened: () => opened,
    everEmpty: () => everEmpty
  };
}

test("the connection is replaced before its lifetime runs out, without a gap", async (t) => {
  const registry = await startRegistry();
  /** @type {string[]} */
  const lines = [];
  const client = createTunnelClient({
    serverUrl: registry.url,
    proxyId: "p1",
    token: "t",
    proxyPort: 9090,
    onLog: (line) => lines.push(line),
    // The real cap is 100 min 15 s and the real renewal is at 90 min; the
    // ratio is what matters, not the magnitude.
    connectionLifetimeMs: 150
  });
  t.after(async () => {
    client.disconnect();
    await registry.close();
  });

  client.connect();
  // Long enough for several renewals at 150 ms each.
  await new Promise((resolve) => { setTimeout(resolve, 700); });

  assert.ok(registry.opened() >= 3, `expected several renewals, saw ${registry.opened()}`);
  // The property this exists for: the registry was never left with nothing.
  assert.equal(registry.everEmpty(), false, "the registry lost its connection at some point");
  assert.equal(registry.registered(), 1);
  // And the proxy knows the difference between a handover and going down. A
  // "Reconnecting in" line here would mean it had treated its own renewal as a
  // failure and waited five seconds before coming back.
  assert.ok(lines.some((line) => line.includes("Tunnel renewing")), lines.join("\n"));
  assert.ok(lines.some((line) => line.includes("Tunnel handed over")), lines.join("\n"));
  assert.equal(lines.filter((line) => line.includes("Reconnecting in")).length, 0, lines.join("\n"));
});

test("a connection killed from outside is still reconnected", async (t) => {
  const registry = await startRegistry();
  /** @type {string[]} */
  const lines = [];
  const client = createTunnelClient({
    serverUrl: registry.url,
    proxyId: "p2",
    token: "t",
    proxyPort: 9090,
    onLog: (line) => lines.push(line),
    // Far longer than this test runs, so nothing renews and the only close is
    // the one forced below — which is what the upstream cap looks like from
    // here: an abrupt end nobody asked for.
    connectionLifetimeMs: 60_000
  });
  t.after(async () => {
    client.disconnect();
    await registry.close();
  });

  client.connect();
  await new Promise((resolve) => { setTimeout(resolve, 200); });
  assert.equal(registry.opened(), 1);

  registry.killCurrent();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
  // The renewal must not have taken the ordinary reconnect away with it.
  assert.ok(lines.some((line) => line.includes("Reconnecting in")), lines.join("\n"));
});
