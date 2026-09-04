/**
 * @file The drawing cannot disagree with the table.
 *
 * `docs/encode-run-state.md` is generated from `services/encode/encode-run-state.js`.
 * A picture kept beside the code drifts — this repository has the receipts —
 * so the check is mechanical: regenerate it and compare. A behavioural change
 * to the table that forgets `npm run graph` fails here, in the same commit.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { GRAPH_DOC_PATH, renderRunGraphMarkdown } from "../scripts/render-run-graph.js";

/**
 * Line endings are not part of the comparison. Git is configured with
 * `autocrlf=true` on the machine this is developed on, so the same file is LF
 * in the index and CRLF in the working tree — and a test failing on that would
 * point at the generator, whose output is always LF, and be unfixable by the
 * remedy it suggests.
 *
 * @param {string} text
 * @returns {string}
 */
function withoutLineEndings(text) {
  return text.replace(/\r\n/g, "\n");
}

test("the committed picture is the one the table produces", () => {
  const committed = readFileSync(GRAPH_DOC_PATH, "utf8");
  assert.equal(
    withoutLineEndings(committed),
    withoutLineEndings(renderRunGraphMarkdown()),
    "docs/encode-run-state.md is out of date — run `npm run graph` and commit the result"
  );
});
