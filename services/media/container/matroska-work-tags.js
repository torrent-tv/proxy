/**
 * @file What a Matroska file states about the work, per the Matroska tagging
 * specification (matroska.org, "Tags" and "Tagging"), RFC 9559 §5.1.7
 * (Chapters), §5.1.6 (Attachments) and §5.1.8 (Tags).
 *
 * A `Tag` applies to what its `Targets` name. `TargetTypeValue` states the
 * level (70 a collection, 60 a season or volume, 50 an episode or a film, 30 a
 * chapter or a scene) and is 50 when absent. A `Tag` whose `Targets` name a
 * particular track, edition, chapter or attachment by a non-zero UID describes
 * that one only — mkvmerge's per-track statistics are of this kind — and says
 * nothing about the work.
 *
 * Parsing over buffers already read; where the bytes come from is the
 * container's business.
 */

import { iterateElements, readUint } from "./ebml-reader.js";
import { externalIdsOf, text, textList, wholeNumber, yearOf } from "./work-tags.js";

export const ID_TAGS = 0x1254c367;
export const ID_CHAPTERS = 0x1043a770;
export const ID_ATTACHMENTS = 0x1941a469;
export const ID_INFO_TITLE = 0x7ba9;

const ID_TAG = 0x7373;
const ID_TARGETS = 0x63c0;
const ID_TARGET_TYPE_VALUE = 0x68ca;
const ID_TAG_TRACK_UID = 0x63c5;
const TARGET_UIDS = new Set([ID_TAG_TRACK_UID, 0x63c9, 0x63c4, 0x63c6]);
const ID_SIMPLE_TAG = 0x67c8;
const ID_TAG_NAME = 0x45a3;
const ID_TAG_STRING = 0x4487;
const ID_TAG_DEFAULT = 0x4484;

const ID_EDITION_ENTRY = 0x45b9;
const ID_CHAPTER_ATOM = 0xb6;
const ID_CHAPTER_DISPLAY = 0x80;
const ID_CHAP_STRING = 0x85;
const ID_CHAPTER_FLAG_HIDDEN = 0x98;

export const ID_ATTACHED_FILE = 0x61a7;
export const ID_FILE_NAME = 0x466e;
export const ID_FILE_MEDIA_TYPE = 0x4660;
export const ID_FILE_DATA = 0x465c;

/** The level a `Tag` applies to when its `Targets` say nothing (Matroska tagging). */
const DEFAULT_TARGET_TYPE_VALUE = 50;

const string = (buffer, element) => buffer.toString("utf8", element.dataOffset, element.dataOffset + element.size).replace(/\0+$/u, "");

/**
 * Every `SimpleTag` of one `Tag`, nested ones included, as name and value.
 *
 * @param {Buffer} buffer
 * @param {number} start
 * @param {number} end
 * @param {Array<{ name: string, value: string, isDefault: boolean }>} out
 */
function simpleTags(buffer, start, end, out) {
  for (const element of iterateElements(buffer, start, end)) {
    if (element.id !== ID_SIMPLE_TAG) continue;
    const limit = Math.min(end, element.dataOffset + element.size);
    let name = null;
    let value = null;
    let isDefault = true;
    for (const field of iterateElements(buffer, element.dataOffset, limit)) {
      if (field.id === ID_TAG_NAME) name = string(buffer, field).toUpperCase();
      else if (field.id === ID_TAG_STRING) value = string(buffer, field);
      else if (field.id === ID_TAG_DEFAULT) isDefault = readUint(buffer, field.dataOffset, field.size) !== 0;
    }
    if (name && value !== null) out.push({ name, value, isDefault });
    simpleTags(buffer, element.dataOffset, limit, out);
  }
}

/**
 * The `Tag`s of a `Tags` element that describe the work, grouped by level.
 *
 * @param {Buffer} data - The data of a `Tags` element.
 * @returns {Map<number, Array<{ name: string, value: string, isDefault: boolean }>>}
 */
