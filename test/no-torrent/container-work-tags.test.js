/**
 * @file What a file states about the WORK it carries — read by each container
 * from its own format, and only from bytes a reading may fetch (meta#139).
 *
 * The files are built byte by byte, from the fields the probe of #136 found in
 * real releases: a LostFilm MP4 states its episode through the iTunes item list
 * (`©nam` the episode, `tvsh` the series, `tvsn`/`tves` the numbers), a
 * Matroska file through `Tags`, `Info/Title`, chapters and attachments, an AVI
 * through `LIST INFO`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { AviContainer } from "../../services/media/container/AviContainer.js";
import { MatroskaContainer } from "../../services/media/container/MatroskaContainer.js";
import { Mp4Container } from "../../services/media/container/Mp4Container.js";
import { isUnavailable } from "../../services/media/container/unavailable.js";
import { externalIdsOf, isNumberingOnly } from "../../services/media/container/work-tags.js";
import { describeWorkTags, edgesOf } from "../../services/media/ContainerOrchestrator.js";
import { handleApiSourceContainerMetadataGet } from "../../routes/api/sources/container-metadata/get.js";
import { handleApiSourceCoverGet } from "../../routes/api/sources/cover/get.js";

/** The first bytes of a JPEG, which is what the cover's bytes are checked against. */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 7), Buffer.from([0xff, 0xd9])]);

const everything = () => true;

/** @param {Buffer} bytes @param {(start: number, end: number) => boolean} [held] */
function readerOver(bytes, held = () => true) {
  return async (start, end) => (held(start, end) ? bytes.subarray(start, Math.min(end + 1, bytes.length)) : Buffer.alloc(0));
}

/** An EBML element with a four-byte size. */
function ebml(id, payload) {
  const idBytes = Buffer.from(id.toString(16).padStart(id > 0xffffff ? 8 : id > 0xffff ? 6 : id > 0xff ? 4 : 2, "0"), "hex");
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length);
  size[0] |= 0x10;
  return Buffer.concat([idBytes, size, payload]);
}

const utf8 = (value) => Buffer.from(value, "utf8");
const uint = (value, bytes = 1) => {
  const out = Buffer.alloc(bytes);
  out.writeUIntBE(value, 0, bytes);
  return out;
};

const simpleTag = (name, value) => ebml(0x67c8, Buffer.concat([ebml(0x45a3, utf8(name)), ebml(0x4487, utf8(value))]));
const tag = (level, simple, targets = []) => ebml(0x7373, Buffer.concat([ebml(0x63c0, Buffer.concat([ebml(0x68ca, uint(level)), ...targets])), ...simple]));
const chapter = (title) => ebml(0xb6, ebml(0x80, ebml(0x85, utf8(title))));
const attached = (name, type, data) => ebml(0x61a7, Buffer.concat([ebml(0x466e, utf8(name)), ebml(0x4660, utf8(type)), ebml(0x465c, data)]));

/**
 * A Matroska file whose top-level elements are given in order, with a SeekHead
 * naming every one, so they are found wherever they lie.
 *
 * @param {Array<{ id: number, element: Buffer }>} elements
 */
function matroska(elements) {
  const seekHeadFor = (positions) => ebml(0x114d9b74, Buffer.concat(elements.map(({ id }, index) =>
    ebml(0x4dbb, Buffer.concat([ebml(0x53ab, Buffer.from(id.toString(16), "hex")), ebml(0x53ac, uint(positions[index], 4))])))));
  const length = seekHeadFor(elements.map(() => 0)).length;
  const positions = [];
  let at = length;
  for (const { element } of elements) {
    positions.push(at);
    at += element.length;
  }
  const segment = Buffer.concat([seekHeadFor(positions), ...elements.map(({ element }) => element)]);
  return Buffer.concat([ebml(0x1a45dfa3, Buffer.alloc(4)), ebml(0x18538067, segment)]);
}

const info = (title) => ({ id: 0x1549a966, element: ebml(0x1549a966, Buffer.concat([ebml(0x2ad7b1, uint(1_000_000, 3)), ebml(0x7ba9, utf8(title))])) });
const cluster = { id: 0x1f43b675, element: ebml(0x1f43b675, ebml(0xe7, uint(0))) };

