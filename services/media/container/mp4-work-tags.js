/**
 * @file What an MP4 or QuickTime file states about the work, from the `moov`
 * box the container already holds for its tracks.
 *
 * Three places carry it, and a file may use any of them:
 *
 *  1. the iTunes item list — `moov/udta/meta` with handler `mdir`, then `ilst`,
 *     each item a box named by its four characters (`©nam`, `tvsh`, `tvsn`,
 *     `tves`, `tven`, `©gen`, `©day`, `desc`, `ldes`, `©cmt`, `stik`, `covr`)
 *     holding a `data` box: a type indicator, a locale, then the value
 *     (Apple, "QuickTime File Format", Metadata, "Data atom"; the well-known
 *     types 1 UTF-8, 13 JPEG, 14 PNG, 21 big-endian signed integer, 27 BMP);
 *  2. QuickTime metadata keys — `meta` with handler `mdta`, a `keys` box naming
 *     each item, and `ilst` items addressed by the 1-based index of their key
 *     (`com.apple.quicktime.title`, `.genre`, `.description`, `.year`,
 *     `.creationdate`, `.artwork`);
 *  3. QuickTime user data text — `moov/udta/©nam` and its kind, each a 16-bit
 *     length, a 16-bit language and the text.
 *
 * The LostFilm files measured in #136 use the first: `©nam` is the episode,
 * `tvsh` the series, `tvsn`/`tves` the season and episode. An item that is a TV
 * episode is recognised by what the file states (`tvsh`, `tvsn`, `tves`, or
 * `stik` 10, "TV Show"), never by a name.
 */

import { text, textList, wholeNumber, yearOf } from "./work-tags.js";

const TYPE_UTF8 = 1;
const TYPE_UTF16 = 2;
const TYPE_JPEG = 13;
const TYPE_PNG = 14;
const TYPE_INTEGER = 21;
const TYPE_UNSIGNED = 22;
const TYPE_BMP = 27;

/** `stik` 10: the item is an episode of a TV show (Apple). */
const MEDIA_KIND_TV_SHOW = 10;

/**
 * The boxes directly inside a range.
 *
 * @param {Buffer} buffer
 * @param {number} start
 * @param {number} end
 * @returns {Array<{ type: string, rawType: number, dataOffset: number, end: number }>}
 */
function boxes(buffer, start, end) {
  const out = [];
  for (let at = start; at + 8 <= end;) {
    let size = buffer.readUInt32BE(at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) break;
      size = Number(buffer.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) break;
    out.push({ type: buffer.toString("latin1", at + 4, at + 8), rawType: buffer.readUInt32BE(at + 4), dataOffset: at + header, end: at + size });
    at += size;
  }
  return out;
}

const child = (buffer, box, type) => boxes(buffer, box.dataOffset, box.end).find((one) => one.type === type) ?? null;

/**
 * The children of a `meta` box. ISO/IEC 14496-12 makes it a full box (four
 * bytes of version and flags before its children); QuickTime writes it without
 * them. Which one a file wrote is read from where the handler box is.
 *
 * @param {Buffer} buffer
 * @param {{ dataOffset: number, end: number }} meta
 */
function metaChildren(buffer, meta) {
  const plain = meta.dataOffset + 8 <= meta.end && buffer.toString("latin1", meta.dataOffset + 4, meta.dataOffset + 8) === "hdlr";
  return boxes(buffer, meta.dataOffset + (plain ? 0 : 4), meta.end);
}

/**
 * The value of one item's first `data` box.
 *
 * @param {Buffer} buffer
 * @param {{ dataOffset: number, end: number }} item
 * @returns {{ type: number, value: Buffer, at: number } | null}
 */
function dataOf(buffer, item) {
  const data = boxes(buffer, item.dataOffset, item.end).find((one) => one.type === "data");
  if (!data || data.end - data.dataOffset < 8) return null;
  const type = buffer.readUInt32BE(data.dataOffset) & 0xffffff;
  return { type, value: buffer.subarray(data.dataOffset + 8, data.end), at: data.dataOffset + 8 };
}

/** @param {{ type: number, value: Buffer }} data */
function stringOf(data) {
  if (!data) return null;
  // Type 2 is UTF-16 big-endian; Node reads only little-endian, so the bytes are swapped on a copy.
  if (data.type === TYPE_UTF16) return data.value.length % 2 === 0 ? text(Buffer.from(data.value).swap16().toString("utf16le")) : null;
  // Type 0 is "implicit"; writers use it for text as often as for anything else.
  return data.type === TYPE_UTF8 || data.type === 0 ? text(data.value.toString("utf8")) : null;
}

/** @param {{ type: number, value: Buffer }} data */
function integerOf(data) {
  if (!data || ![0, TYPE_INTEGER, TYPE_UNSIGNED].includes(data.type)) return null;
  const { value } = data;
  if (value.length === 1) return value.readUInt8(0);
  if (value.length === 2) return value.readUInt16BE(0);
  if (value.length === 4) return data.type === TYPE_INTEGER ? value.readInt32BE(0) : value.readUInt32BE(0);
  if (value.length === 8) return Number(value.readBigUInt64BE(0));
  return null;
}

