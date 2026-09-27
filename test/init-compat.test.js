/**
 * @file The rule that decides whether one output's pieces may be played under
 * another's header — and it is written BEFORE the experiment that will use it.
 *
 * The order matters and was a review finding: a criterion derived from the
 * differences an experiment happened to produce proves only that those
 * differences were handled. This one compares the whole header, names every
 * difference by where it sits, and refuses anything no listed exception covers.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { INIT_DIFFERENCE_EXCEPTIONS, compareInits, initLeaves } from "../services/encode/segment-formats/init-compat.js";

/**
 * One ISO base media box.
 *
 * @param {string} type
 * @param {...(Buffer | number[])} parts
 * @returns {Buffer}
 */
function box(type, ...parts) {
  const body = Buffer.concat(parts.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part))));
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, body]);
}

/**
 * A version-0 `mdhd`: version+flags, creation, modification, timescale,
 * duration, language, quality.
 *
 * @param {number} timescale
 * @returns {Buffer}
 */
function mdhd(timescale) {
  const body = Buffer.alloc(24);
  body.writeUInt32BE(timescale, 12);
  return box("mdhd", body);
}

/**
 * A `btrt`: decoding buffer size, maximum rate, average rate.
 *
 * @param {number} maxBitrate
 * @returns {Buffer}
 */
function btrt(maxBitrate) {
  const body = Buffer.alloc(12);
  body.writeUInt32BE(1875072, 0);
  body.writeUInt32BE(maxBitrate, 4);
  body.writeUInt32BE(maxBitrate, 8);
  return box("btrt", body);
}

/**
 * A `stsd` carrying one visual sample entry: its 78-byte preamble, then the
 * codec configuration, then optionally a bit rate declaration.
 *
 * @param {{ entryType?: string, config?: number[], maxBitrate?: number | null, preamble?: number }} [how]
 * @returns {Buffer}
 */
function stsd({ entryType = "avc1", config = [1, 100, 0, 31], maxBitrate = null, preamble = 78 } = {}) {
  const versionAndCount = Buffer.alloc(8);
  versionAndCount.writeUInt32BE(1, 4);
  const children = [box("avcC", config)];
  if (maxBitrate !== null) {
    children.push(btrt(maxBitrate));
  }
  const entry = box(entryType, Buffer.alloc(preamble), ...children);
  return box("stsd", versionAndCount, entry);
}

/**
 * A whole init segment, shaped as ffmpeg writes one.
 *
 * @param {{ timescale?: number, tracks?: number } & Parameters<typeof stsd>[0]} [how]
 * @returns {Buffer}
 */
function init({ timescale = 90000, tracks = 1, ...entry } = {}) {
  const trak = (index) =>
    box(
      "trak",
      box("tkhd", Buffer.alloc(84, index)),
      box("mdia", mdhd(timescale), box("hdlr", Buffer.alloc(32)), box("minf", box("stbl", stsd(entry))))
    );
  const traks = [];
  for (let index = 0; index < tracks; index += 1) {
    traks.push(trak(index));
  }
  return Buffer.concat([
    box("ftyp", Buffer.from("isom")),
    box("moov", box("mvhd", Buffer.alloc(100)), ...traks, box("mvex", box("trex", Buffer.alloc(24))))
  ]);
}

const ENTRY = "moov[0]/trak[0]/mdia[0]/minf[0]/stbl[0]/stsd[0]/avc1[0]";

test("every exception carries the reason it is one", () => {
  for (const exception of INIT_DIFFERENCE_EXCEPTIONS) {
    assert.ok(exception.why && exception.why.length > 40, `no reason given for ${JSON.stringify(exception)}`);
    assert.ok(
      exception.path !== undefined || exception.sampleEntryBox !== undefined,
      "an exception says WHAT it covers"
    );
  }
});

test("every leaf of the header is named by whose child it is, inside a sample entry too", () => {
  const paths = [...initLeaves(init({ tracks: 2, maxBitrate: 3_000_000 })).keys()];

  assert.ok(paths.includes("moov[0]/trak[0]/mdia[0]/mdhd[0]"), paths.join(" "));
  assert.ok(paths.includes("moov[0]/trak[1]/mdia[0]/mdhd[0]"), "the second track is its own path");
  assert.ok(paths.includes("moov[0]/mvex[0]/trex[0]"));
  assert.ok(
    paths.includes(`${ENTRY}/avcC[0]`),
    "the codec configuration is a leaf of its own, so it can refuse on its own"
  );
  assert.ok(paths.includes(`${ENTRY}/btrt[0]`), "and so is the bit rate declaration");
});