export function tagsByLevel(data) {
  /** @type {Map<number, Array<{ name: string, value: string, isDefault: boolean }>>} */
  const levels = new Map();
  for (const tag of iterateElements(data)) {
    if (tag.id !== ID_TAG) continue;
    const end = Math.min(data.length, tag.dataOffset + tag.size);
    let level = DEFAULT_TARGET_TYPE_VALUE;
    let particular = false;
    for (const element of iterateElements(data, tag.dataOffset, end)) {
      if (element.id !== ID_TARGETS) continue;
      for (const field of iterateElements(data, element.dataOffset, Math.min(end, element.dataOffset + element.size))) {
        if (field.id === ID_TARGET_TYPE_VALUE) level = readUint(data, field.dataOffset, field.size);
        else if (TARGET_UIDS.has(field.id) && readUint(data, field.dataOffset, field.size) !== 0) particular = true;
      }
    }
    if (particular) continue;
    const found = [];
    simpleTags(data, tag.dataOffset, end, found);
    if (!levels.has(level)) levels.set(level, []);
    levels.get(level).push(...found);
  }
  return levels;
}

/**
 * A Matroska UID as a key: its bytes in hexadecimal, leading zeros dropped.
 * A UID is any 64-bit value, which a JavaScript number cannot hold exactly.
 *
 * @param {Buffer} buffer
 * @param {{ dataOffset: number, size: number }} element
 * @returns {string}
 */
export function uidKeyOf(buffer, element) {
  return buffer.toString("hex", element.dataOffset, element.dataOffset + element.size).replace(/^0+/u, "");
}

/**
 * The average rate each track's statistics state, keyed by its `TrackUID`.
 *
 * mkvmerge writes, per track, a `Tag` whose `Targets` name that track by
 * `TagTrackUID` and whose `SimpleTag`s carry `BPS` — the bits the track holds
 * over its duration — beside `NUMBER_OF_BYTES` and `DURATION`. Those are the
 * tags read here; a track the file gives no `BPS` is left out.
 *
 * @param {Buffer} data - The data of a `Tags` element.
 * @returns {Map<string, number>} kbit/s by {@link uidKeyOf} of the track.
 */
export function trackRatesFromTags(data) {
  /** @type {Map<string, number>} */
  const rates = new Map();
  for (const tag of iterateElements(data)) {
    if (tag.id !== ID_TAG) continue;
    const end = Math.min(data.length, tag.dataOffset + tag.size);
    const tracks = [];
    for (const element of iterateElements(data, tag.dataOffset, end)) {
      if (element.id !== ID_TARGETS) continue;
      for (const field of iterateElements(data, element.dataOffset, Math.min(end, element.dataOffset + element.size))) {
        if (field.id === ID_TAG_TRACK_UID) tracks.push(uidKeyOf(data, field));
      }
    }
    if (tracks.length === 0) continue;
    const found = [];
    simpleTags(data, tag.dataOffset, end, found);
    const bps = Number(found.find((simple) => simple.name === "BPS")?.value);
    if (!(Number.isFinite(bps) && bps > 0)) continue;
    for (const uid of tracks) if (uid.length > 0) rates.set(uid, bps / 1000);
  }
  return rates;
}

/**
 * The values one level states for one name, the default one first.
 *
 * @param {Map<number, Array<{ name: string, value: string, isDefault: boolean }>>} levels
 * @param {number} level
 * @param {string[]} names
 * @returns {string[]}
 */
function valuesOf(levels, level, names) {
  const at = (levels.get(level) ?? []).filter((tag) => names.includes(tag.name));
  return [...at.filter((tag) => tag.isDefault), ...at.filter((tag) => !tag.isDefault)].map((tag) => tag.value);
}

/**
 * What the `Tags` element states about the work.
 *
 * An episode is recognised by what the file states, never by a name: a season
 * number (`PART_NUMBER` at level 60) or an episode number (`PART_NUMBER` at
 * level 50). For an episode the level-50 `TITLE` is the episode's and the
 * level-70 one is the series'; otherwise the level-50 `TITLE` is the film's.
 * The year of a series is its level-70 date; a level-50 date of an episode is
 * the episode's and is kept apart.
 *
 * @param {Buffer} data
 * @returns {Partial<import("./work-tags.js").WorkTags>}
 */
