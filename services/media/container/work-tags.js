/**
 * @file What a file states about the WORK it carries — title, series, season,
 * episode, year, genre, description, external ids, track and chapter titles,
 * a cover — in one shape for every container.
 *
 * Each container reads its own format's fields (Matroska `Tags`, `Chapters` and
 * `Attachments`; MP4's iTunes item list and QuickTime metadata keys; AVI's
 * `LIST INFO`) and states them here by meaning, so the reader of the answer
 * never needs to know which format said it. Nothing here interprets a value
 * beyond the format's own definition: whether a title is a release name, and
 * how much a field is trusted, is decided by whoever identifies the work.
 *
 * These fields are read only from bytes the proxy already fetches for playback
 * — the first and the last piece of the file, and whatever is already held —
 * so reading them never asks the swarm for anything (torrent-tv/meta#139). A
 * field whose bytes lie elsewhere and have not arrived is left out, and the
 * answer says so in `outsideEdges`.
 */

/** Longest text taken from one field, in characters. A stated limit. */
const MAX_TEXT = 2000;

/** Most genres, track titles or chapter titles kept. A stated limit. */
const MAX_LIST = 32;

/** Largest cover image read, in bytes. A stated limit: covers measured in #136 are tens of kilobytes. */
export const MAX_COVER_BYTES = 4 * 1024 * 1024;

/** Image types a cover may have; anything else is not shown by a browser as a poster. */
export const COVER_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp"]);

/**
 * @typedef {object} WorkTags
 * @property {string | null} title - The title of what the file holds: the film,
 *   or for an episode the series.
 * @property {string[]} otherTitles - Further titles the file states for the same thing.
 * @property {string | null} segmentTitle - A title the container states for the
 *   file as a whole without saying what it names (Matroska `Info/Title`); often
 *   a release name.
 * @property {string | null} seriesTitle
 * @property {number | null} season
 * @property {number | null} episode
 * @property {string | null} episodeId - An episode code as written (`101`).
 * @property {string | null} episodeTitle
 * @property {number | null} year - The year of the work: of the film, or of the series.
 * @property {number | null} itemYear - The year of one episode, where the file states it apart.
 * @property {string[]} genres
 * @property {string | null} description
 * @property {{ imdb?: string, tmdb?: { kind: "movie" | "tv", id: number }, tvdb?: number }} externalIds
 * @property {string[]} trackTitles
 * @property {string[]} chapterTitles
 * @property {{ type: string, size: number } | null} cover - What the cover is; its
 *   bytes are read by `readCover`.
 * @property {boolean} outsideEdges - Some element lies outside the bytes this
 *   reading may fetch and was not held; it was left out.
 */

/** @returns {WorkTags} */
export function emptyWorkTags() {
  return {
    title: null, otherTitles: [], segmentTitle: null, seriesTitle: null, season: null, episode: null, episodeId: null,
    episodeTitle: null, year: null, itemYear: null, genres: [], description: null, externalIds: {},
    trackTitles: [], chapterTitles: [], cover: null, outsideEdges: false
  };
}

/**
 * A text field, trimmed and bounded; `null` for nothing.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function text(value) {
  if (typeof value !== "string") return null;
  // Control characters other than tab and line breaks are padding or damage, not text.
  const clean = [...value].filter((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
  }).join("").trim();
  return clean.length > 0 ? clean.slice(0, MAX_TEXT) : null;
}

/**
 * A whole number written as text or stored as one, within bounds.
 *
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @returns {number | null}
 */
export function wholeNumber(value, min, max) {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\s*\d{1,9}\s*$/u.test(value) ? Number(value) : NaN;
  return Number.isInteger(number) && number >= min && number <= max ? number : null;
}

