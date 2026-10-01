/**
 * @file Where a Matroska file's clusters are, found from what is downloaded —
 * and what is read out of them, in what order, within what memory.
 *
 * RFC 9559 §22.1 says each subtitle frame SHOULD be named by the Cues table, and
 * a file may have no Cues at all. Until 2026-10-01 such a file showed no
 * subtitles ever. Every check builds a file element by element, says which
 * byte ranges are "downloaded", and runs passes of the walk the way arriving
 * pieces would. Fakes only.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { MatroskaContainer } from "../services/media/container/MatroskaContainer.js";
import {
  ID,
  buildMatroska,
  clusterData,
  cueBlock,
  element,
  heldOver,
  idBytes,
  pictureBlock,
  readerOver,
  trackEntry
} from "./helpers/matroska-file.js";

const TRACKS = [
  trackEntry({ number: 1, type: 1, codecId: "V_MPEG4/ISO/AVC", language: "jpn" }),
  trackEntry({ number: 2, type: 17, codecId: "S_TEXT/UTF8" })
];

/** One cluster a second-and-a-bit long with one line on track 2 and a picture. */
function plainCluster(ticks, text, picture = Buffer.alloc(16, 7)) {
  return {
    ticks,
    data: clusterData({
      ticks,
      blocks: [pictureBlock({ track: 1, payload: picture }), cueBlock({ track: 2, relativeTicks: 0, durationTicks: 900, text })]
    })
  };
}

async function planOf(file) {
  const { read } = readerOver(file);
  const container = new MatroskaContainer({ readRange: read, fileSize: file.length });
  return { container, plan: await container.readSubtitlePlan() };
}

async function pass(container, plan, progress, held) {
  const result = await container.readHeldCues(plan, plan.tracks[0], progress, held);
  return { ...result, texts: (result.found.get(2) ?? []).map((cue) => cue.text) };
}

test("a Cues table that names only the picture still leads to every subtitle line", async () => {
  const { file } = buildMatroska({
    tracks: TRACKS,
    cues: [1],
    clusters: [plainCluster(0, "a"), plainCluster(10_000, "b"), plainCluster(20_000, "c")]
  });
  const { container, plan } = await planOf(file);
  assert.equal(plan.cuesState, "complete");
  assert.deepEqual(plan.tracks[0].clusterPositions, [], "the table names no cluster for the subtitle track");
  const result = await pass(container, plan, {}, heldOver(file, [[0, file.length - 1]]));
  assert.deepEqual(result.texts.sort(), ["a", "b", "c"]);
});

test("with no Cues, the chain reads what is joined up and the search finds what lies past a gap", async () => {
  const { file, clusterAt } = buildMatroska({
    tracks: TRACKS,
    cues: null,
    clusters: [plainCluster(0, "a"), plainCluster(10_000, "b"), plainCluster(20_000, "c"), plainCluster(30_000, "d")]
  });
  const { container, plan } = await planOf(file);
  assert.equal(plan.cuesState, "absent");
  const progress = {};
  const gap = [clusterAt[2], clusterAt[3] - 1];
  const first = await pass(container, plan, progress, heldOver(file, [[0, gap[0] - 1], [gap[1] + 1, file.length - 1]]));
  assert.deepEqual(first.texts.sort(), ["a", "b", "d"], "the third cluster is not downloaded; the fourth is found by searching");
  assert.equal(first.stats.fromSearch, 1);

  const second = await pass(container, plan, progress, heldOver(file, [[0, file.length - 1]]));
  assert.deepEqual(second.texts, ["c"], "the gap filled: the chain reaches the third, and nothing is read twice");
  assert.deepEqual(second.withdrawn, [], "the search was right, so nothing is taken back");
});

test("a Cluster id inside a picture's bytes is checked and refused, and gives no line", async () => {
  // An id, a plausible size and some bytes — inside a SimpleBlock's payload.
  const fake = Buffer.concat([idBytes(ID.CLUSTER), Buffer.from([0x88]), Buffer.alloc(8, 0x41)]);
  const { file, clusterAt } = buildMatroska({
    tracks: TRACKS,
    cues: null,
    clusters: [plainCluster(0, "a"), plainCluster(10_000, "b", Buffer.concat([Buffer.alloc(8), fake, Buffer.alloc(8)]))]
  });
  const { container, plan } = await planOf(file);
  // The second cluster's own header is not downloaded, so nothing establishes it.
  const result = await pass(
    container,
    plan,
    {},
    heldOver(file, [[0, clusterAt[1] - 1], [clusterAt[1] + 12, file.length - 1]])
  );
  assert.deepEqual(result.texts, ["a"]);
  assert.ok(result.stats.rejectedCandidates >= 1, "the false start was looked at and refused");
});

