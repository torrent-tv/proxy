/**
 * @file File claims must be held per reader, not per file.
 *
 * The proxy reads one file from several places at once — ffmpeg's input, the
 * keyframe index, the codec probe, a second viewer. Keying claims by file made
 * them shared, so the first reader to finish released the hold while the others
 * were still reading, and the file's data could then be removed under them.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createFileClaims } from "../services/torrent-worker/file-claims.js";

test("two readers of one file hold two claims", () => {
  const claims = createFileClaims();
  let released = 0;

  const first = claims.open("source", 0, () => (released += 1));
  const second = claims.open("source", 0, () => (released += 1));

  assert.notEqual(first, second, "the second reader reused the first one's claim");
  assert.equal(claims.size, 2);

  claims.close(first);
  assert.equal(released, 1, "closing one claim released more than one hold");
  assert.equal(claims.size, 1, "the second reader's claim went with the first");

  claims.close(second);
  assert.equal(released, 2);
  assert.equal(claims.size, 0);
});

test("a repeated release affects nothing and reports itself", () => {
  const claims = createFileClaims();
  let released = 0;
  const claimId = claims.open("source", 3, () => (released += 1));

  assert.equal(claims.close(claimId), true);
  assert.equal(claims.close(claimId), false, "a second release was accepted as valid");
  assert.equal(released, 1, "the hold was released twice");
});

test("a release naming nothing is rejected rather than guessed at", () => {
  const claims = createFileClaims();
  let released = 0;
  claims.open("source", 0, () => (released += 1));

  assert.equal(claims.close("source:0:999"), false);
  assert.equal(released, 0, "an unknown claim released a real hold");
  assert.equal(claims.size, 1);
});

test("teardown releases every outstanding claim", () => {
  const claims = createFileClaims();
  let released = 0;
  claims.open("a", 0, () => (released += 1));
  claims.open("a", 1, () => (released += 1));
  claims.open("b", 0, () => (released += 1));

  claims.closeAll();

  assert.equal(released, 3);
  assert.equal(claims.size, 0);
});
