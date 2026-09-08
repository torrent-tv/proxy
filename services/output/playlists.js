/**
 * @file What an output tells a player it consists of.
 *
 * Two texts and one lookup, and all three are statements about a TIMELINE — how
 * the file is cut, and which of the file's heights and soundtracks are being
 * published beside it. None of them is about a session, a viewer, an encoder or
 * a disk, which is why they live here: the manager resolved a session, walked
 * the live outputs and then also wrote HLS by hand, so the format of a playlist
 * was a private detail of an eleven-thousand-line class.
 *
 * Every input is passed in. This layer reads no file, holds no state, and knows
 * nothing of the classes above it.
 */

// Where a rung and a soundtrack live under a session's own address. The player
// only ever sees them joined to it, so they are written once, here, beside the
// lines that use them.
const VARIANT_PATH_PREFIX = "v";
const AUDIO_PATH_PREFIX = "a";

// One group for every soundtrack of one picture: a rendition group is what
// makes changing language the player's own switch instead of this proxy
// rebuilding the session with another track number.
const AUDIO_GROUP_ID = "aud";

// ISO 639-2 codes as ffmpeg reports them, against the RFC 5646 tags HLS asks
// for. Only the languages this serves in practice; anything else is passed
// through, which is what players other than iOS accept anyway.
const LANGUAGE_TAGS = new Map([
  ["rus", "ru"], ["eng", "en"], ["ukr", "uk"], ["deu", "de"], ["ger", "de"],
  ["fra", "fr"], ["fre", "fr"], ["spa", "es"], ["ita", "it"], ["jpn", "ja"],
  ["kor", "ko"], ["zho", "zh"], ["chi", "zh"], ["pol", "pl"], ["por", "pt"],
  ["tur", "tr"], ["ces", "cs"], ["cze", "cs"], ["nld", "nl"], ["dut", "nl"]
]);

/**
 * The RFC 5646 tag for a language ffmpeg named, or the name unchanged.
 *
 * @param {string} language
 * @returns {string}
 */
export function languageTag(language) {
  const code = String(language ?? "").toLowerCase();
  return LANGUAGE_TAGS.get(code) ?? code;
}

/**
 * Quote a value for an HLS attribute list.
 *
 * The quote would end the attribute early; a line break would end the LINE,
 * splitting one `#EXT-X-MEDIA` into two and corrupting the master. Both come
 * from the file's own metadata, which is not ours to trust.
 *
 * @param {string} value
 * @returns {string}
 */
