/**
 * @file One function forwards a relayed request to the proxy's own HTTP server
 * (torrent-tv/meta#281, OpenSpec change `loopback-forward`).
 *
 * Every forwarded call comes from 127.0.0.1, and some routes trust loopback
 * (`/encode-input/*`, `/media`). So the forwarder refuses every path outside
 * the browser's route set, and every body over 32 MiB, before it opens a
 * connection. What it does forward reaches the local server with the local
 * host, the relayed request's id, the query and the body, and a redirect comes
 * back to the caller rather than being followed.
 *
 * The local server here is a stand-in on 127.0.0.1 at a free port; no proxy
 * route and no torrent is started.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  forwardToLoopback,
  isValidRequestPath,
  LoopbackRefusal,
  MAX_REQUEST_BODY_BYTES
} from "../../services/transport/loopback-forward.js";
import { cutOffAfter, startLoopbackServer } from "./helpers/loopback-server.js";

/** A request to `server` with the fields every call needs. */
function requestTo(server, overrides = {}) {
  return {
    port: server.port,
    requestId: "req-1",
    method: "GET",
    path: "/api/sources",
    query: "",
    headers: {},
    body: null,
    signal: new AbortController().signal,
    ...overrides
  };
}

/**
 * Asserts that `promise` rejects with a refusal carrying `message`.
 *
 * @param {Promise<unknown>} promise
 * @param {string} message
 */
async function assertRefused(promise, message) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof LoopbackRefusal, `expected a LoopbackRefusal, got ${error}`);
    assert.ok(error instanceof Error);
    assert.equal(error.name, "LoopbackRefusal");
    assert.equal(error.message, message);
    return true;
  });
}

/**
 * Makes one allowed request after a refused one and checks that only the
 * allowed one reached the server: had the refused request opened a
 * connection, it would have been seen by the time the allowed one is answered.
 */
async function assertOnlyLaterRequestArrived(server) {
  const response = await forwardToLoopback(requestTo(server, { path: "/healthz" }));
  await response.arrayBuffer();
  assert.deepEqual(server.requests.map((request) => request.url), ["/healthz"]);
}

// ── Path allowlist ───────────────────────────────────────────────────────────

test("the browser's routes are valid request paths", () => {
  for (const path of ["/api/sources", "/stream", "/stream?x=1", "/transcode/a/b", "/health", "/healthz", "/health?x"]) {
    assert.equal(isValidRequestPath(path), true, path);
  }
});

test("loopback-only routes are not valid request paths", () => {
  for (const path of ["/encode-input/1/0", "/media?url=x", "/media"]) {
    assert.equal(isValidRequestPath(path), false, path);
  }
});

test("a path with a traversal sequence is not valid even under an allowed prefix", () => {
  assert.equal(isValidRequestPath("/api/../encode-input/1/0"), false);
});

test("a path that is not absolute is not valid", () => {
  assert.equal(isValidRequestPath("api/sources"), false);
  assert.equal(isValidRequestPath("transcode/a"), false);
});

test("a path that only starts like an allowed route is not valid", () => {
  assert.equal(isValidRequestPath("/streamx"), false);
  assert.equal(isValidRequestPath("/healthzz"), false);
});

test("an empty path and the root are not valid", () => {
  assert.equal(isValidRequestPath(""), false);
  assert.equal(isValidRequestPath("/"), false);
});

test("a path that is not a string is not valid", () => {
  for (const path of [undefined, null, 42]) {
    assert.equal(isValidRequestPath(path), false, String(path));
  }
});

// ── Refusals before any connection ───────────────────────────────────────────

test("a request for /encode-input/1/0 is refused without a connection to the local server", async (t) => {
  const server = await startLoopbackServer();
  t.after(() => server.close());

  await assertRefused(forwardToLoopback(requestTo(server, { path: "/encode-input/1/0" })), "Invalid request path.");

  assert.equal(server.connections(), 0);
  await assertOnlyLaterRequestArrived(server);
});

test("a request for /media with a query is refused without a connection to the local server", async (t) => {
  const server = await startLoopbackServer();
  t.after(() => server.close());

  await assertRefused(
    forwardToLoopback(requestTo(server, { path: "/media?url=http%3A%2F%2Fexample.test%2Fa.mkv" })),
    "Invalid request path."
  );
  await assertRefused(
    forwardToLoopback(requestTo(server, { path: "/media", query: "url=http%3A%2F%2Fexample.test%2Fa.mkv" })),
    "Invalid request path."
  );

  assert.equal(server.connections(), 0);
  await assertOnlyLaterRequestArrived(server);
});

test("the body cap is 32 MiB", () => {
  assert.equal(MAX_REQUEST_BODY_BYTES, 32 * 1024 * 1024);
});

test("a body one byte over the cap is refused without a connection to the local server", async (t) => {
  const server = await startLoopbackServer();
  t.after(() => server.close());

  await assertRefused(
    forwardToLoopback(requestTo(server, { method: "POST", path: "/api/x", body: Buffer.alloc(MAX_REQUEST_BODY_BYTES + 1, 97) })),
    "Request body too large."
  );

  assert.equal(server.connections(), 0);
  await assertOnlyLaterRequestArrived(server);
});

test("a string body is measured in bytes, not characters, against the cap", async (t) => {
  const server = await startLoopbackServer();
  t.after(() => server.close());
  // Two bytes per character in UTF-8: under the cap in characters, over it in bytes.
  const body = "é".repeat(MAX_REQUEST_BODY_BYTES / 2 + 1);
  assert.ok(body.length <= MAX_REQUEST_BODY_BYTES);

  await assertRefused(forwardToLoopback(requestTo(server, { method: "POST", path: "/api/x", body })), "Request body too large.");

  assert.equal(server.connections(), 0);
});

