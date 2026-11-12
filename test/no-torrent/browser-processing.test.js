/**
 * @file The browser's processing of a fragment, measured from the page's own
 * samples (torrent-tv/meta#260): the parse after the load ended plus the
 * largest per-SourceBuffer sum of the fragment's append execute spans, and a
 * track's rate as the total of that work over the total of the bytes.
 */

import assert from "node:assert/strict";
import test from "node:test";

// Loaded inside each test, so that until the module exists each test fails on
// its own and the file still runs.
async function browserProcessingOf(fragmentSamples, appendSamples) {
  const module = await import("../../services/viewer/browser-processing.js");
  return module.browserProcessingOf(fragmentSamples, appendSamples);
}

const UNMEASURED = { reason: "browser-processing-unmeasured" };

/** A fragment sample as the page reports it; ages are ms before the snapshot. */
function fragment({ id = "main:0:1:3:12:", bytes = 1500, loadEnd = 1000, parseStart = 1100, parseEnd = 900,
  bufferingEnd = 850 } = {}) {
  return { bytes, elapsedMs: 40, ageMs: parseEnd, fragmentId: id, fragmentSequence: 3, partIndex: null,
    fragmentStartSeconds: 12, parseElapsedMs: 20, bufferingElapsedMs: 5, bufferingAgeMs: bufferingEnd,
    eventAgesMs: { loadStart: loadEnd + 30, loadFirstByte: loadEnd + 20, loadEnd, parseStart, parseEnd,
      bufferingStart: bufferingEnd + 5, bufferingEnd } };
}

/** An append sample as the page reports it. */
function append(id, executeMs, extra = {}) {
  return { bytes: 700, elapsedMs: 90, ageMs: 860, fragmentId: id, fragmentSequence: 3, partIndex: null,
    fragmentStartSeconds: 12, executeMs, ...extra };
}

function fragments(media, init = []) {
  return { init: { samples: init }, media: { samples: media } };
}

function appends({ video = [], audio = [], videoInit = [], audioInit = [] } = {}) {
  return { video: { init: { samples: videoInit }, media: { samples: video } },
    audio: { init: { samples: audioInit }, media: { samples: audio } } };
}

function assertMeasured(actual, expected) {
  assert.deepEqual(Object.keys(actual).sort(), ["bytes", "fragments", "seconds", "secondsPerByte"]);
  assert.equal(actual.fragments, expected.fragments, "fragments");
  assert.equal(actual.bytes, expected.bytes, "bytes");
  assert.ok(Math.abs(actual.seconds - expected.seconds) < 1e-12, `seconds ${actual.seconds}`);
  assert.ok(Math.abs(actual.secondsPerByte - expected.secondsPerByte) < 1e-15,
    `secondsPerByte ${actual.secondsPerByte}`);
}

test("a parse that started during the load is clipped to the end of the load", { todo: "AC-1" }, async () => {
  // Parse 1100 -> 900 ms before the snapshot, load ended at 1000: 100 ms of
  // parse, plus 50 ms of append execution, over 1500 bytes.
  const result = await browserProcessingOf(fragments([fragment()]), appends({ video: [append("main:0:1:3:12:", 50)] }));

  assertMeasured(result, { secondsPerByte: 0.0001, fragments: 1, bytes: 1500, seconds: 0.15 });
});

test("a parse that ended before the load ended charges no parse time", { todo: "AC-1" }, async () => {
  const result = await browserProcessingOf(fragments([fragment({ loadEnd: 500, parseStart: 900, parseEnd: 600,
    bufferingEnd: 400 })]), appends({ video: [append("main:0:1:3:12:", 30)] }));

  assertMeasured(result, { secondsPerByte: 0.03 / 1500, fragments: 1, bytes: 1500, seconds: 0.03 });
});

test("a fragment buffered at the snapshot with zero parse and execute spans is a measurement of zero work",
  { todo: "AC-1" }, async () => {
    const result = await browserProcessingOf(fragments([fragment({ loadEnd: 0, parseStart: 0, parseEnd: 0,
      bufferingEnd: 0 })]), appends({ video: [append("main:0:1:3:12:", 0)] }));

    assertMeasured(result, { secondsPerByte: 0, fragments: 1, bytes: 1500, seconds: 0 });
  });

test("a muxed fragment's appends to separate buffers count as parallel: the larger buffer sum",
  { todo: "AC-2" }, async () => {
    const id = "main:0:1:7:28:";
    const result = await browserProcessingOf(
      fragments([fragment({ id, bytes: 6000, loadEnd: 100, parseStart: 90, parseEnd: 80, bufferingEnd: 10 })]),
      appends({ video: [append(id, 20), append(id, 30)], audio: [append(id, 15)] }));

    // 10 ms of parse + max(20 + 30, 15) ms of appends.
    assertMeasured(result, { secondsPerByte: 0.06 / 6000, fragments: 1, bytes: 6000, seconds: 0.06 });
  });

test("a fragment whose only appends went to the other buffer is measured by them", { todo: "AC-2" }, async () => {
  const id = "main:0:1:7:28:";
  const result = await browserProcessingOf(
    fragments([fragment({ id, bytes: 1000, loadEnd: 100, parseStart: 90, parseEnd: 80, bufferingEnd: 10 })]),
    appends({ audio: [append(id, 40)] }));

  assertMeasured(result, { secondsPerByte: 0.05 / 1000, fragments: 1, bytes: 1000, seconds: 0.05 });
});

