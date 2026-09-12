/**
 * @file An established fact is said once, then with decreasing frequency.
 *
 * Field 2026-09-12: one absent piece produced 235 000 lines in 92 minutes —
 * about 55 a second, 68.8 % of them byte-identical repeats — and it turned the
 * log file over twice, so the beginning of the failure was gone before anybody
 * read it. A log is not spoilt by its size; it is spoilt by uniformity.
 *
 * Matched verbatim, the whole line: that catches nearly all of the flood and
 * cannot merge two different statements. Normalising numbers would catch a
 * little more and would also merge the memory series, which exists precisely to
 * catch a runaway.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { logger } from "../utils/logger.js";

/** What reached the console while `body` ran. */
function captured(body) {
  const lines = [];
  const real = { log: console.log, warn: console.warn, error: console.error };
  console.log = (line) => lines.push(String(line));
  console.warn = (line) => lines.push(String(line));
  console.error = (line) => lines.push(String(line));
  try {
    body();
  } finally {
    console.log = real.log;
    console.warn = real.warn;
    console.error = real.error;
  }
  return lines;
}

/** A line no other test in this process will have said. */
function unique(what) {
  return `logger-repeats ${what} ${Math.random().toString(36).slice(2)}`;
}

test("the first time is said, and the repeats right behind it are not", () => {
  const message = unique("flood");
  const lines = captured(() => {
    for (let at = 0; at < 500; at += 1) {
      logger.info(message);
    }
  });
  assert.equal(lines.length, 1, "five hundred identical lines are one fact");
  assert.ok(lines[0].includes(message));
});

test("two different lines are both said — repeats are matched whole", () => {
  const one = unique("one");
  const other = unique("other");
  const lines = captured(() => {
    logger.info(one);
    logger.info(other);
    logger.info(one);
    logger.info(other);
  });
  assert.equal(lines.length, 2, "different statements never merge");
  assert.ok(lines[0].includes(one));
  assert.ok(lines[1].includes(other));
});

test("a line whose numbers differ is a different line", () => {
  const stem = unique("rss");
  const lines = captured(() => {
    logger.info(`${stem} rss=327MB`);
    logger.info(`${stem} rss=726MB`);
    logger.info(`${stem} rss=4616MB`);
  });
  assert.equal(
    lines.length,
    3,
    "the memory series exists to catch a runaway; suppressing it would be worse than the flood"
  );
});

test("when it is said again, it says how many were held back", async () => {
  const message = unique("counted");
  const first = captured(() => {
    logger.info(message);
    for (let at = 0; at < 9; at += 1) {
      logger.info(message);
    }
  });
  assert.equal(first.length, 1);

  // The first interval is a second. Waited for rather than assumed: this asks
  // the logger itself when it is ready to speak again, with a deadline as a
  // backstop.
  const deadline = Date.now() + 10_000;
  let later = [];
  while (later.length === 0) {
    if (Date.now() > deadline) {
      assert.fail("the line should be said again once its interval has passed");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    later = captured(() => logger.info(message));
  }
  const said = later[0].match(/\[said (\d+) more time\(s\) in the last ([0-9.]+)s\]/);
  assert.ok(said, `the rate is the fact here, and must be stated: ${later[0]}`);
  // At least the nine held back above. Each poll that found nothing said the
  // line again and was itself held back, so the exact figure belongs to how
  // often this test asked — the property being pinned is that the held-back
  // count is reported at all, and that it counts every one of them.
  assert.ok(Number(said[1]) >= 9, `held-back count too low: ${later[0]}`);
  assert.ok(Number(said[2]) > 0, `the span it covers must be stated: ${later[0]}`);
});

test("every level goes through the same rule", () => {
  const message = unique("levels");
  const lines = captured(() => {
    logger.warn(message);
    logger.warn(message);
    logger.error(message);
  });
  assert.equal(lines.length, 1, "a flood of errors is still a flood");
});
