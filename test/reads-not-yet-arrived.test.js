/**
 * @file A read whose bytes have not arrived is not an answer about the file.
 *
 * Field 2026-10-01: the subtitle plan of an episode was read while its Cues
 * table was still downloading, the read was given up, and the plan kept "no
 * clusters" for the life of the process — the track showed nothing for a whole
 * session while the same table, read eleven seconds later for the keyframes,
 * was there. The same shape was in the container choice, the track table, the
 * keyframe table, MP4's `moov` and AVI's `idx1`. Every check here makes the
 * bytes missing first and present afterwards, and asks the same object again.
 *
 * Fakes only: a buffer and a reader over it. No torrent, no thread.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { MatroskaContainer } from "../services/media/container/MatroskaContainer.js";
import { Mp4Container } from "../services/media/container/Mp4Container.js";
import { AviContainer } from "../services/media/container/AviContainer.js";
import { ContainerOrchestrator } from "../services/media/ContainerOrchestrator.js";
import { KeyframeTables } from "../services/media/KeyframeTables.js";
import { isUnavailable } from "../services/media/container/unavailable.js";
import {
  ID,
  buildMatroska,
  clusterData,
  cueBlock,
  element,
  readerOver,
  stringElement,
  trackEntry,
  uintElement
} from "./helpers/matroska-file.js";

const quiet = { info() {}, warn() {} };

function episode({ subtitleLanguage = null, cuesBeforeClusters = false, cues = [1], extraTrack = null } = {}) {
  const tracks = [
    trackEntry({ number: 1, type: 1, codecId: "V_MPEG4/ISO/AVC", language: "jpn" }),
    trackEntry({ number: 3, type: 17, codecId: "S_TEXT/UTF8", language: subtitleLanguage })
  ];
  if (extraTrack) {
    tracks.push(extraTrack);
  }
  return buildMatroska({
    tracks,
    cues,
    cuesBeforeClusters,
    clusters: [
      { ticks: 0, data: clusterData({ ticks: 0, blocks: [cueBlock({ track: 3, relativeTicks: 100, durationTicks: 900, text: "one" })] }) },
      { ticks: 5000, data: clusterData({ ticks: 5000, blocks: [cueBlock({ track: 3, relativeTicks: 0, durationTicks: 900, text: "two" })] }) }
    ]
  });
}

test("a subtitle plan read before the Cues table arrived is not kept; read again, it names the clusters", async () => {
  const { file, cuesAt, clusterAt } = episode({ cues: [1, 3] });
  let tailHere = false;
  const { read } = readerOver(file, { missing: (start) => !tailHere && start >= cuesAt });
  const container = new MatroskaContainer({ readRange: read, fileSize: file.length });

  await assert.rejects(container.readSubtitlePlan(), (error) => isUnavailable(error));

  tailHere = true;
  const plan = await container.readSubtitlePlan();
  assert.equal(plan.cuesState, "complete");
  assert.deepEqual(plan.tracks[0].clusterPositions, clusterAt, "both clusters the table names for the track");
});

test("a read that returns fewer bytes than asked is not taken for the element", async () => {
  const { file } = episode();
  const { read } = readerOver(file, { short: true });
  await assert.rejects(new MatroskaContainer({ readRange: read, fileSize: file.length }).readTracks(), (error) =>
    isUnavailable(error)
  );
});

test("a head that has not arrived leaves no container behind, and the next ask builds one", async () => {
  const { file } = episode();
  let headHere = false;
  const { read } = readerOver(file, { missing: (start) => !headHere && start === 0 });
  const containers = new ContainerOrchestrator();
  const params = { sourceKey: "s", fileIndex: 0, readRange: read, fileSize: file.length, label: "x.mkv" };

  await assert.rejects(containers.containerFor(params), (error) => isUnavailable(error));
  assert.equal(containers.known("s", 0), undefined, "nothing was kept for a head that is not here");
  assert.deepEqual(await containers.getTracks(params), [], "the track table answers nothing yet");

  headHere = true;
  const container = await containers.containerFor(params);
  assert.equal(container.formatName, "matroska");
  assert.equal((await containers.getTracks(params)).length, 2);
});

test("a keyframe table asked for while its Cues are missing stays unanswered, and is filled when they arrive", async () => {
  const { file, cuesAt } = episode();
  let tailHere = false;
  const { read } = readerOver(file, { missing: (start) => !tailHere && start >= cuesAt });
  const containers = new ContainerOrchestrator();
  const params = { sourceKey: "k", fileIndex: 0, readRange: read, fileSize: file.length, label: "x.mkv" };
  const tables = new KeyframeTables({
    readTable: async () => {
      const index = await containers.getKeyframeIndex(params);
      return { times: index?.times ?? null, tolerance: 0, format: "matroska" };
    },
    logger: quiet
  });

  await assert.rejects(tables.read({ sourceKey: "k", fileIndex: 0 }), (error) => isUnavailable(error));
  const table = tables.of({ sourceKey: "k", fileIndex: 0 });
  assert.equal(table.answered, false, "a read that did not arrive is not an answer");

  tailHere = true;
  tables.readAgainIfUnanswered({ sourceKey: "k", fileIndex: 0 });
  await tables.read({ sourceKey: "k", fileIndex: 0 });
  assert.equal(table.answered, true);
  assert.deepEqual(table.times, [0, 5], "the same object the sessions hold now carries the times");
});

test("a Cues element stored before the first cluster, with no SeekHead entry, is found", async () => {
  const { file } = episode({ cuesBeforeClusters: true });
  const { read } = readerOver(file);
  const index = await new MatroskaContainer({ readRange: read, fileSize: file.length }).parseKeyframeIndex();
  assert.deepEqual(index.times, [0, 5]);
});

test("a Tracks element larger than the head window is read by its own size", async () => {
  // A CodecPrivate of 80 KB pushes the end of Tracks past the 64 KB head.
  const big = element(
    ID.TRACK_ENTRY,
    Buffer.concat([
      uintElement(ID.TRACK_NUMBER, 4),
      uintElement(ID.TRACK_TYPE, 17),
      stringElement(ID.CODEC_ID, "S_TEXT/ASS"),
      element(0x63a2, Buffer.alloc(80 * 1024, 0x20))
    ])
  );
  const { file } = episode({ extraTrack: big });
  const { read } = readerOver(file);
  const tracks = await new MatroskaContainer({ readRange: read, fileSize: file.length }).readTracks();
  assert.deepEqual(tracks.map((track) => track.trackNumber), [1, 3, 4]);
});

test("the language: LanguageBCP47 wins, then Language, then the format's default `eng`; `und` stays unknown", async () => {
  const cases = [
    { entry: { language: null }, language: "eng", source: "default" },
    { entry: { language: "" }, language: "eng", source: "language" },
    { entry: { language: "rus" }, language: "rus", source: "language" },
    { entry: { language: null, languageBcp47: "pt-BR" }, language: "pt-BR", source: "bcp47" },
    { entry: { language: "por", languageBcp47: "pt-BR" }, language: "pt-BR", source: "bcp47" },
    { entry: { language: "und" }, language: "und", source: "language" }
  ];
  for (const { entry, language, source } of cases) {
    const { file } = buildMatroska({
      tracks: [trackEntry({ number: 3, type: 17, codecId: "S_TEXT/UTF8", ...entry })],
      cues: null,
      clusters: [{ ticks: 0, data: clusterData({ ticks: 0, blocks: [] }) }]
    });
    const { read } = readerOver(file);
    const [track] = await new MatroskaContainer({ readRange: read, fileSize: file.length }).readTracks();
    assert.equal(track.language, language, JSON.stringify(entry));
    assert.equal(track.languageSource, source, JSON.stringify(entry));
  }
});

/** @param {string} type @param {Buffer} payload */
function box(type, payload) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, payload]);
}

