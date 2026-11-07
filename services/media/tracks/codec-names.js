/**
 * @file The one table that names codecs.
 *
 * Containers write a codec as a Matroska id (`V_MPEG4/ISO/AVC`), an MP4 sample
 * entry (`avc1`) or an AVI FOURCC (`XVID`); the rest of the proxy speaks the
 * names ffmpeg prints (`h264`, `mpeg4`). Every translation lives here, so a
 * FOURCC cannot be named one thing for the inventory and another for the
 * container that reads it (torrent-tv/meta#284). Pure: imports nothing.
 */

/** FOURCCs that are MPEG-4 Part 2 (ASP/SP) whatever their case. */
export const MPEG4_FOURCCS = new Set(["FMP4", "XVID", "DIVX", "DX50", "MP4V", "M4S2", "MP4S"]);

const VIDEO_NAMES = new Map([
  ["V_MPEG4/ISO/AVC", "h264"], ["avc1", "h264"], ["avc3", "h264"],
  ["V_MPEGH/ISO/HEVC", "hevc"], ["hvc1", "hevc"], ["hev1", "hevc"],
  ["V_MPEG1", "mpeg1video"], ["V_MPEG2", "mpeg2video"], ["mpg2", "mpeg2video"],
  ["V_MPEG4/ISO/ASP", "mpeg4"], ["V_MPEG4/ISO/SP", "mpeg4"],
  ["V_VP8", "vp8"], ["V_VP9", "vp9"], ["vp09", "vp9"],
  ["V_AV1", "av1"], ["av01", "av1"], ["V_MJPEG", "mjpeg"], ["mjpg", "mjpeg"], ["jpeg", "mjpeg"],
  ["V_FFV1", "ffv1"], ["V_THEORA", "theora"]
].map(([id, name]) => [id.toLowerCase(), name]));

/** The ffmpeg name of a video track from its codec id or FOURCC, in any case; unknown ids come back lower-cased. */
export function videoCodecName(id) {
  const key = String(id ?? "").toLowerCase();
  if (MPEG4_FOURCCS.has(key.toUpperCase())) return "mpeg4";
  return VIDEO_NAMES.get(key) ?? key;
}

const AUDIO_NAMES = new Map([
  ["A_AAC", "aac"], ["A_AC3", "ac3"], ["A_EAC3", "eac3"], ["A_DTS", "dts"], ["A_FLAC", "flac"],
  ["A_OPUS", "opus"], ["A_VORBIS", "vorbis"], ["A_TRUEHD", "truehd"], ["A_MPEG/L3", "mp3"],
  ["A_MPEG/L2", "mp2"], ["A_ALAC", "alac"],
  ["mp4a", "aac"], ["ac-3", "ac3"], ["ec-3", "eac3"], ["alac", "alac"],
  ["opus", "opus"], ["Opus", "opus"], ["fLaC", "flac"], ["flac", "flac"]
]);

/**
 * The ffmpeg name of a soundtrack from its container id. Matroska allows a
 * suffix (`A_AAC/MPEG4/LC`, `A_PCM/INT/LIT`), so the family is what the first
 * two segments say. An id not listed is reported as written, lower-cased.
 */
export function audioCodecName(codecId) {
  const id = String(codecId ?? "").trim();
  const known = AUDIO_NAMES.get(id);
  if (known) return known;
  const family = id.split("/").slice(0, 2).join("/");
  const byFamily = AUDIO_NAMES.get(family) ?? AUDIO_NAMES.get(id.split("/")[0]);
  if (byFamily) return byFamily;
  if (id.startsWith("A_PCM")) return "pcm";
  return id.toLowerCase();
}

const MATROSKA_IDS = new Map([
  ["h264", "V_MPEG4/ISO/AVC"], ["hevc", "V_MPEGH/ISO/HEVC"], ["av1", "V_AV1"], ["vp9", "V_VP9"],
  ["vp8", "V_VP8"], ["mjpeg", "V_MJPEG"], ["ffv1", "V_FFV1"], ["theora", "V_THEORA"],
  ["jpeg2000", "V_JPEG2000"], ["mpeg1video", "V_MPEG1"], ["mpeg2video", "V_MPEG2"], ["mpeg4", "V_MPEG4/ISO/ASP"],
  ["aac", "A_AAC"], ["mp3", "A_MPEG/L3"], ["mp2", "A_MPEG/L2"], ["mp1", "A_MPEG/L1"],
  ["ac3", "A_AC3"], ["eac3", "A_EAC3"], ["opus", "A_OPUS"], ["flac", "A_FLAC"], ["dts", "A_DTS"],
  ["vorbis", "A_VORBIS"], ["alac", "A_ALAC"], ["truehd", "A_TRUEHD"]
]);
// Spellings an input may carry besides the canonical name, taken exactly: a
// codec outside this list has no Matroska declaration, and `M4S2` or `xvid`
// stay refused because an input's key follows its declared track identity.
const MATROSKA_SPELLINGS = [
  ...["avc1", "avc3", "hvc1", "hev1", "av01"].map(spelling => [spelling, videoCodecName(spelling)]),
  ...["FMP4", "XVID", "DIVX"].map(spelling => [spelling, "mpeg4"]),
  ...["mp4a", "ac-3", "ec-3", "Opus", "fLaC"].map(spelling => [spelling, audioCodecName(spelling)])
];

/**
 * The exact Matroska CodecID a canonical codec name is declared as, or
 * `undefined` when there is none. Reverse of the names above, never wider.
 */
export function matroskaIdOf(codec) {
  if (/^[VA]_/.test(codec)) return codec;
  if (/^pcm_[su](?:16|24|32|64)le$/.test(codec) || /^pcm_[su]8(?:le|be)?$/.test(codec)) return "A_PCM/INT/LIT";
  if (/^pcm_[su](?:16|24|32|64)be$/.test(codec)) return "A_PCM/INT/BIG";
  if (/^pcm_f(?:32|64)(?:le|be)$/.test(codec)) return "A_PCM/FLOAT/IEEE";
  const spelled = MATROSKA_SPELLINGS.find(([spelling]) => spelling === codec);
  return MATROSKA_IDS.get(spelled ? spelled[1] : codec);
}
