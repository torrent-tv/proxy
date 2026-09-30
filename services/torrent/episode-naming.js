/**
 * @file What a picture's NAME says about which episode it is.
 *
 * A season pack states its structure in names — `s01e02_Murder.in.the.Mews.avi`,
 * `Reacher.S04E01.1080p.rus.LostFilm.TV.mkv`, `[HorribleSubs] Drifters - 01
 * [1080p].mkv` under a folder, or an episode number under `Season_01/`. This
 * reads that statement and nothing else: which season, which episode numbers,
 * which part of an episode, whether it is a special, and the text on either
 * side of the marker.
 *
 * The numbers are the RELEASE's numbering. They are often the same as a
 * metadata provider's and sometimes not — one release numbers the two parts of
 * a feature-length episode as two episodes, which shifts every number after
 * them — so nothing here claims to know which episode of the show a file is.
 * That is decided later, against the provider's own list, by whoever holds it.
 *
 * A name without a marker returns `null`: absence of a number is absence of
 * information, not evidence that the file is not an episode.
 */

import { stripExtension } from "./naming.js";

/** Most episodes one file may claim before the claim is read as noise. */
const MAX_EPISODES_PER_FILE = 8;

/** Longest hint returned, in characters; a name longer than this is not a title. */
const MAX_HINT_LENGTH = 160;

/** `S01E02`, `s03.e01`, `S01E01E02`, `S01E01-E02`, `S01E01-02`. */
const SEASON_EPISODE = /(?<![a-z0-9])s(\d{1,3})[ ._]?e(\d{1,4})((?:-?e\d{1,4}|-\d{1,4})*)(?![0-9])/i;

/** `1x02`; four-digit sides are picture sizes (`1920x1080`) and never match. */
const CROSS = /(?<![a-z0-9])(\d{1,2})x(\d{2,3})(?![0-9a-z])/i;

/** `E05`, `Ep 5`, `Episode.05`, `Серия 5` — an episode number with no season in it. */
const EPISODE_ONLY = /(?<![\p{L}0-9])(?:e|ep|episode|серия)[ ._-]?(\d{1,4})(?![0-9])/iu;