test("a body of exactly the cap is forwarded whole", async (t) => {
  const server = await startLoopbackServer();
  t.after(() => server.close());

  const response = await forwardToLoopback(
    requestTo(server, { method: "POST", path: "/api/x", body: Buffer.alloc(MAX_REQUEST_BODY_BYTES, 98) })
  );
  await response.arrayBuffer();

  assert.equal(response.status, 200);
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].body.length, MAX_REQUEST_BODY_BYTES);
});

// ── What a forwarded request carries ─────────────────────────────────────────

test("an allowed request reaches the local server at its path and query", async (t) => {
  const server = await startLoopbackServer();
  t.after(() => server.close());

  const response = await forwardToLoopback(requestTo(server, { path: "/api/sources", query: "a=1&b=2" }));
  await response.arrayBuffer();

  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].method, "GET");
  assert.equal(server.requests[0].url, "/api/sources?a=1&b=2");
});

test("an empty query adds no question mark", async (t) => {
  const server = await startLoopbackServer();
  t.after(() => server.close());

  const response = await forwardToLoopback(requestTo(server, { path: "/stream", query: "" }));
  await response.arrayBuffer();

  assert.equal(server.requests[0].url, "/stream");
});

test("the local server sees its own host and the relayed request's id, with the other headers passed on", async (t) => {
  const server = await startLoopbackServer();
  t.after(() => server.close());

  const response = await forwardToLoopback(requestTo(server, {
    requestId: "abc-123",
    path: "/transcode/s/1/index.m3u8",
    headers: { host: "viewer.example.test", range: "bytes=0-99", "x-custom": "kept" }
  }));
  await response.arrayBuffer();

  const { headers } = server.requests[0];
  assert.equal(headers.host, `127.0.0.1:${server.port}`);
  assert.equal(headers["x-ttv-forwarded-request-id"], "abc-123");
  assert.equal(headers.range, "bytes=0-99");
  assert.equal(headers["x-custom"], "kept");
});

test("a request body and method reach the local server unchanged", async (t) => {
  const server = await startLoopbackServer();
  t.after(() => server.close());

  const response = await forwardToLoopback(requestTo(server, {
    method: "POST",
    path: "/api/transcode-sessions",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fileIndex: 3 })
  }));
  await response.arrayBuffer();

  assert.equal(server.requests[0].method, "POST");
  assert.deepEqual(JSON.parse(server.requests[0].body.toString("utf8")), { fileIndex: 3 });
});

test("a request without a body sends none", async (t) => {
  const server = await startLoopbackServer();
  t.after(() => server.close());

  const response = await forwardToLoopback(requestTo(server, { method: "DELETE", path: "/api/sources/x", body: null }));
  await response.arrayBuffer();

  assert.equal(server.requests[0].method, "DELETE");
  assert.equal(server.requests[0].body.length, 0);
});

test("a redirect from the local server is returned to the caller, not followed", async (t) => {
  const server = await startLoopbackServer((request, res) => {
    if (request.url === "/api/moved") {
      res.writeHead(302, { location: "/api/elsewhere" });
      res.end();
      return;
    }
    res.end("followed");
  });
  t.after(() => server.close());

  const response = await forwardToLoopback(requestTo(server, { path: "/api/moved" }));
  await response.arrayBuffer();

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/api/elsewhere");
  assert.deepEqual(server.requests.map((request) => request.url), ["/api/moved"]);
});

test("the answer is handed back unread, for the caller to read", async (t) => {
  const server = await startLoopbackServer((_request, res) => res.end("segment bytes"));
  t.after(() => server.close());

  const response = await forwardToLoopback(requestTo(server, { path: "/stream" }));

  assert.equal(response.bodyUsed, false);
  assert.equal(await response.text(), "segment bytes");
});

// ── Failures that are not refusals ───────────────────────────────────────────

test("a body cut off half-way makes the caller's read fail after the bytes that arrived", async (t) => {
  const server = await startLoopbackServer(cutOffAfter(1000, 5000));
  t.after(() => server.close());

  const response = await forwardToLoopback(requestTo(server, { path: "/stream" }));
  const reader = response.body.getReader();
  let received = 0;
  await assert.rejects(async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      received += value.length;
    }
  });
  assert.equal(received, 1000);
});

test("an already aborted signal rejects, and not as a refusal", async (t) => {
  const server = await startLoopbackServer();
  t.after(() => server.close());
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(forwardToLoopback(requestTo(server, { signal: controller.signal })), (error) => {
    assert.equal(error instanceof LoopbackRefusal, false);
    return true;
  });
});

test("aborting while the local server holds the request rejects, and not as a refusal", async (t) => {
  const controller = new AbortController();
  // The server never answers; the caller gives up once the request has arrived.
  const server = await startLoopbackServer(() => controller.abort());
  t.after(() => server.close());

  await assert.rejects(forwardToLoopback(requestTo(server, { signal: controller.signal })), (error) => {
    assert.equal(error instanceof LoopbackRefusal, false);
    return true;
  });
  assert.equal(server.requests.length, 1);
});

test("a local server that is not listening rejects, and not as a refusal", async () => {
  const server = await startLoopbackServer();
  const { port } = server;
  await server.close();

  await assert.rejects(forwardToLoopback(requestTo({ port })), (error) => {
    assert.equal(error instanceof LoopbackRefusal, false);
    return true;
  });
});
