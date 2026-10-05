/**
 * @file What the subtitle walk found reaches the viewer whole.
 *
 * It did not. The walk has produced `detectedLanguage` on every push since
 * 2.69.0 — the language read from the CUES rather than from a container that
 * often states none — and the whole of the "label moves when the answer
 * arrives" behaviour rests on it. It never arrived: the fact was copied by hand
 * twice on its way out, and each copy listed the fields it knew about. The
 * worker posted `trackIndex, cues, language, cursor`; the main thread's client
 * rebuilt the same four from the message. `detectedLanguage` was in neither
 * list, so the browser was told nothing and the label it shows for an untagged
 * track has never moved.
 *
 * It is not a typo to fix in two places — it is the shape. A fact copied field
 * by field loses whatever the copier did not know about, and says nothing when
 * it does. The walk's own result travels now, so a field added to it arrives
 * without anybody being told to forward it.
 *
 * (Both copies are gone anyway: the walk runs on the thread that pushes.)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * @param {string} relative
 * @returns {string}
 */
function source(relative) {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

test("the walk states the language it read from the cues", () => {
  // The producer. Without this the rest of the check is about nothing.
  assert.match(source("services/media/SubtitleCues.js"), /detectedLanguage: detectLanguage\(/);
});

test("the consumer asks for it", () => {
  // The other end has always destructured it, which is what made the loss
  // silent: a field nobody forwards is `undefined` and reads as "not detected".
  assert.match(
    source("services/transport/data-channel-handler.js"),
    /function publishSubtitleCues\(\{[^}]*detectedLanguage[^}]*\}\)/
  );
});

test("the push forwards the whole of what the walk found, rather than a list of fields", () => {
  // The one line that closes it. A list of names here is how the fact was lost
  // twice, and a list cannot say that it is incomplete.
  const wiring = source("server.js");

  assert.match(wiring, /onSubtitleCues\?\.\(\{ sourceKey, fileIndex, \.\.\.entry \}\)/);
});