/** `Show - 01`, `Show - 01v2` — the numbering most anime releases use. */
const DASH_NUMBER = / - (\d{1,4})(?:v\d)?(?=[ .[(]|$)/;

/** A folder that names a season: `Season_01`, `Season 1`, `S01`, `Сезон 1`, `1 сезон`. */
const SEASON_FOLDER = /^(?:season|сезон|s)[ ._-]*(\d{1,3})$|^(\d{1,3})[ ._-]*(?:season|сезон)$/iu;

/** `Part.1`, `Pt 2`, `Часть 1`. */
const PART = /(?<![\p{L}0-9])(?:part|pt|часть)[ ._-]?(\d{1,2})(?![0-9])/iu;

/** `Special`, `Specials`, `SP01`. */
const SPECIAL = /(?<![\p{L}])(?:specials?|sp\d{1,3})(?![\p{L}])/iu;

/** Separators a release puts between words, trimmed off the ends of a hint. */
const EDGE_SEPARATORS = /^[\s._\-–—]+|[\s._\-–—]+$/g;

/**
 * An episode marker read from a name.
 *
 * @typedef {object} EpisodeMarker
 * @property {number | null} season - `null` when neither the name nor a folder states one.
 * @property {number[]} episodes - The release's numbers, one or more.
 * @property {number | null} part - Which part of one episode, when the name says so.
 * @property {boolean} special - Season 0, or a name calling itself a special.
 * @property {string} showHint - The name's text before the marker, as written.
 * @property {string} titleHint - The name's text after the marker, part removed, as written.
 */

/**
 * Trim a piece of a name to a hint.
 *
 * @param {string} text
 * @returns {string}
 */
function hint(text) {
  return String(text ?? "").replace(EDGE_SEPARATORS, "").slice(0, MAX_HINT_LENGTH);
}

/**
 * The numbers after the first episode in `S01E01E02` or `S01E01-03`.
 *
 * A `-` joins a range, a repeated `E` lists another episode.
 *
 * @param {number} first
 * @param {string} rest
 * @returns {number[] | null} `null` when the claim is longer than any file carries.
 */
function episodesFrom(first, rest) {
  const episodes = [first];
  for (const token of rest.match(/-?e?\d+/gi) ?? []) {
    const value = Number(token.replace(/[^0-9]/g, ""));
    const last = episodes[episodes.length - 1];
    if (token.startsWith("-") && value > last) {
      for (let next = last + 1; next <= value; next += 1) {
        episodes.push(next);
        if (episodes.length > MAX_EPISODES_PER_FILE) {
          return null;
        }
      }
    } else if (value !== last) {
      episodes.push(value);
    }
  }
  return episodes.length > MAX_EPISODES_PER_FILE ? null : episodes;
}

/**
 * The season the deepest season-naming folder states, if any does.
 *
 * @param {string[]} folders
 * @returns {number | null}
 */
function seasonFromFolders(folders) {
  for (let index = folders.length - 1; index >= 0; index -= 1) {
    const match = SEASON_FOLDER.exec(String(folders[index] ?? "").trim());
    if (match) {
      return Number(match[1] ?? match[2]);
    }
  }
  return null;
}

/**
 * Which episode a picture's name says it is.
 *
 * @param {{ name: string, folders?: string[] }} file - File name and the folders above it.
 * @returns {EpisodeMarker | null}
 */
export function readEpisodeMarker({ name, folders = [] }) {
  const stem = stripExtension(String(name ?? ""));
  const folderSeason = seasonFromFolders(Array.isArray(folders) ? folders : []);

  let season = null;
  let episodes = null;
  let before = "";
  let after = "";

  const seasonEpisode = SEASON_EPISODE.exec(stem);
  const cross = seasonEpisode ? null : CROSS.exec(stem);
  const episodeOnly = seasonEpisode || cross ? null : EPISODE_ONLY.exec(stem);
  const dash = seasonEpisode || cross || episodeOnly ? null : DASH_NUMBER.exec(stem);
  const match = seasonEpisode ?? cross ?? episodeOnly ?? dash;
  if (!match) {
    return null;
  }
  before = stem.slice(0, match.index);
  after = stem.slice(match.index + match[0].length);

  if (seasonEpisode) {
    season = Number(seasonEpisode[1]);
    episodes = episodesFrom(Number(seasonEpisode[2]), seasonEpisode[3] ?? "");
  } else if (cross) {
    season = Number(cross[1]);
    episodes = [Number(cross[2])];
  } else {
    // `Show S1 - 01` states its season just before the number; a folder is the
    // other place a release puts it.
    const trailingSeason = /(?<![a-z0-9])s(\d{1,3})[\s._-]*$/i.exec(before);
    season = trailingSeason ? Number(trailingSeason[1]) : folderSeason;
    if (trailingSeason) {
      before = before.slice(0, trailingSeason.index);
    }
    episodes = [Number(match[1])];
  }
  // A year where an episode number would be is a year far more often than an
  // episode: `Film - 2024 [1080p]`, and `WALL-E.2008.mkv` reads as `E` then
  // `2008`. Only the markers without a season can be fooled this way.
  if ((dash || episodeOnly) && /^(?:19|20)\d\d$/.test(match[1])) {
    return null;
  }
  if (!episodes) {
    return null;
  }

  const part = PART.exec(after);
  const titleText = part ? `${after.slice(0, part.index)} ${after.slice(part.index + part[0].length)}` : after;

  return {
    season,
    episodes,
    part: part ? Number(part[1]) : null,
    special: season === 0 || SPECIAL.test(stem),
    showHint: hint(before),
    titleHint: hint(titleText)
  };
}
