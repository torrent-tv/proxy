/**
 * @file What the machine can spare for a new encoder — and what must not be
 * charged twice.
 *
 * The numbers are the addon host's own, measured 2026-08-17 while a 240p step
 * ran at 1.01-1.12x against a prediction of 1.83x.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { availableShareFrom, correctForAvailability } from "../../services/encode/available-share.js";

test("other processes' work is what the download is divided from; an encoder also loses the proxy's own", () => {
  // The field reading: the box is saturated, our encoder has more than half of
  // it, and the proxy's own work a fifth.
  const availability = availableShareFrom({ systemBusy: 0.99, encoderShare: 0.56, proxyShare: 0.2 });

  assert.equal(availability.known, true);
  // 0.99 − 0.76 = 0.23 belongs to the kernel, the container and whatever else
  // the owner runs: what the proxy's room is (`share`), which the download's
  // share of it is divided from.
  assert.ok(Math.abs(availability.unattributed - 0.23) < 1e-9, `${availability.unattributed}`);
  assert.ok(Math.abs(availability.share - 0.77) < 1e-9, `${availability.share}`);
  // An encoder gets what the proxy leaves as well: 1 − (0.99 − 0.56). The
  // proxy's processor is charged here and nowhere else, since no price per
  // megabyte is charged to an encoder (torrent-tv/meta#178).
  assert.ok(Math.abs(availability.forEncoders - 0.57) < 1e-9, `${availability.forEncoders}`);
});

test("a quiet machine leaves an encoder everything but what the proxy itself takes", () => {
  const availability = availableShareFrom({ systemBusy: 0.05, encoderShare: 0.04, proxyShare: 0.01 });
  assert.equal(availability.unattributed, 0);
  assert.equal(availability.share, 1);
  assert.ok(Math.abs(correctForAvailability(4, availability) - 3.96) < 1e-9);
});

test("a host that cannot say says so, and nothing is corrected", () => {
  // Not every host has /proc. An uncorrected figure is honest; a figure
  // corrected by an invented share is not.
  const availability = availableShareFrom({ systemBusy: null, encoderShare: null, proxyShare: null });
  assert.equal(availability.known, false);
  assert.equal(availability.share, 1);
  assert.equal(availability.forEncoders, 1);
  assert.equal(correctForAvailability(2.5, availability), 2.5, "an unknown machine leaves the prediction alone");
  assert.equal(availableShareFrom().known, false);
});

test("readings that overlap by a rounding do not produce a negative machine", () => {
  // The two samples are taken microseconds apart, so our own share can come out
  // fractionally above the system total.
  const availability = availableShareFrom({ systemBusy: 0.60, encoderShare: 0.58, proxyShare: 0.05 });
  assert.equal(availability.unattributed, 0);
  assert.equal(availability.share, 1);
  assert.ok(Math.abs(availability.forEncoders - 0.98) < 1e-9);
  assert.ok(availableShareFrom({ systemBusy: 0.4, encoderShare: 0.5, proxyShare: 0 }).forEncoders <= 1);
});

test("a machine given over entirely to other work leaves nothing", () => {
  const availability = availableShareFrom({ systemBusy: 1, encoderShare: 0, proxyShare: 0 });
  assert.equal(availability.share, 0);
  assert.equal(correctForAvailability(4, availability), 0, "a step cannot be offered on a machine with nothing left");
});

test("the correction is proportional, and only ever downwards", () => {
  const availability = availableShareFrom({ systemBusy: 0.99, encoderShare: 0.56, proxyShare: 0.2 });
  // The field case: a step predicted at 1.83x on a quiet box ran at
  // 1.01-1.12x. What other processes leave predicted 1.41x; what the proxy
  // leaves as well predicts 1.04x, inside what was measured.
  const corrected = correctForAvailability(1.83, availability);
  assert.ok(Math.abs(corrected - 1.0431) < 0.001, `${corrected}`);
  assert.ok(corrected >= 1.01 && corrected <= 1.12, "the prediction falls where the step ran");
});

test("nothing is corrected without a prediction to correct", () => {
  const availability = availableShareFrom({ systemBusy: 0.99, encoderShare: 0.5, proxyShare: 0.2 });
  assert.equal(correctForAvailability(0, availability), 0);
  assert.equal(correctForAvailability(Number.NaN, availability), Number.NaN);
  assert.equal(correctForAvailability(-1, availability), -1);
});