export function escapeAttribute(value) {
  return String(value ?? "").replace(/"/g, "'").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
}

// The smallest rate the HLS specification tolerates in a `BANDWIDTH` attribute.
// It is a floor on what may be DECLARED, not a belief about any content: a file
// whose rate is not yet known is described by it, and so is a variant so small
// that the arithmetic below would go under it.
const MINIMUM_DECLARED_BITS_PER_SECOND = 400_000;

/**
 * How many bits of film there are per second of playback, for one height.
 *
 * MEASURED, and the measurement is available before anything is encoded. The
 * comment here used to say the opposite — "a measurement we do not have before
 * encoding starts" — and gave `height * height * 3.2` instead, which for 1080
 * is 3 732 480. Field 2026-09-08: that was declared for a file carrying
 * 18.4 Mbit/s, five times more, and the arithmetic that reads it is not
 * cosmetic.
 *
 * **What reads it.** The browser sizes its cushion in BYTES from this figure
 * times the seconds it is asked to hold, so a figure five times low makes the
 * cushion five times shallow: 120 s asked bought 56 MB, which is 26 s of that
 * film, and the deepest the browser ever held was 17.1 s. And hls.js compares
 * it against its own estimate of the link to decide a level is unplayable —
 * which is why an inflated figure is not the answer either: its own recovery
 * then moves level, and that path does not honour our pinning (measured, 2.59.3).
 *
 * **Where the figure comes from.** Two cases, both exact:
 *
 * - a height that is COPIED carries the source's own bits, so it is the file's
 *   length over its duration;
 * - a height that is RE-ENCODED carries what the encoder is capped at, which we
 *   impose ourselves.
 *
 * The specification wants the PEAK per segment in `BANDWIDTH` and the average
 * in `AVERAGE-BANDWIDTH`; both are emitted, and the peak is scaled from the
 * average by the ratio the largest produced segment has actually shown — never
 * a chosen multiplier, and equal to the average until a segment exists.
 *
 * @param {object} params
 * @param {number} params.averageBitsPerSecond - The film's own rate, measured.
 * @param {number} params.height
 * @param {number} params.sourceHeight
 * @param {number} [params.capKbps] - What a re-encoded height is capped at.
 * @returns {number}
 */
export function bitrateFor({ averageBitsPerSecond, height, sourceHeight, capKbps = 0 }) {
  // ONE EXPRESSION, and each term is a measured quantity or the absence of one
  // written as the identity of its operation. There is no case analysis here
  // because there are no cases: the rate a variant carries is what the source
  // carries, shrunk by how much less picture there is, and never more than what
  // we cap the encoder at.
  //
  //  - what the source carries: `length * 8 / duration`, exact. Unknown is 0,
  //    and 0 falls to the floor below, which is what "not measured" means;
  //  - how much less picture: the ratio of pixel counts, and never above 1 —
  //    a variant at or above the source's height carries the source's bits.
  //    The pixel count is the one term of the relation that is a fact rather
  //    than an opinion about the encoder, and it errs HIGH for a small height,
  //    which is the safe direction: the cushion is sized generously and the
  //    player does not conclude the level is beyond its link;
  //  - what we cap it at: exact where we impose one, and `Infinity` where we
  //    do not, which is the identity of `min` and so states "no cap" without a
  //    branch;
  //  - the floor: the smallest figure the specification tolerates, and the
  //    identity of `max`.
  const measured = Number(averageBitsPerSecond) > 0 ? Number(averageBitsPerSecond) : 0;
  const shrink = height > 0 && sourceHeight > 0
    ? Math.min(1, (height * height) / (sourceHeight * sourceHeight))
    : 1;
  const cap = capKbps > 0 ? capKbps * 1000 : Number.POSITIVE_INFINITY;
  return Math.round(Math.max(MINIMUM_DECLARED_BITS_PER_SECOND, Math.min(measured * shrink, cap)));
}

/**
 * The media playlist: the whole film, as a VOD list of segments that mostly do
 * not exist yet.
 *
 * Synthetic and complete by design — every segment listed and `#EXT-X-ENDLIST`
 * at the end — so the player knows the length and can seek at once. An `event`
 * playlist gives neither, which is the bug this replaced.
 *
 * @param {{ boundaries: number[], segmentFormat: { playlistVersion: number, playlistHeaderLines: () => string[], segmentFileName: (index: number) => string } }} params
 * @returns {string}
 */
export function mediaPlaylistText({ boundaries, segmentFormat }) {
  const count = Math.max(0, boundaries.length - 1);
  let maxDuration = 0;
  for (let index = 0; index < count; index += 1) {
    const duration = Math.max(0.1, boundaries[index + 1] - boundaries[index]);
    if (duration > maxDuration) {
      maxDuration = duration;
    }
  }
  const lines = [
    "#EXTM3U",
    // The container decides the minimum version (fMP4 + `#EXT-X-MAP` needs 7,
    // MPEG-TS is fine at 3).
    `#EXT-X-VERSION:${segmentFormat.playlistVersion}`,
    `#EXT-X-TARGETDURATION:${Math.ceil(maxDuration)}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    // Container-specific header lines (e.g. fMP4's `#EXT-X-MAP`).
    ...segmentFormat.playlistHeaderLines()
  ];
  for (let index = 0; index < count; index += 1) {
    const duration = Math.max(0.1, boundaries[index + 1] - boundaries[index]);
    lines.push(`#EXTINF:${duration.toFixed(6)},`);
    lines.push(segmentFormat.segmentFileName(index));
  }
  lines.push("#EXT-X-ENDLIST");
  return `${lines.join("\n")}\n`;
}

/**
 * The master playlist: the heights a player may switch between, and the
 * soundtracks published beside them.
 *
 * The soundtracks are published once for the whole file rather than muxed into
 * every rung. Two things follow: the same track is not encoded once per rung on
 * a host that struggles to encode it once, and changing track becomes the
 * player switching rendition instead of this proxy rebuilding the session.
 *
 * Which rendition is marked DEFAULT is decided by the caller, per VIEWER: one
 * picture is shared by everyone watching it and each of them may have chosen a
 * different language, so a default taken from the session's own field would
 * start the second viewer in the first viewer's language.
 *
 * @param {{
 *   playlistVersion: number,
 *   heights: number[],
 *   sourceWidth: number,
 *   sourceHeight: number,
 *   renditions?: Array<{ trackIndex: number, name: string, language: string, isDefault: boolean }>,
 *   playlistFileName: string,
 *   averageBitsPerSecond?: number,
 *   peakOverAverage?: number,
 *   capKbpsFor?: (height: number) => number
 * }} params
 * @returns {string}
 */
export function masterPlaylistText({
  playlistVersion,
  heights,
  sourceWidth,
  sourceHeight,
  renditions = [],
  playlistFileName,
  averageBitsPerSecond = 0,
  peakOverAverage = 1,
  capKbpsFor = () => 0
}) {
  const lines = ["#EXTM3U", `#EXT-X-VERSION:${playlistVersion}`];
  const audioGroup = renditions.length > 0 ? AUDIO_GROUP_ID : "";
  for (const rendition of renditions) {
    lines.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${audioGroup}",NAME="${escapeAttribute(rendition.name)}"` +
      (rendition.language ? `,LANGUAGE="${escapeAttribute(languageTag(rendition.language))}"` : "") +
      `,AUTOSELECT=YES,DEFAULT=${rendition.isDefault ? "YES" : "NO"}` +
      `,URI="${AUDIO_PATH_PREFIX}/${rendition.trackIndex}/${playlistFileName}"`
    );
  }
  for (const height of heights) {
    const width = sourceHeight > 0 && sourceWidth > 0
      ? Math.round((sourceWidth / sourceHeight) * height / 2) * 2
      : 0;
    const average = bitrateFor({
      averageBitsPerSecond,
      height,
      sourceHeight,
      capKbps: capKbpsFor(height)
    });
    // BOTH, because they answer different questions and the specification has a
    // name for each: the peak is what a link must carry at the worst moment,
    // the average is what the whole variant costs. hls.js sizes its byte budget
    // from BANDWIDTH, so the peak is what stops the cushion being sized for a
    // quiet stretch and running dry on a loud one — measured on the field file,
    // 17.1 Mbit/s median against 73 Mbit/s at its peak.
    const peak = Math.round(average * Math.max(1, peakOverAverage));
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${peak},AVERAGE-BANDWIDTH=${average}` +
      (width > 0 ? `,RESOLUTION=${width}x${height}` : "") +
      (audioGroup ? `,AUDIO="${audioGroup}"` : "")
    );
    lines.push(`${VARIANT_PATH_PREFIX}/${height}/${playlistFileName}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The segment whose span contains `seconds`, by a boundary table.
 *
 * The table to pass is the one the PLAYER holds: the time being resolved came
 * from the playlist the player was given, so the index it means is the index
 * that playlist gives it. Falls back to an even grid of `segmentDurationSec`
 * when there is no table, which is a session with no known duration.
 *
 * @param {number[]} boundaries
 * @param {number} seconds
 * @param {number} segmentDurationSec
 * @returns {number}
 */
export function segmentIndexForTime(boundaries, seconds, segmentDurationSec) {
  if (!Array.isArray(boundaries) || boundaries.length < 2) {
    return Math.max(0, Math.floor(seconds / segmentDurationSec));
  }
  // boundaries is sorted ascending; find the last boundary <= t.
  let lo = 0;
  let hi = boundaries.length - 1;
  let result = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (boundaries[mid] <= seconds) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return Math.min(result, boundaries.length - 2);
}

export { AUDIO_GROUP_ID, AUDIO_PATH_PREFIX, VARIANT_PATH_PREFIX };
