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
 * Wait for the thing being asserted, not for a length of time.
 *
 * A chosen interval followed by an assertion does not test — it samples, and
 * what it samples is how busy the machine is. The deadline here is a backstop
 * that turns a hang into a failure; it is never the measurement.
 *
 * @param {() => boolean} until
 * @param {string} what - Named in the failure, since a timeout otherwise says
 *   only that something did not happen.
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
  /** Every socket ever accepted, so the server can be shut without waiting. */
  const accepted = new Set();
  server.on("connection", (socket) => {
    opened += 1;
    accepted.add(socket);
    socket.on("close", () => { accepted.delete(socket); });
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
    // `close` waits for every connection to end, and a renewal can leave one
    // still closing, so they are ended here rather than waited on.
    close: () => new Promise((resolve) => {
      for (const socket of accepted) {
        socket.terminate();
      }
      accepted.clear();
      server.close(() => resolve());
    }),
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
  // Until the renewals have happened, however long this machine takes over
  // them. Waited out as 700 ms instead — about four lifetimes — this asserted
  // how many the scheduler had got round to.
  await waitFor(() => registry.opened() >= 3, "three connections");

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
  await waitFor(() => registry.opened() === 1, "the first connection");
  // And exactly one: the lifetime above is far longer than this test runs, so
  // nothing renews and a second would mean something else had opened it.
  assert.equal(registry.opened(), 1);

  registry.killCurrent();
  // The renewal must not have taken the ordinary reconnect away with it.
  await waitFor(
    () => lines.some((line) => line.includes("Reconnecting in")),
    "the reconnect after a connection was killed from outside"
  );
});