test("one header serves its own pieces", () => {
  const answer = compareInits(init(), init());

  assert.equal(answer.compatible, true);
  assert.deepEqual(answer.differences, []);
});

test("a bit rate declaration is the one difference that does not refuse", () => {
  const answer = compareInits(init({ maxBitrate: 3_000_000 }), init({ maxBitrate: 1_200_000 }));

  assert.equal(answer.compatible, true, answer.differences.join(" | "));
  assert.deepEqual(answer.refusedPaths, []);
  assert.ok(
    answer.differences.some((line) => line.includes("max 3000000") && line.includes("max 1200000")),
    `the difference is still reported, with its numbers: ${answer.differences.join(" | ")}`
  );
});

test("allowing the bit rate does not allow the parameter sets beside it", () => {
  const answer = compareInits(
    init({ maxBitrate: 3_000_000, config: [1, 100, 0, 31] }),
    init({ maxBitrate: 1_200_000, config: [1, 100, 0, 30] })
  );

  assert.equal(answer.compatible, false);
  assert.deepEqual(answer.refusedPaths, [`${ENTRY}/avcC[0]`]);
});

test("the bit rate exception is scoped to a sample entry", () => {
  const strayLeft = box("moov", box("trak", box("mdia", box("minf", box("stbl", btrt(3_000_000))))));
  const strayRight = box("moov", box("trak", box("mdia", box("minf", box("stbl", btrt(1_200_000))))));

  const answer = compareInits(strayLeft, strayRight);

  assert.equal(answer.compatible, false, "a btrt that is nobody's sample entry is not the box the reason is about");
  assert.deepEqual(answer.refusedPaths, ["moov[0]/trak[0]/mdia[0]/minf[0]/stbl[0]/btrt[0]"]);
});

test("a sample entry whose children do not tile is compared whole", () => {
  const answer = compareInits(init({ preamble: 8, config: [1, 100, 0, 31] }), init({ preamble: 8, config: [1, 100, 0, 30] }));

  assert.equal(answer.compatible, false);
  assert.deepEqual(
    answer.refusedPaths,
    [ENTRY],
    "the descent is checked, and where it does not hold the whole entry refuses"
  );
});

test("a different media timescale is refused, and said in those words", () => {
  const answer = compareInits(init({ timescale: 90000 }), init({ timescale: 48000 }));

  assert.equal(answer.compatible, false);
  assert.ok(
    answer.differences.some((line) => line.includes("timescale 90000 against 48000")),
    answer.differences.join(" | ")
  );
  assert.deepEqual(answer.refusedPaths, ["moov[0]/trak[0]/mdia[0]/mdhd[0]"]);
});

test("a track present in one header and not the other is refused", () => {
  const answer = compareInits(init({ tracks: 1 }), init({ tracks: 2 }));

  assert.equal(answer.compatible, false);
  assert.ok(
    answer.differences.some((line) => line.includes("trak[1]") && line.includes("absent from the first")),
    answer.differences.join(" | ")
  );
});

test("an exact-path exception decides by path", () => {
  const served = init({ timescale: 90000 });
  const made = init({ timescale: 48000 });

  const refused = compareInits(served, made);
  const permitted = compareInits(served, made, {
    exceptions: [{ path: "moov[0]/trak[0]/mdia[0]/mdhd[0]", why: "for this check only" }]
  });

  assert.equal(refused.compatible, false);
  assert.equal(permitted.compatible, true, "the exception list is what decides, and it is asked by path");
  assert.equal(permitted.differences.length, 1, "a permitted difference is still reported");
});

test("allowing one path does not allow the same box of another track", () => {
  const answer = compareInits(init({ tracks: 2, timescale: 90000 }), init({ tracks: 2, timescale: 48000 }), {
    exceptions: [{ path: "moov[0]/trak[0]/mdia[0]/mdhd[0]", why: "for this check only" }]
  });

  assert.equal(answer.compatible, false);
  assert.deepEqual(answer.refusedPaths, ["moov[0]/trak[1]/mdia[0]/mdhd[0]"]);
});

test("a missing header is never compatible", () => {
  assert.equal(compareInits(init(), Buffer.alloc(0)).compatible, false);
  assert.equal(compareInits(Buffer.alloc(0), init()).compatible, false);
});