test("a Matroska episode states its series, season, episode and title by level", async () => {
  const tags = ebml(0x1254c367, Buffer.concat([
    tag(70, [simpleTag("TITLE", "Светлячок"), simpleTag("DATE_RELEASED", "2002"), simpleTag("TMDB", "tv/1437"), simpleTag("IMDB", "tt0303461")]),
    tag(60, [simpleTag("PART_NUMBER", "1")]),
    tag(50, [simpleTag("TITLE", "Серенити"), simpleTag("PART_NUMBER", "1"), simpleTag("DATE_RELEASED", "2002-09-20"), simpleTag("GENRE", "Drama")]),
    // mkvmerge's statistics: they name one track, so they say nothing about the work.
    tag(50, [simpleTag("TITLE", "track statistics")], [ebml(0x63c5, uint(42, 2))])
  ]));
  const chapters = ebml(0x1043a770, ebml(0x45b9, Buffer.concat([chapter("Chapter 01"), chapter("Пролог"), chapter("02")])));
  const attachments = ebml(0x1941a469, Buffer.concat([attached("font.ttf", "font/ttf", Buffer.alloc(100)), attached("cover.jpg", "image/jpeg", JPEG)]));
  const file = matroska([info("Firefly.S01E01.1080p.mkv"), { id: 0x1254c367, element: tags },
    { id: 0x1043a770, element: chapters }, { id: 0x1941a469, element: attachments }, cluster]);
  const container = new MatroskaContainer({ readRange: readerOver(file), fileSize: file.length });

  const work = await container.readWorkTags(everything);

  assert.equal(work.segmentTitle, "Firefly.S01E01.1080p.mkv");
  assert.equal(work.title, "Светлячок");
  assert.equal(work.seriesTitle, "Светлячок");
  assert.equal(work.season, 1);
  assert.equal(work.episode, 1);
  assert.equal(work.episodeTitle, "Серенити");
  assert.equal(work.year, 2002, "a series' year is its own, not the episode's");
  assert.equal(work.itemYear, 2002);
  assert.deepEqual(work.genres, ["Drama"]);
  assert.deepEqual(work.externalIds, { imdb: "tt0303461", tmdb: { kind: "tv", id: 1437 } });
  assert.deepEqual(work.chapterTitles, ["Пролог"], "chapters that only number themselves say nothing");
  assert.deepEqual(work.cover, { type: "image/jpeg", size: JPEG.length });
  assert.equal(work.outsideEdges, false);

  const cover = await container.readCover(everything);
  assert.equal(cover.type, "image/jpeg");
  assert.ok(cover.bytes.equals(JPEG));
});

test("a Matroska film's level-50 title is the film's, and its date is its year", async () => {
  const tags = ebml(0x1254c367, tag(50, [simpleTag("TITLE", "Кошмар на улице Вязов"), simpleTag("DATE_RELEASED", "1984")]));
  const file = matroska([info("A.Nightmare.on.Elm.Street.1984.mkv"), { id: 0x1254c367, element: tags }, cluster]);
  const work = await new MatroskaContainer({ readRange: readerOver(file), fileSize: file.length }).readWorkTags(everything);

  assert.equal(work.title, "Кошмар на улице Вязов");
  assert.equal(work.episodeTitle, null);
  assert.equal(work.seriesTitle, null);
  assert.equal(work.year, 1984);
  assert.equal(work.cover, null);
});

test("Tags outside the edges that are not held are left out, and nothing is asked for them", async () => {
  const tags = ebml(0x1254c367, tag(50, [simpleTag("TITLE", "Moana")]));
  const file = matroska([info("Moana.2016.mkv"), cluster, { id: 0x1254c367, element: tags }]);
  const tagsAt = file.indexOf(tags);
  const held = (start) => start < tagsAt;
  const container = new MatroskaContainer({ readRange: readerOver(file, held), fileSize: file.length });

  const work = await container.readWorkTags((start) => start < tagsAt);

  assert.equal(work.segmentTitle, "Moana.2016.mkv");
  assert.equal(work.title, null);
  assert.equal(work.outsideEdges, true);
});

test("Tags inside the edges that have not arrived are waited for, not left out", async () => {
  const tags = ebml(0x1254c367, tag(50, [simpleTag("TITLE", "Moana")]));
  const file = matroska([info("Moana.2016.mkv"), cluster, { id: 0x1254c367, element: tags }]);
  const tagsAt = file.indexOf(tags);
  const container = new MatroskaContainer({ readRange: readerOver(file, (start) => start < tagsAt), fileSize: file.length });

  await assert.rejects(container.readWorkTags(everything), (error) => isUnavailable(error));
});

/** An ISO/IEC 14496-12 box. */
function box(type, payload) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, payload]);
}

/** An iTunes item: a box named by its four characters holding one `data` box. */
const item = (name, type, value) => box(name, box("data", Buffer.concat([uint(type, 4), Buffer.alloc(4), value])));