/**
 * The year a date field states: its leading four digits (`2026`, `2026-03-01`,
 * `2026-03-01T00:00:00Z`).
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function yearOf(value) {
  const match = typeof value === "string" ? /^\s*(\d{4})(?:\D|$)/u.exec(value) : null;
  return match ? wholeNumber(Number(match[1]), 1888, 2100) : null;
}

/**
 * Ids in the forms the Matroska tagging specification states: `IMDB` is `tt`
 * followed by digits, `TMDB` is `movie/<id>` or `tv/<id>`, `TVDB` is a number.
 *
 * @param {{ imdb?: unknown, tmdb?: unknown, tvdb?: unknown }} raw
 * @returns {WorkTags["externalIds"]}
 */
export function externalIdsOf({ imdb, tmdb, tvdb }) {
  const ids = {};
  const imdbMatch = typeof imdb === "string" ? /^\s*(tt\d{7,12})\s*$/u.exec(imdb) : null;
  if (imdbMatch) ids.imdb = imdbMatch[1];
  const tmdbMatch = typeof tmdb === "string" ? /^\s*(movie|tv)\/(\d{1,10})\s*$/u.exec(tmdb) : null;
  if (tmdbMatch) ids.tmdb = { kind: /** @type {"movie" | "tv"} */ (tmdbMatch[1]), id: Number(tmdbMatch[2]) };
  const tvdbNumber = wholeNumber(tvdb, 1, 2_147_483_647);
  if (tvdbNumber !== null) ids.tvdb = tvdbNumber;
  return ids;
}

/**
 * A chapter title that only numbers the chapter (`Chapter 01`, `Глава 3`,
 * `01`, `00:12:00.000`) says nothing about the work.
 *
 * @param {string} title
 * @returns {boolean}
 */
export function isNumberingOnly(title) {
  return /^\s*(?:chapter|chap|глава|часть|kapitel|chapitre|capitulo|capítulo)?\s*[#№]?\s*[\d:.]+\s*$/iu.test(title);
}

/**
 * Distinct non-empty texts, bounded.
 *
 * @param {Iterable<unknown>} values
 * @returns {string[]}
 */
export function textList(values) {
  const out = [];
  for (const value of values) {
    const one = text(value);
    if (one && !out.includes(one)) out.push(one);
    if (out.length >= MAX_LIST) break;
  }
  return out;
}

/**
 * The image type a cover's bytes have, from their signature — a container's own
 * statement of the type is checked against the bytes rather than trusted alone.
 *
 * @param {Buffer} head - At least the first twelve bytes.
 * @returns {string | null}
 */
export function imageTypeOf(head) {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 8 && head.readUInt32BE(0) === 0x89504e47 && head.readUInt32BE(4) === 0x0d0a1a0a) return "image/png";
  if (head.length >= 12 && head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (head.length >= 6 && /^GIF8[79]a$/u.test(head.toString("latin1", 0, 6))) return "image/gif";
  if (head.length >= 2 && head.toString("latin1", 0, 2) === "BM") return "image/bmp";
  return null;
}

/**
 * Thrown by a reading of work tags where the bytes lie outside what it may
 * fetch and have not arrived. The reading leaves that element out; it is not a
 * fault of the file and not "not here yet".
 */
export class OutsideReadableEdges extends Error {
  /**
   * @param {number} start
   * @param {number} end - Inclusive.
   */
  constructor(start, end) {
    super(`bytes ${start}-${end} lie outside the edges this reading may fetch and are not held`);
    this.name = "OutsideReadableEdges";
    this.start = start;
    this.end = end;
  }
}

/**
 * A reader that fetches only inside the edges, and reads elsewhere only what is
 * already held.
 *
 * @param {(start: number, end: number) => Promise<Buffer>} read - Strict: every byte or `BytesUnavailable`.
 * @param {(start: number, end: number) => boolean} mayFetch
 * @param {(error: unknown) => boolean} isUnavailable
 * @returns {(start: number, end: number) => Promise<Buffer>}
 */
export function edgeReader(read, mayFetch, isUnavailable) {
  return async (start, end) => {
    try {
      return await read(start, end);
    } catch (error) {
      if (isUnavailable(error) && !mayFetch(start, end)) throw new OutsideReadableEdges(start, end);
      throw error;
    }
  };
}