test("an MP4 whose `moov` has not arrived keeps nothing; read again, it answers", async () => {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12); // timescale
  mvhd.writeUInt32BE(5000, 16); // duration
  const ftyp = box("ftyp", Buffer.from("isom\0\0\0\0isom", "latin1"));
  const moov = box("moov", box("mvhd", mvhd));
  const file = Buffer.concat([ftyp, moov]);
  let moovHere = false;
  const { read } = readerOver(file, { missing: (start) => !moovHere && start >= ftyp.length });
  const container = new Mp4Container({ readRange: read, fileSize: file.length });

  await assert.rejects(container.readMediaInfo(), (error) => isUnavailable(error));
  moovHere = true;
  assert.equal((await container.readMediaInfo()).durationSeconds, 5);
});

test("an MP4 `moov` larger than this reads whole is refused by name, not reported absent", async () => {
  const ftyp = box("ftyp", Buffer.from("isom\0\0\0\0isom", "latin1"));
  const header = Buffer.alloc(8);
  header.writeUInt32BE(40 * 1024 * 1024, 0);
  header.write("moov", 4, "latin1");
  const file = Buffer.concat([ftyp, header, Buffer.alloc(64)]);
  const { read } = readerOver(file);
  const container = new Mp4Container({ readRange: read, fileSize: file.length });
  assert.equal(await container.readSubtitlePlan(), null);
  assert.deepEqual(container.moovRefused, { size: 40 * 1024 * 1024, limit: 32 * 1024 * 1024 });
});

test("an AVI head that has not arrived leaves no media info behind", async () => {
  const avih = Buffer.alloc(56);
  avih.writeUInt32LE(40_000, 0); // 25 frames a second
  avih.writeUInt32LE(250, 16); // ten seconds
  const chunk = Buffer.concat([Buffer.from("avih", "latin1"), Buffer.from([56, 0, 0, 0]), avih]);
  const list = Buffer.concat([Buffer.from("LIST", "latin1"), Buffer.alloc(4), Buffer.from("hdrl", "latin1"), chunk]);
  list.writeUInt32LE(list.length - 8, 4);
  const riff = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.alloc(4), Buffer.from("AVI ", "latin1"), list]);
  riff.writeUInt32LE(riff.length - 8, 4);
  let here = false;
  const { read } = readerOver(riff, { missing: () => !here });
  const container = new AviContainer({ readRange: read, fileSize: riff.length });
  await assert.rejects(container.readMediaInfo(), (error) => isUnavailable(error));
  here = true;
  assert.equal((await container.readMediaInfo()).durationSeconds, 10);
});
