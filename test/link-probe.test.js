/**
 * @file The route that hands a browser bytes to time its link with.
 *
 * Only this end's half. How big an ask should be is derived on the page, from
 * what its last ask measured, and is checked where that function lives — a copy
 * of it here would be two owners of one rule, which is the fault this
 * repository keeps recording.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { handleApiLinkProbeGet, MAX_LINK_PROBE_BYTES } from "../routes/api/link-probe/get.js";

/**
 * A reply that records what it was given.
 *
 * @returns {{ code: (n: number) => object, header: () => object, send: (b: unknown) => object, status: number | null, body: unknown }}
 */
function fakeReply() {
  const reply = {
    status: /** @type {number | null} */ (null),
    body: /** @type {unknown} */ (null),
    code(n) {
      reply.status = n;
      return reply;
    },
    header() {
      return reply;
    },
    send(body) {
      reply.body = body;
      return reply;
    }
  };
  return reply;
}



test("the route answers exactly what was asked for, up to its own ceiling", async () => {
  const small = fakeReply();
  await handleApiLinkProbeGet({ query: { bytes: "65536" } }, small);
  assert.equal(small.status, 200);
  assert.equal(/** @type {Buffer} */ (small.body).length, 65536);

  const huge = fakeReply();
  await handleApiLinkProbeGet({ query: { bytes: "999999999" } }, huge);
  assert.equal(/** @type {Buffer} */ (huge.body).length, MAX_LINK_PROBE_BYTES);
});

test("the route refuses an ask that is not a size", async () => {
  const reply = fakeReply();
  await handleApiLinkProbeGet({ query: { bytes: "none" } }, reply);
  assert.equal(reply.status, 400);
});