/** The image type an item's data type states. */
function imageType(data) {
  if (!data) return null;
  if (data.type === TYPE_JPEG) return "image/jpeg";
  if (data.type === TYPE_PNG) return "image/png";
  if (data.type === TYPE_BMP) return "image/bmp";
  return data.type === 0 ? "image/jpeg" : null;
}

/**
 * Every item one `meta` box states, by name: an iTunes four-character name, or
 * for an `mdta` list the key the item's index points at.
 *
 * @param {Buffer} buffer
 * @param {{ dataOffset: number, end: number }} meta
 * @returns {Map<string, { type: number, value: Buffer, at: number }>}
 */
function itemsOf(buffer, meta) {
  const items = new Map();
  const children = metaChildren(buffer, meta);
  const hdlr = children.find((one) => one.type === "hdlr");
  const handler = hdlr && hdlr.end - hdlr.dataOffset >= 12 ? buffer.toString("latin1", hdlr.dataOffset + 8, hdlr.dataOffset + 12) : "";
  const ilst = children.find((one) => one.type === "ilst");
  if (!ilst) return items;
  /** @type {string[]} */
  const keys = [];
  if (handler === "mdta") {
    const keysBox = children.find((one) => one.type === "keys");
    if (keysBox) {
      for (const key of boxes(buffer, keysBox.dataOffset + 8, keysBox.end)) keys.push(buffer.toString("utf8", key.dataOffset, key.end));
    }
  }
  for (const item of boxes(buffer, ilst.dataOffset, ilst.end)) {
    const name = handler === "mdta" ? keys[item.rawType - 1] : item.type;
    const data = name ? dataOf(buffer, item) : null;
    if (data && !items.has(name)) items.set(name, data);
  }
  return items;
}

/**
 * QuickTime user data text atoms directly inside `udta` (`©nam` and its kind).
 *
 * @param {Buffer} buffer
 * @param {{ dataOffset: number, end: number }} udta
 * @returns {Map<string, string>}
 */
function userDataTexts(buffer, udta) {
  const texts = new Map();
  for (const box of boxes(buffer, udta.dataOffset, udta.end)) {
    if (box.type.charCodeAt(0) !== 0xa9 || box.end - box.dataOffset < 4) continue;
    const length = buffer.readUInt16BE(box.dataOffset);
    const value = text(buffer.toString("utf8", box.dataOffset + 4, Math.min(box.end, box.dataOffset + 4 + length)));
    if (value && !texts.has(box.type)) texts.set(box.type, value);
  }
  return texts;
}

/**
 * What a `moov` box states about the work, and where its cover lies inside it.
 *
 * @param {Buffer} moov - The whole box, its header included.
 * @param {number} header - The size of its header.
 * @returns {{ work: Partial<import("./work-tags.js").WorkTags>, cover: { type: string, at: number, size: number } | null }}
 */
export function workFromMoov(moov, header) {
  const root = { dataOffset: header, end: moov.length };
  const udta = child(moov, root, "udta");
  /** @type {Map<string, { type: number, value: Buffer, at: number }>} */
  const items = new Map();
  for (const meta of [udta && child(moov, udta, "meta"), child(moov, root, "meta")]) {
    if (!meta) continue;
    for (const [name, data] of itemsOf(moov, meta)) if (!items.has(name)) items.set(name, data);
  }
  const texts = udta ? userDataTexts(moov, udta) : new Map();
  const say = (...names) => {
    for (const name of names) {
      const value = items.has(name) ? stringOf(items.get(name)) : texts.get(name) ?? null;
      if (value) return value;
    }
    return null;
  };
  const show = say("tvsh");
  const season = wholeNumber(integerOf(items.get("tvsn")), 0, 999);
  const episode = wholeNumber(integerOf(items.get("tves")), 0, 9999);
  const isEpisode = Boolean(show) || season !== null || episode !== null || integerOf(items.get("stik")) === MEDIA_KIND_TV_SHOW;
  const name = say("©nam", "com.apple.quicktime.title", "com.apple.quicktime.displayname");
  const date = say("©day", "com.apple.quicktime.year", "com.apple.quicktime.creationdate");
  const artwork = items.get("covr") ?? items.get("com.apple.quicktime.artwork") ?? null;
  const coverType = imageType(artwork);
  return {
    work: {
      title: isEpisode ? show : name,
      seriesTitle: show,
      season,
      episode,
      episodeId: say("tven"),
      episodeTitle: isEpisode ? name : null,
      year: isEpisode ? null : yearOf(date),
      itemYear: isEpisode ? yearOf(date) : null,
      genres: textList([say("©gen", "com.apple.quicktime.genre")]),
      description: say("ldes", "desc", "com.apple.quicktime.description", "©des", "©cmt")
    },
    cover: artwork && coverType ? { type: coverType, at: artwork.at, size: artwork.value.length } : null
  };
}