test("a candidate that a cluster the file establishes later turns out to contain is taken back, with its lines", async () => {
  // A whole, well-formed cluster hidden inside a picture block of a real one.
  const hidden = element(
    ID.CLUSTER,
    clusterData({ ticks: 12_000, blocks: [cueBlock({ track: 2, relativeTicks: 0, durationTicks: 500, text: "hidden" })] })
  );
  const { file, clusterAt } = buildMatroska({
    tracks: TRACKS,
    cues: null,
    clusters: [
      plainCluster(0, "a"),
      plainCluster(10_000, "b", Buffer.concat([Buffer.alloc(4), hidden, Buffer.alloc(4)])),
      plainCluster(20_000, "c")
    ]
  });
  const { container, plan } = await planOf(file);
  const progress = {};
  const hiddenAt = file.indexOf(hidden);
  const first = await pass(
    container,
    plan,
    progress,
    heldOver(file, [[0, clusterAt[1] - 1], [clusterAt[1] + 12, file.length - 1]])
  );
  assert.ok(first.texts.includes("hidden"), "the search found it and its structure held");

  const second = await pass(container, plan, progress, heldOver(file, [[0, file.length - 1]]));
  assert.deepEqual(second.withdrawn, [hiddenAt], "the real cluster around it takes it back");
  assert.deepEqual(second.texts, ["b"], "and gives its own line");
});

test("a cluster whose bytes are only partly here is read once, when they all are", async () => {
  const { file, clusterAt } = buildMatroska({
    tracks: TRACKS,
    cues: [1],
    clusters: [plainCluster(0, "a"), plainCluster(10_000, "b")]
  });
  const { container, plan } = await planOf(file);
  const progress = {};
  const partly = await pass(container, plan, progress, heldOver(file, [[0, clusterAt[1] + 20]]));
  assert.deepEqual(partly.texts, ["a"]);
  const whole = await pass(container, plan, progress, heldOver(file, [[0, file.length - 1]]));
  assert.deepEqual(whole.texts, ["b"]);
  const again = await pass(container, plan, progress, heldOver(file, [[0, file.length - 1]]));
  assert.deepEqual(again.texts, [], "nothing is read twice");
});

test("a cluster of unknown size ends where the next top-level element begins", async () => {
  const { file } = buildMatroska({
    tracks: TRACKS,
    cues: null,
    clusters: [plainCluster(0, "a"), { ...plainCluster(10_000, "b"), unknownSize: true }, plainCluster(20_000, "c")]
  });
  const { container, plan } = await planOf(file);
  const progress = {};
  const held = heldOver(file, [[0, file.length - 1]]);
  const first = await pass(container, plan, progress, held);
  const second = await pass(container, plan, progress, held);
  assert.deepEqual([...first.texts, ...second.texts].sort(), ["a", "b", "c"]);
});

test("a CRC-32 before the Timestamp is a cluster like any other; a candidate whose CRC is wrong is refused", async () => {
  const withCrc = (ticks, text, crc) => ({
    ticks,
    data: clusterData({ ticks, crc, blocks: [cueBlock({ track: 2, relativeTicks: 0, durationTicks: 500, text })] })
  });
  for (const [crc, expected] of [[true, ["b", "c"]], ["wrong", ["c"]]]) {
    const { file, clusterAt } = buildMatroska({
      tracks: TRACKS,
      cues: null,
      clusters: [withCrc(0, "a", false), withCrc(10_000, "b", crc), withCrc(20_000, "c", false)]
    });
    const { container, plan } = await planOf(file);
    // The first cluster's header is not here, so the second is reached only by
    // the search, which checks the CRC.
    const result = await pass(container, plan, {}, heldOver(file, [[0, clusterAt[0] - 1], [clusterAt[0] + 12, file.length - 1]]));
    assert.deepEqual(result.texts.sort(), expected, `crc ${crc}`);
    if (crc === "wrong") {
      assert.ok(result.stats.rejectedCandidates >= 1);
    }
  }
});

