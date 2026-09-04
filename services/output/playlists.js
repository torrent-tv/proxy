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

/**
 * A rough bitrate for a height, in bits per second.
 *
 * `BANDWIDTH` is required on every variant by the HLS specification, and the
 * player uses it to order them. It does not have to be exact — nothing here
 * adapts on it, because the viewer chooses — so it is the usual H.264 rule of
 * thumb rather than a measurement we do not have before encoding starts.
 *
 * @param {number} height
 * @returns {number}
 */
export function estimatedBitrateFor(height) {
  return Math.max(400_000, Math.round(height * height * 3.2));
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
 *   playlistFileName: string
 * }} params
 * @returns {string}
 */
export function masterPlaylistText({
  playlistVersion,
  heights,
  sourceWidth,
  sourceHeight,
  renditions = [],
  playlistFileName
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
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${estimatedBitrateFor(height)}` +
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