export function workFromTags(data) {
  const levels = tagsByLevel(data);
  const first = (level, ...names) => valuesOf(levels, level, names)[0];
  const season = wholeNumber(first(60, "PART_NUMBER"), 0, 999);
  const episode = wholeNumber(first(50, "PART_NUMBER"), 0, 9999);
  const isEpisode = season !== null || episode !== null;
  const itemTitles = valuesOf(levels, 50, ["TITLE"]);
  const collectionTitles = valuesOf(levels, 70, ["TITLE"]);
  const itemDate = first(50, "DATE_RELEASED", "DATE_RECORDED", "DATE_ENCODED");
  const collectionDate = first(70, "DATE_RELEASED", "DATE_RECORDED");
  const statedAt = (...names) => [70, 60, 50, 30].flatMap((level) => valuesOf(levels, level, names));
  return {
    title: text(isEpisode ? collectionTitles[0] : itemTitles[0]),
    otherTitles: textList(isEpisode ? collectionTitles.slice(1) : itemTitles.slice(1)),
    seriesTitle: isEpisode ? text(collectionTitles[0]) : null,
    season,
    episode,
    episodeTitle: isEpisode ? text(itemTitles[0]) : null,
    year: isEpisode ? yearOf(collectionDate) : yearOf(itemDate),
    itemYear: isEpisode ? yearOf(itemDate) : null,
    genres: textList(statedAt("GENRE")),
    description: text([50, 70].flatMap((level) => valuesOf(levels, level, ["DESCRIPTION", "SYNOPSIS", "SUMMARY"]))[0]),
    externalIds: externalIdsOf({
      imdb: [50, 70].flatMap((level) => valuesOf(levels, level, ["IMDB"]))[0],
      tmdb: [70, 50].flatMap((level) => valuesOf(levels, level, ["TMDB"]))[0],
      tvdb: [70, 50].flatMap((level) => valuesOf(levels, level, ["TVDB"]))[0]
    })
  };
}

/**
 * The titles of the chapters a file states, hidden ones left out, nested ones
 * included, in their order.
 *
 * @param {Buffer} data - The data of a `Chapters` element.
 * @returns {string[]}
 */
export function chapterTitlesOf(data) {
  const titles = [];
  const atoms = (start, end) => {
    for (const element of iterateElements(data, start, end)) {
      const limit = Math.min(end, element.dataOffset + element.size);
      if (element.id === ID_EDITION_ENTRY) atoms(element.dataOffset, limit);
      if (element.id !== ID_CHAPTER_ATOM) continue;
      let hidden = false;
      let title = null;
      for (const field of iterateElements(data, element.dataOffset, limit)) {
        if (field.id === ID_CHAPTER_FLAG_HIDDEN) hidden = readUint(data, field.dataOffset, field.size) !== 0;
        if (field.id === ID_CHAPTER_DISPLAY && title === null) {
          for (const display of iterateElements(data, field.dataOffset, Math.min(limit, field.dataOffset + field.size))) {
            if (display.id === ID_CHAP_STRING) {
              title = string(data, display);
              break;
            }
          }
        }
      }
      if (!hidden && title) titles.push(title);
      atoms(element.dataOffset, limit);
    }
  };
  atoms(0, data.length);
  return titles;
}

/**
 * Which attachment is the cover, by the names the Matroska attachments
 * specification gives covers (`cover`, `cover_land`, `small_cover`,
 * `small_cover_land`, any image extension), the full-size portrait one first.
 *
 * @param {Array<{ name: string, mediaType: string }>} files
 * @returns {number} The index of the cover, or -1.
 */
export function coverIndexOf(files) {
  const ranks = ["cover", "cover_land", "small_cover", "small_cover_land"];
  let best = -1;
  let bestRank = ranks.length;
  files.forEach((file, index) => {
    const match = /^(.+)\.(?:jpe?g|png|webp|gif|bmp)$/iu.exec(file.name.trim());
    const rank = match ? ranks.indexOf(match[1].toLowerCase()) : -1;
    if (rank >= 0 && rank < bestRank && /^image\//iu.test(file.mediaType || "image/")) {
      best = index;
      bestRank = rank;
    }
  });
  return best;
}
