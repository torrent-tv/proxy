/**
 * @file The browser's processing of a fragment, measured from the page's own
 * samples (torrent-tv/meta#260): the length of the union of its parse span and
 * the execute spans of its appends in every SourceBuffer, each span clipped to
 * start no earlier than the end of its load, so a moment when the page parsed
 * and appended, or appended to two buffers, counts once; and a track's rate as
 * the total of that work over the total of the bytes.
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

/**
 * An append sample as the page reports it. `ageMs` is the age of the end of
 * its execution, so it executed over the ages `[ageMs, ageMs + executeMs]`.
 */
function append(id, executeMs, ageMs) {
  return { bytes: 700, elapsedMs: 90, ageMs, fragmentId: id, fragmentSequence: 3, partIndex: null,
    fragmentStartSeconds: 12, executeMs };
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

test("a parse that started during the load is clipped to the end of the load", async () => {
  // Parse 1100 -> 900 ms before the snapshot, load ended at 1000: 100 ms of
  // parse, plus the append's execution 900 -> 850, over 1500 bytes.
  const result = await browserProcessingOf(fragments([fragment()]),
    appends({ video: [append("main:0:1:3:12:", 50, 850)] }));

  assertMeasured(result, { secondsPerByte: 0.0001, fragments: 1, bytes: 1500, seconds: 0.15 });
});

test("a parse that ended before the load ended charges no parse time", async () => {
  const result = await browserProcessingOf(fragments([fragment({ loadEnd: 500, parseStart: 900, parseEnd: 600,
    bufferingEnd: 400 })]), appends({ video: [append("main:0:1:3:12:", 30, 400)] }));

  assertMeasured(result, { secondsPerByte: 0.03 / 1500, fragments: 1, bytes: 1500, seconds: 0.03 });
});

test("a fragment buffered at the snapshot with zero parse and execute spans is a measurement of zero work",
  async () => {
    const result = await browserProcessingOf(fragments([fragment({ loadEnd: 0, parseStart: 0, parseEnd: 0,
      bufferingEnd: 0 })]), appends({ video: [append("main:0:1:3:12:", 0, 0)] }));

    assertMeasured(result, { secondsPerByte: 0, fragments: 1, bytes: 1500, seconds: 0 });
  });

test("an append that executes while the parse runs counts once", async () => {
  // Parse 100 -> 60, append 70 -> 20: the page worked 100 -> 20, 80 ms, not
  // 40 + 50 ms.
  const result = await browserProcessingOf(fragments([fragment({ bytes: 1000, loadEnd: 100, parseStart: 100,
    parseEnd: 60, bufferingEnd: 20 })]), appends({ video: [append("main:0:1:3:12:", 50, 20)] }));

  assertMeasured(result, { secondsPerByte: 0.00008, fragments: 1, bytes: 1000, seconds: 0.08 });
});

test("an append that began executing before the load ended counts from the load end",
  async () => {
    // Load ended at 100, parse 150 -> 120 wholly before it; append 130 -> 80
    // counts 100 -> 80.
    const result = await browserProcessingOf(fragments([fragment({ bytes: 1000, loadEnd: 100, parseStart: 150,
      parseEnd: 120, bufferingEnd: 70 })]), appends({ video: [append("main:0:1:3:12:", 50, 80)] }));

    assertMeasured(result, { secondsPerByte: 0.02 / 1000, fragments: 1, bytes: 1000, seconds: 0.02 });
  });

test("a muxed fragment's appends to separate buffers count as parallel: the union of their spans",
  async () => {
    const id = "main:0:1:7:28:";
    const result = await browserProcessingOf(
      fragments([fragment({ id, bytes: 6000, loadEnd: 100, parseStart: 100, parseEnd: 90, bufferingEnd: 40 })]),
      appends({ video: [append(id, 20, 70), append(id, 30, 40)], audio: [append(id, 15, 75)] }));

    // Parse 100 -> 90, picture 90 -> 70 and 70 -> 40, sound 90 -> 75 (inside
    // the picture's first append): the page worked 100 -> 40.
    assertMeasured(result, { secondsPerByte: 0.06 / 6000, fragments: 1, bytes: 6000, seconds: 0.06 });
  });

test("appends to separate buffers that execute at the same time count that time once",
  async () => {
    const id = "main:0:1:8:32:";
    const result = await browserProcessingOf(
      fragments([fragment({ id, bytes: 1000, loadEnd: 100, parseStart: 100, parseEnd: 90, bufferingEnd: 50 })]),
      appends({ video: [append(id, 20, 60)], audio: [append(id, 20, 50)] }));

    // Parse 100 -> 90, picture 80 -> 60, sound 70 -> 50: 10 + 30 ms, not
    // 10 + 40 (the shared 70 -> 60 twice) and not 10 + 20 (one buffer only).
    assertMeasured(result, { secondsPerByte: 0.04 / 1000, fragments: 1, bytes: 1000, seconds: 0.04 });
  });

test("a fragment whose only appends went to the other buffer is measured by them", async () => {
  const id = "main:0:1:7:28:";
  const result = await browserProcessingOf(
    fragments([fragment({ id, bytes: 1000, loadEnd: 100, parseStart: 90, parseEnd: 80, bufferingEnd: 10 })]),
    appends({ audio: [append(id, 40, 20)] }));

  assertMeasured(result, { secondsPerByte: 0.05 / 1000, fragments: 1, bytes: 1000, seconds: 0.05 });
});

test("a track's rate is its total work over its total bytes, not a mean of per-fragment rates",
  async () => {
    // 1000 bytes in 10 ms and 3000 bytes in 50 ms: 60 ms over 4000 bytes
    // (a mean of the two ratios would be 1/75 ms per byte).
    const result = await browserProcessingOf(fragments([
      fragment({ id: "a", bytes: 1000, loadEnd: 300, parseStart: 300, parseEnd: 296, bufferingEnd: 200 }),
      fragment({ id: "b", bytes: 3000, loadEnd: 150, parseStart: 150, parseEnd: 130, bufferingEnd: 50 })
    ]), appends({ video: [append("a", 6, 200), append("b", 30, 50)] }));

    assertMeasured(result, { secondsPerByte: 0.06 / 4000, fragments: 2, bytes: 4000, seconds: 0.06 });
  });

/** One usable fragment "good" (100 + 50 ms over 1500 bytes) beside the one under test. */
async function withGood(other, otherAppends = {}) {
  const good = fragment({ id: "good" });
  return await browserProcessingOf(fragments([good, other]),
    appends({ ...otherAppends, video: [append("good", 50, 850), ...(otherAppends.video ?? [])] }));
}

/**
 * Age of a 500 ms append of a skipped fragment with the default ages: it ends
 * at the fragment's buffering end, so it is an append of this load, and the
 * fragment would be counted if it were used.
 */
const OTHER_AGE = 850;

const GOOD_ONLY = { secondsPerByte: 0.0001, fragments: 1, bytes: 1500, seconds: 0.15 };

test("a fragment not yet buffered is skipped", async () => {
  const result = await withGood(fragment({ id: "other", bufferingEnd: null }),
    { video: [append("other", 500, OTHER_AGE)] });

  assertMeasured(result, GOOD_ONLY);
});

test("a fragment without its load end or parse marks is skipped", async () => {
  for (const mark of ["loadEnd", "parseStart", "parseEnd"]) {
    const result = await withGood(fragment({ id: "other", [mark]: null }),
      { video: [append("other", 500, OTHER_AGE)] });

    assertMeasured(result, GOOD_ONLY);
  }
});

test("a fragment with no append sample of its identity is skipped", async () => {
  const result = await withGood(fragment({ id: "other" }), { video: [append("another", 500, OTHER_AGE)] });

  assertMeasured(result, GOOD_ONLY);
});

test("a fragment with one append lacking a usable execute span is skipped whole, not counted in part",
  async () => {
    for (const executeMs of [null, undefined, -1, Number.NaN]) {
      const result = await withGood(fragment({ id: "other" }),
        { video: [append("other", 500, OTHER_AGE)], audio: [append("other", executeMs, OTHER_AGE)] });

      assertMeasured(result, GOOD_ONLY);
    }
    const absent = append("other", 0, OTHER_AGE);
    delete absent.executeMs;
    assertMeasured(await withGood(fragment({ id: "other" }), { video: [append("other", 500, OTHER_AGE), absent] }),
      GOOD_ONLY);
  });

test("a fragment with one append lacking a usable age is skipped whole", async () => {
  for (const ageMs of [null, -1, Number.NaN]) {
    const result = await withGood(fragment({ id: "other" }),
      { video: [append("other", 500, OTHER_AGE)], audio: [append("other", 20, ageMs)] });

    assertMeasured(result, GOOD_ONLY);
  }
});

test("an append of a later load of the same fragment is not charged to this load", { todo: "AC-3" },
  async () => {
    // Load ended at 1000, parse 1000 -> 990, buffered at 950; its own append
    // 960 -> 950. An append under the same identity that ended at 10, after
    // the fragment was buffered, belongs to a later load: 20 ms, not 50 ms.
    const id = "main:0:1:9:36:";
    const result = await browserProcessingOf(
      fragments([fragment({ id, bytes: 1000, loadEnd: 1000, parseStart: 1000, parseEnd: 990, bufferingEnd: 950 })]),
      appends({ video: [append(id, 10, 950), append(id, 30, 10)] }));

    assertMeasured(result, { secondsPerByte: 0.02 / 1000, fragments: 1, bytes: 1000, seconds: 0.02 });
  });

test("a later load's append without an execute span does not void the fragment", { todo: "AC-3" },
  async () => {
    const id = "main:0:1:9:36:";
    const result = await browserProcessingOf(
      fragments([fragment({ id, bytes: 1000, loadEnd: 1000, parseStart: 1000, parseEnd: 990, bufferingEnd: 950 })]),
      appends({ video: [append(id, 10, 950), append(id, null, 10)] }));

    assertMeasured(result, { secondsPerByte: 0.02 / 1000, fragments: 1, bytes: 1000, seconds: 0.02 });
  });

test("an append that ended exactly when the fragment was buffered belongs to it", async () => {
  // Buffered at 950: the append 960 -> 950 is this load's, beside one
  // 980 -> 970; parse 1000 -> 990. 30 ms, not 20 ms.
  const id = "main:0:1:9:36:";
  const result = await browserProcessingOf(
    fragments([fragment({ id, bytes: 1000, loadEnd: 1000, parseStart: 1000, parseEnd: 990, bufferingEnd: 950 })]),
    appends({ video: [append(id, 10, 970), append(id, 10, 950)] }));

  assertMeasured(result, { secondsPerByte: 0.03 / 1000, fragments: 1, bytes: 1000, seconds: 0.03 });
});

test("a fragment whose bytes are not a positive integer is skipped", async () => {
  for (const bytes of [0, -1500, 1.5, Number.NaN, "1500", null]) {
    const result = await withGood(fragment({ id: "other", bytes }), { video: [append("other", 500, OTHER_AGE)] });

    assertMeasured(result, GOOD_ONLY);
  }
});

test("both samples of a fragment loaded twice are skipped", async () => {
  // The appends join by identity only, so which belong to which load is not shown.
  const good = fragment({ id: "good" });
  const result = await browserProcessingOf(fragments([good, fragment({ id: "twice" }), fragment({ id: "twice" })]),
    appends({ video: [append("good", 50, 850), append("twice", 500, OTHER_AGE), append("twice", 500, OTHER_AGE)] }));

  assertMeasured(result, GOOD_ONLY);
});

test("a fragment without an identity is skipped", async () => {
  for (const id of ["", null]) {
    const result = await withGood(fragment({ id }), { video: [append(id, 500, OTHER_AGE)] });

    assertMeasured(result, GOOD_ONLY);
  }
});

test("with no usable fragment the track is unmeasured", async () => {
  assert.deepEqual(await browserProcessingOf(fragments([fragment({ bufferingEnd: null })]),
    appends({ video: [append("main:0:1:3:12:", 50, 850)] })), UNMEASURED);
  assert.deepEqual(await browserProcessingOf(fragments([]), appends()), UNMEASURED, "no sample at all");
});

test("absent inputs leave the track unmeasured", async () => {
  const usable = fragments([fragment()]);
  const usableAppends = appends({ video: [append("main:0:1:3:12:", 50, 850)] });

  assert.deepEqual(await browserProcessingOf(null, usableAppends), UNMEASURED, "no fragment samples");
  assert.deepEqual(await browserProcessingOf(usable, null), UNMEASURED, "no append samples");
  assert.deepEqual(await browserProcessingOf(null, null), UNMEASURED, "neither");
});

test("init samples never contribute", async () => {
  const init = fragment({ id: "init" });
  assert.deepEqual(await browserProcessingOf(fragments([], [init]),
    appends({ video: [append("init", 50, 850)], videoInit: [append("init", 50, 850)] })), UNMEASURED,
  "an init fragment sample is not a media fragment");

  // The media fragment's own work: an init append under its identity adds nothing.
  const result = await browserProcessingOf(fragments([fragment()]),
    appends({ video: [append("main:0:1:3:12:", 50, 850)],
      videoInit: [append("main:0:1:3:12:", 900, 100)] }));
  assertMeasured(result, GOOD_ONLY);
});

test("the cost is linear in the samples, not fragments times appends", { todo: "AC-3" }, async () => {
  // 200 fragments, each with its own one append, half on each buffer; each
  // works 20 ms (parse 100 -> 90, append 90 -> 80) over 1000 bytes.
  const count = 200;
  let reads = 0;
  /** The append sample, counting each read of its `fragmentId`. */
  function counted(sample) {
    const { fragmentId } = sample;
    Object.defineProperty(sample, "fragmentId", { enumerable: true, configurable: true,
      get() {
        reads += 1;
        return fragmentId;
      } });
    return sample;
  }
  const media = [];
  const video = [];
  const audio = [];
  for (let index = 0; index < count; index += 1) {
    const id = `main:0:1:${index}:${index * 4}:`;
    media.push(fragment({ id, bytes: 1000, loadEnd: 100, parseStart: 100, parseEnd: 90, bufferingEnd: 80 }));
    (index % 2 === 0 ? video : audio).push(counted(append(id, 10, 80)));
  }

  const result = await browserProcessingOf(fragments(media), appends({ video, audio }));

  assertMeasured(result, { secondsPerByte: 4 / 200000, fragments: count, bytes: 200000, seconds: 4 });
  assert.ok(reads <= 3 * count, `fragmentId of ${count} append samples read ${reads} times`);
});
