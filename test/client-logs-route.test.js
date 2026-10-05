import assert from "node:assert/strict";
import test from "node:test";

import { handleApiClientLogsPost } from "../routes/api/client-logs/post.js";

/**
 * Post one body and return the lines the route wrote.
 *
 * @param {object} body
 * @returns {Promise<string[]>}
 */
async function linesWrittenFor(body) {
  /** @type {string[]} */
  const written = [];
  const reply = { code: () => reply, send: () => reply };
  await handleApiClientLogsPost({ body }, reply, {
    clientLogs: { write: (_session, lines) => written.push(...lines) }
  });
  return written;
}

const line = { level: "info", ts: "12:00:00.000", msg: "hello" };

test("each line names the page's send it came in, so the two receivers can be compared", async () => {
  assert.deepEqual(await linesWrittenFor({ tag: "Windows/Chrome", seq: 12, lines: [line] }), [
    "[Windows/Chrome batch=12] 12:00:00.000 info: hello"
  ]);
});

test("a page that numbers nothing is written as before", async () => {
  assert.deepEqual(await linesWrittenFor({ tag: "Windows/Chrome", seq: "12", lines: [line] }), [
    "[Windows/Chrome] 12:00:00.000 info: hello"
  ]);
});
