/**
 * @file The forwarded session response log (torrent-tv/meta#280, design.md
 * §6.5 A): the same lines as `server.js` wrote, through a Fastify `inject`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { installForwardedResponseLog } from "../../services/server/forwarded-response-log.js";

async function appWith() {
  const lines = { info: [], warn: [] };
  let clock = 100;
  const app = Fastify();
  installForwardedResponseLog(app, {
    log: line => lines.info.push(line),
    warn: line => lines.warn.push(line),
    now: () => (clock += 5)
  });
  app.post("/api/transcode-sessions", async () => ({ ok: true }));
  app.get("/api/other", async () => ({ ok: true }));
  await app.ready();
  return { app, lines };
}

test("a forwarded session request is logged at every stage and at its finish", async () => {
  const { app, lines } = await appWith();
  const response = await app.inject({ method: "POST", url: "/api/transcode-sessions",
    headers: { "x-ttv-forwarded-request-id": "r1" }, payload: {} });
  assert.equal(response.statusCode, 200);
  const stages = lines.info.filter(line => line.startsWith("[forecast-http]"))
    .map(line => /stage=(\S+) requestId=r1 atMs=\d+\.\d{3} elapsedMs=\d+\.\d{3}$/.exec(line)?.[1]);
  // The injected response also reports a close that is not writableFinished; the hook logs it as it does for a real one.
  assert.deepEqual(stages.slice(0, 4), ["onRequest", "preSerialization", "onSend", "finish"]);
  const done = lines.info.find(line => line.startsWith("[http-response]"));
  assert.match(done, /^\[http-response\] requestId=r1 method=POST url=\/api\/transcode-sessions responseMs=\d+\.\d status=200 contentLength=\S+$/);
  await app.close();
});

test("a request without the forwarded id, or to another route, logs nothing", async () => {
  const { app, lines } = await appWith();
  await app.inject({ method: "POST", url: "/api/transcode-sessions", payload: {} });
  await app.inject({ method: "GET", url: "/api/other", headers: { "x-ttv-forwarded-request-id": "r2" } });
  assert.deepEqual(lines, { info: [], warn: [] });
  await app.close();
});