test("a LostFilm MP4 states its episode through the iTunes item list", async () => {
  const ilst = box("ilst", Buffer.concat([
    item("©nam", 1, utf8("Аанг")),
    item("tvsh", 1, utf8("Аватар: Легенда об Аанге")),
    item("tvsn", 21, uint(1, 4)),
    item("tves", 21, uint(1, 4)),
    item("tven", 1, utf8("101")),
    item("©gen", 1, utf8("Drama")),
    item("©day", 1, utf8("2026")),
    item("©cmt", 1, utf8("Аанг просыпается во льду.")),
    item("covr", 13, JPEG)
  ]));
  const hdlr = box("hdlr", Buffer.concat([Buffer.alloc(8), Buffer.from("mdir", "latin1"), Buffer.alloc(13)]));
  const meta = box("meta", Buffer.concat([Buffer.alloc(4), hdlr, ilst]));
  const file = Buffer.concat([box("ftyp", Buffer.from("isom", "latin1")), box("moov", box("udta", meta))]);
  const container = new Mp4Container({ readRange: readerOver(file), fileSize: file.length });

  const work = await container.readWorkTags(everything);

  assert.equal(work.title, "Аватар: Легенда об Аанге");
  assert.equal(work.seriesTitle, "Аватар: Легенда об Аанге");
  assert.equal(work.episodeTitle, "Аанг");
  assert.equal(work.season, 1);
  assert.equal(work.episode, 1);
  assert.equal(work.episodeId, "101");
  assert.equal(work.year, null, "an episode's date is not the series' year");
  assert.equal(work.itemYear, 2026);
  assert.deepEqual(work.genres, ["Drama"]);
  assert.equal(work.description, "Аанг просыпается во льду.");
  assert.deepEqual(work.cover, { type: "image/jpeg", size: JPEG.length });

  const cover = await container.readCover(everything);
  assert.ok(cover.bytes.equals(JPEG));
});

test("QuickTime metadata keys name their items through the keys box", async () => {
  const key = (name) => box("mdta", utf8(name));
  const keys = box("keys", Buffer.concat([Buffer.alloc(4), uint(2, 4), key("com.apple.quicktime.title"), key("com.apple.quicktime.year")]));
  const indexed = (index, value) => {
    const header = Buffer.alloc(8);
    const inner = box("data", Buffer.concat([uint(1, 4), Buffer.alloc(4), value]));
    header.writeUInt32BE(inner.length + 8);
    header.writeUInt32BE(index, 4);
    return Buffer.concat([header, inner]);
  };
  const hdlr = box("hdlr", Buffer.concat([Buffer.alloc(8), Buffer.from("mdta", "latin1"), Buffer.alloc(13)]));
  // QuickTime writes `meta` without the version and flags of a full box.
  const meta = box("meta", Buffer.concat([hdlr, keys, box("ilst", Buffer.concat([indexed(1, utf8("Mortal Kombat")), indexed(2, utf8("2021"))]))]));
  const file = Buffer.concat([box("ftyp", Buffer.from("qt  ", "latin1")), box("moov", meta)]);

  const work = await new Mp4Container({ readRange: readerOver(file), fileSize: file.length }).readWorkTags(everything);

  assert.equal(work.title, "Mortal Kombat");
  assert.equal(work.year, 2021);
  assert.equal(work.episodeTitle, null);
});

