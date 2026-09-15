/**
 * @file What the viewer's link can carry, asked with plain numbers.
 *
 * Both of these lived in the session manager, and the first reached for the
 * worst reading among the viewers itself — which is the reach the layer table
 * forbids in as many words: the link is an INPUT to the quality budget, a
 * number, never a thing encoding may go and look at. Here they are two pure
 * functions, which is what makes this file possible at all: no session, no
 * viewer, no clock.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { linkCouldCarry, LINK_SAFETY, peakMbpsForHeight } from "../services/quality/link-budget.js";
import { maxrateKbpsFor, nominalKbpsForHeight } from "../services/encode/args.js";

test("a copied source is priced at the bitrate the file itself states", () => {
  // The one case where the answer is known rather than predicted: copying does
  // not change a stream's bitrate, and the file says what it is.
  const carried = peakMbpsForHeight(
    { sourceHeight: 1080, transcodeVideo: false, sourceMbps: 3.73 },
    1080
  );

  assert.equal(carried, 3.73);
});

test("every other height is priced at the cap its encoder would be held to", () => {
  // Not the nominal rate: the encoder is allowed to peak, and the link has to
  // carry the peak or the picture stops while it catches up.
  const at720 = peakMbpsForHeight({ sourceHeight: 1080, transcodeVideo: true, sourceMbps: 3.73 }, 720);

  assert.equal(at720, maxrateKbpsFor(nominalKbpsForHeight(720)) / 1000);
  assert.notEqual(at720, 3.73, "the source's own bitrate says nothing about a height it is not");
});

test("a picture being re-encoded at the source height is predicted, not taken from the file", () => {
  // Its bytes are not the file's bytes. Pricing it at the source's bitrate was
  // how a re-encode came to be judged against a figure describing a stream
  // nobody was producing.
  const reencoded = peakMbpsForHeight({ sourceHeight: 1080, transcodeVideo: true, sourceMbps: 3.73 }, 1080);

  assert.equal(reencoded, maxrateKbpsFor(nominalKbpsForHeight(1080)) / 1000);
});

test("only part of a measured link is spent on video", () => {
  // The rest is what a link does when it is not being perfect. A step sized to
  // the whole reading stalls on the first retransmission.
  assert.equal(linkCouldCarry(10, 10 * LINK_SAFETY), true, "exactly the usable share fits");
  assert.equal(linkCouldCarry(10, 10 * LINK_SAFETY + 0.01), false, "and a hair more does not");
});

test("a link nothing has measured has no opinion, which is a yes", () => {
  // The same silence that stops the budget acting at all. A no here would
  // refuse every step on every session until the first report arrives — which
  // is exactly the cold open, when the viewer is choosing.
  assert.equal(linkCouldCarry(null, 6), true);
  assert.equal(linkCouldCarry(0, 6), true);
  assert.equal(linkCouldCarry(Number.NaN, 6), true);
});