test("a track's rate is its total work over its total bytes, not a mean of per-fragment rates",
  { todo: "AC-2" }, async () => {
    // 1000 bytes in 10 ms and 3000 bytes in 50 ms: 60 ms over 4000 bytes
    // (a mean of the two ratios would be 1/75 ms per byte).
    const result = await browserProcessingOf(fragments([
      fragment({ id: "a", bytes: 1000, loadEnd: 300, parseStart: 300, parseEnd: 296, bufferingEnd: 200 }),
      fragment({ id: "b", bytes: 3000, loadEnd: 150, parseStart: 150, parseEnd: 130, bufferingEnd: 50 })
    ]), appends({ video: [append("a", 6), append("b", 30)] }));

    assertMeasured(result, { secondsPerByte: 0.06 / 4000, fragments: 2, bytes: 4000, seconds: 0.06 });
  });

/** One usable fragment "good" (100 + 50 ms over 1500 bytes) beside the one under test. */
async function withGood(other, otherAppends = {}) {
  const good = fragment({ id: "good" });
  return await browserProcessingOf(fragments([good, other]),
    appends({ ...otherAppends, video: [append("good", 50), ...(otherAppends.video ?? [])] }));
}

const GOOD_ONLY = { secondsPerByte: 0.0001, fragments: 1, bytes: 1500, seconds: 0.15 };

test("a fragment not yet buffered is skipped", { todo: "AC-3" }, async () => {
  const result = await withGood(fragment({ id: "other", bufferingEnd: null }), { video: [append("other", 500)] });

  assertMeasured(result, GOOD_ONLY);
});

test("a fragment without its load end or parse marks is skipped", { todo: "AC-3" }, async () => {
  for (const mark of ["loadEnd", "parseStart", "parseEnd"]) {
    const result = await withGood(fragment({ id: "other", [mark]: null }), { video: [append("other", 500)] });

    assertMeasured(result, GOOD_ONLY);
  }
});

test("a fragment with no append sample of its identity is skipped", { todo: "AC-3" }, async () => {
  const result = await withGood(fragment({ id: "other" }), { video: [append("another", 500)] });

  assertMeasured(result, GOOD_ONLY);
});

test("a fragment with one append lacking a usable execute span is skipped whole, not counted in part",
  { todo: "AC-3" }, async () => {
    for (const executeMs of [null, undefined, -1, Number.NaN]) {
      const result = await withGood(fragment({ id: "other" }),
        { video: [append("other", 500)], audio: [append("other", executeMs)] });

      assertMeasured(result, GOOD_ONLY);
    }
    const absent = append("other", 0);
    delete absent.executeMs;
    assertMeasured(await withGood(fragment({ id: "other" }), { video: [append("other", 500), absent] }), GOOD_ONLY);
  });

test("a fragment whose bytes are not a positive integer is skipped", { todo: "AC-3" }, async () => {
  for (const bytes of [0, -1500, 1.5, Number.NaN, "1500", null]) {
    const result = await withGood(fragment({ id: "other", bytes }), { video: [append("other", 500)] });

    assertMeasured(result, GOOD_ONLY);
  }
});

test("both samples of a fragment loaded twice are skipped", { todo: "AC-3" }, async () => {
  // The appends join by identity only, so which belong to which load is not shown.
  const good = fragment({ id: "good" });
  const result = await browserProcessingOf(fragments([good, fragment({ id: "twice" }), fragment({ id: "twice" })]),
    appends({ video: [append("good", 50), append("twice", 500), append("twice", 500)] }));

  assertMeasured(result, GOOD_ONLY);
});

test("a fragment without an identity is skipped", { todo: "AC-3" }, async () => {
  for (const id of ["", null]) {
    const result = await withGood(fragment({ id }), { video: [append(id, 500)] });

    assertMeasured(result, GOOD_ONLY);
  }
});

test("with no usable fragment the track is unmeasured", { todo: "AC-3" }, async () => {
  assert.deepEqual(await browserProcessingOf(fragments([fragment({ bufferingEnd: null })]),
    appends({ video: [append("main:0:1:3:12:", 50)] })), UNMEASURED);
  assert.deepEqual(await browserProcessingOf(fragments([]), appends()), UNMEASURED, "no sample at all");
});

test("absent inputs leave the track unmeasured", { todo: "AC-3" }, async () => {
  const usable = fragments([fragment()]);
  const usableAppends = appends({ video: [append("main:0:1:3:12:", 50)] });

  assert.deepEqual(await browserProcessingOf(null, usableAppends), UNMEASURED, "no fragment samples");
  assert.deepEqual(await browserProcessingOf(usable, null), UNMEASURED, "no append samples");
  assert.deepEqual(await browserProcessingOf(null, null), UNMEASURED, "neither");
});

test("init samples never contribute", { todo: "AC-3" }, async () => {
  const init = fragment({ id: "init" });
  assert.deepEqual(await browserProcessingOf(fragments([], [init]),
    appends({ video: [append("init", 50)], videoInit: [append("init", 50)] })), UNMEASURED,
  "an init fragment sample is not a media fragment");

  // The media fragment's own work: an init append under its identity adds nothing.
  const result = await browserProcessingOf(fragments([fragment()]),
    appends({ video: [append("main:0:1:3:12:", 50)], videoInit: [append("main:0:1:3:12:", 900)] }));
  assertMeasured(result, GOOD_ONLY);
});