/** A RIFF chunk, padded to an even size. */
function chunk(id, payload) {
  const header = Buffer.alloc(8);
  header.write(id, 0, "latin1");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload, payload.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

const list = (type, children) => chunk("LIST", Buffer.concat([Buffer.from(type, "latin1"), ...children]));

test("an AVI states its title, genre and year in LIST INFO", async () => {
  const strh = Buffer.alloc(56);
  strh.write("vids", 0, "latin1");
  strh.write("XVID", 4, "latin1");
  strh.writeUInt32LE(1, 20);
  strh.writeUInt32LE(25, 24);
  const strf = Buffer.alloc(40);
  strf.writeUInt32LE(40, 0);
  strf.writeInt32LE(640, 4);
  strf.writeInt32LE(480, 8);
  strf.write("XVID", 16, "latin1");
  const hdrl = list("hdrl", [chunk("avih", Buffer.alloc(56)), list("strl", [chunk("strh", strh), chunk("strf", strf), chunk("strn", utf8("Russian"))])]);
  const infoList = list("INFO", [chunk("INAM", utf8("Мандрівний замок\0")), chunk("IGNR", utf8("Animation")), chunk("ICRD", utf8("2004-11-20"))]);
  const body = Buffer.concat([Buffer.from("AVI ", "latin1"), hdrl, infoList, list("movi", [])]);
  const file = Buffer.concat([Buffer.from("RIFF", "latin1"), uint(0, 4).fill(0), body]);
  file.writeUInt32LE(body.length, 4);

  const work = await new AviContainer({ readRange: readerOver(file), fileSize: file.length }).readWorkTags(everything);

  assert.equal(work.title, "Мандрівний замок");
  assert.deepEqual(work.genres, ["Animation"]);
  assert.equal(work.year, 2004);
  assert.deepEqual(work.trackTitles, ["Russian"]);
});

test("the edges are the pieces that hold the file's first and last bytes", () => {
  // A file of 100 bytes beginning at byte 30 of a torrent of 64-byte pieces:
  // its first piece holds file bytes 0-33, its last holds 98-99 (torrent 128-129).
  const mayFetch = edgesOf({ fileSize: 100, fileOffset: 30, portionBytes: 64 });
  assert.equal(mayFetch(0, 33), true);
  assert.equal(mayFetch(30, 34), false);
  assert.equal(mayFetch(97, 99), false);
  assert.equal(mayFetch(98, 99), true);
  assert.equal(mayFetch(40, 60), false);
});

test("ids are taken only in the forms the tagging specification states", () => {
  assert.deepEqual(externalIdsOf({ imdb: "tt1234567", tmdb: "movie/27205", tvdb: "81189" }), { imdb: "tt1234567", tmdb: { kind: "movie", id: 27205 }, tvdb: 81189 });
  assert.deepEqual(externalIdsOf({ imdb: "1234567", tmdb: "27205", tvdb: "series/81189" }), {});
});

test("a chapter that only numbers itself is recognised as such", () => {
  for (const title of ["Chapter 01", "Глава 3", "07", "00:12:00.000", "Chapitre 2"]) assert.equal(isNumberingOnly(title), true, title);
  for (const title of ["Пролог", "Opening", "Chapter One"]) assert.equal(isNumberingOnly(title), false, title);
});

test("the log line names which fields were stated, not their values", () => {
  const line = describeWorkTags({ kind: "result", value: { title: "x", season: 1, genres: [], externalIds: { imdb: "tt1234567" }, cover: null, outsideEdges: true } });
  assert.equal(line, "title season ids:imdb (some elements lie outside the edges and are not held)");
  assert.equal(describeWorkTags({ kind: "terminal", reason: "format-states-nothing" }), "none (format-states-nothing)");
});

test("the routes answer 200, 202 and 404 and refuse what they cannot address", async () => {
  const reply = () => {
    const r = { code(c) { r.status = c; return r; }, type(t) { r.contentType = t; return r; }, send(b) { r.body = b; return r; } };
    return r;
  };
  const sourceRegistry = { get: (key) => (key === "s" ? {} : null) };
  const tags = async (params, result) => {
    const r = reply();
    await handleApiSourceContainerMetadataGet({ params }, r, { sourceRegistry, inspectWorkTags: async () => result });
    return r;
  };
  const ok = await tags({ sourceKey: "s", fileIndex: "1" }, { kind: "result", value: { title: "Moana" } });
  assert.deepEqual([ok.status ?? 200, ok.body], [200, { title: "Moana" }]);
  assert.equal((await tags({ sourceKey: "s", fileIndex: "1" }, { kind: "needs-ranges" })).status, 202);
  assert.equal((await tags({ sourceKey: "s", fileIndex: "1" }, { kind: "terminal", reason: "format-states-nothing" })).status, 404);
  assert.equal((await tags({ sourceKey: "x", fileIndex: "1" }, { kind: "pending" })).status, 404);
  assert.equal((await tags({ sourceKey: "s", fileIndex: "-1" }, { kind: "pending" })).status, 400);

  const cover = async (params, result) => {
    const r = reply();
    await handleApiSourceCoverGet({ params }, r, { sourceRegistry, inspectCover: async () => result });
    return r;
  };
  const image = await cover({ sourceKey: "s", fileIndex: "1" }, { kind: "result", value: { type: "image/jpeg", bytes: JPEG } });
  assert.equal(image.contentType, "image/jpeg");
  assert.ok(image.body.equals(JPEG));
  assert.equal((await cover({ sourceKey: "s", fileIndex: "1" }, { kind: "needs-ranges" })).status, 202);
  assert.equal((await cover({ sourceKey: "s", fileIndex: "1" }, { kind: "terminal", reason: "no-cover" })).status, 404);
});