test("a candidate whose end has not arrived waits, and is read when it has", async () => {
  const { file, clusterAt } = buildMatroska({
    tracks: TRACKS,
    cues: null,
    clusters: [plainCluster(0, "a"), plainCluster(10_000, "b"), plainCluster(20_000, "c")]
  });
  const { container, plan } = await planOf(file);
  const progress = {};
  const first = await pass(
    container,
    plan,
    progress,
    heldOver(file, [[0, clusterAt[1] - 1], [clusterAt[2], clusterAt[2] + 20]])
  );
  assert.deepEqual(first.texts, ["a"]);
  assert.equal(first.stats.pendingCandidates, 1, "found, and waiting for its bytes");
  const second = await pass(container, plan, progress, heldOver(file, [[0, clusterAt[1] - 1], [clusterAt[2], file.length - 1]]));
  assert.deepEqual(second.texts, ["c"]);
});

test("an id cut by the end of what is downloaded is found once the run grows", async () => {
  const { file, clusterAt } = buildMatroska({
    tracks: TRACKS,
    cues: null,
    clusters: [plainCluster(0, "a"), plainCluster(10_000, "b"), plainCluster(20_000, "c")]
  });
  const { container, plan } = await planOf(file);
  const progress = {};
  // The run ends two bytes into the third cluster's id.
  await pass(container, plan, progress, heldOver(file, [[0, clusterAt[1] - 1], [clusterAt[1] + 12, clusterAt[2] + 1]]));
  const grown = await pass(container, plan, progress, heldOver(file, [[0, clusterAt[1] - 1], [clusterAt[1] + 12, file.length - 1]]));
  assert.ok(grown.texts.includes("c"), "the cut id was searched again and found");
});

test("the cluster a viewer stands in is read first, then the one before it, then onward", async () => {
  const clusters = [0, 10_000, 20_000, 30_000, 40_000].map((ticks) => plainCluster(ticks, `at ${ticks / 1000}`));
  // A line that starts in the 10 s cluster and is still on screen at 25 s.
  clusters[1] = {
    ticks: 10_000,
    data: clusterData({ ticks: 10_000, blocks: [cueBlock({ track: 2, relativeTicks: 0, durationTicks: 16_000, text: "at 10" })] })
  };
  const { file } = buildMatroska({ tracks: TRACKS, cues: [1], clusters });
  const { container, plan } = await planOf(file);
  const progress = {};
  const held = heldOver(file, [[0, file.length - 1]], { wantedSeconds: [25] });
  const first = await pass(container, plan, progress, held);
  assert.deepEqual(first.texts, ["at 20", "at 10"], "the pass ends with what is on screen, to be pushed at once");
  assert.equal(first.more, true, "and says there is more to read now");
  const second = await pass(container, plan, progress, held);
  assert.deepEqual(second.texts, ["at 30", "at 40", "at 0"], "then onward from the viewer, then the rest");
  assert.equal(second.more, false);
});

test("a pass reading the rest stops when a viewer moves, and the next one starts from there", async () => {
  const clusters = [0, 10_000, 20_000, 30_000, 40_000, 50_000].map((ticks) => plainCluster(ticks, `at ${ticks / 1000}`));
  const { file } = buildMatroska({ tracks: TRACKS, cues: [1], clusters });
  const { container, plan } = await planOf(file);
  const progress = {};
  let viewer = [];
  let readsBeforeSeek = 2;
  const held = heldOver(file, [[0, file.length - 1]]);
  held.wantedSeconds = () => {
    // The viewer seeks to 45 s after the pass has read two clusters.
    readsBeforeSeek -= 1;
    if (readsBeforeSeek < 0) {
      viewer = [45];
    }
    return viewer;
  };
  const first = await pass(container, plan, progress, held);
  assert.equal(first.more, true, "stopped for the viewer who moved");
  const second = await pass(container, plan, progress, held);
  assert.deepEqual(second.texts.slice(0, 1), ["at 40"], "the next pass reads where the viewer now is first");
});

test("no read is larger than one portion, and a block larger than one is refused while the rest is read", async () => {
  const portion = 96;
  const { file } = buildMatroska({
    tracks: TRACKS,
    cues: [1],
    clusters: [
      plainCluster(0, "short"),
      {
        ticks: 10_000,
        data: clusterData({ ticks: 10_000, blocks: [cueBlock({ track: 2, relativeTicks: 0, durationTicks: 500, text: "x".repeat(200) })] })
      },
      plainCluster(20_000, "also short")
    ]
  });
  const { container, plan } = await planOf(file);
  const reads = [];
  const result = await pass(container, plan, {}, heldOver(file, [[0, file.length - 1]], { portionBytes: portion, reads }));
  assert.deepEqual(result.texts.sort(), ["also short", "short"]);
  assert.equal(result.stats.refusedElements, 1);
  assert.ok(reads.every(({ start, end }) => end - start + 1 <= portion), "every read stayed within one portion");
});

