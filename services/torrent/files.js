/**
 * @file Which files of a torrent belong to one video file — as its sound, its
 * subtitles or its pictures.
 *
 * Releases often ship a dub or a subtitle set as SEPARATE FILES beside the
 * picture — `Rus Sound/<name>.mka`, `Sub/[group]/<name>.ass` — and a viewer who
 * cannot reach them is watching the release without half of what it carries.
 * This module answers only which file goes with which; what is inside a file is
 * the container layer's business (`services/container/`), and what a viewer is
 * shown is composed in the browser, where the locale is known.
 *
 * **Why it lives in `torrent/`.** A container knows only itself, and a track
 * knows only its container; "the file next to this one" is a notion that exists
 * only where there is a LIST of files, which is the torrent. So this is the
 * torrent's own statement about itself, in the layer that holds them, and it is
 * the reason the folder exists.
 *
 * Nothing here reads bytes, waits on the swarm or knows about ffmpeg. It is a
 * function of the torrent's own list of names, which is why it can be tested
 * outright.
 *
 * A note on the axes this fits into. A file beside the video is NOT a third kind
 * of track: `<name>.mka` is a Matroska container holding an audio track, and
 * `MatroskaContainer` reads it exactly as it reads the picture's own tracks. So
 * "external" is not a type — it is only the answer to WHERE a track lives, and
 * that answer belongs here rather than in `tracks/`, which describes what a
 * container declares and must stay free of torrent knowledge.
 */

import { nameFollows, sidecarNaming } from "./naming.js";

/**
 * Containers and elementary streams that can carry a soundtrack on their own.
 *
 * Two groups, and the difference matters to the caller: `.mka` and `.m4a` have a
 * track table that `ContainerFactory` can read, so their language, title and
 * flags are available; the rest are raw elementary streams that carry exactly
 * one track and declare nothing about it.
 */
export const AUDIO_SIDECAR_EXTENSIONS = new Set([
  ".mka",
  ".m4a",
  ".aac",
  ".ac3",
  ".eac3",
  ".dts",
  ".dtshd",
  ".flac",
  ".mp3",
  ".mp2",
  ".ogg",
  ".oga",
  ".opus",
  ".wav",
  ".thd",
  ".mlp",
  ".wma"
]);

/**
 * Subtitle files. Image-based ones (`.sup`, `.sub`, `.idx`) are listed because
 * they exist and must be RECOGNISED — a file we cannot show is still not a
 * soundtrack — but this module does not decide what is offerable; that is the
 * subtitle track's own `isTextBased()`.
 */
export const SUBTITLE_SIDECAR_EXTENSIONS = new Set([
  ".srt",
  ".ass",
  ".ssa",
  ".vtt",
  ".webvtt",
  ".sub",
  ".sup",
  ".idx",
  ".ttml",
  ".smi",
  ".txt"
]);

/**
 * Still images shipped beside a video: a contact sheet of frames, a cover, a
 * poster.
 *
 * Recognised for two things a viewer can see. A pack of a hundred videos is
 * unusable as a list of release names, and many such packs ship one contact
 * sheet per video — so the sheets can BE the picker. And a film with a cover
 * beside it has something to show while its first frame is being made, which is
 * otherwise a black rectangle.
 *
 * They are served by the byte-range route like anything else in the torrent;
 * nothing here decodes them.
 */
export const IMAGE_SIDECAR_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".bmp",
  ".avif"
]);

/**
 * Containers that carry a picture.
 *
 * Here to COUNT them, not to decide what plays: whether a file is playable is
 * the browser's answer, made from what its own media stack accepts, and this
 * proxy must not acquire a second opinion about it. The count is needed for one
 * decision — whether a torrent holds exactly one picture, in which case a
 * soundtrack beside it has nothing else it could belong to.
 */
export const VIDEO_FILE_EXTENSIONS = new Set([
  ".mp4",
  ".mkv",
  ".webm",
  ".mov",
  ".m4v",
  ".avi",
  ".mpg",
  ".mpeg",
  ".ts",
  ".m2ts",
  ".mts",
  ".wmv",
  ".asf",
  ".flv",
  ".f4v",
  ".ogv",
  ".ogm",
  ".3gp",
  ".3g2",
  ".divx",
  ".vob",
  ".m2v",
  ".m2p",
  ".mxf",
  ".rm",
  ".rmvb"
]);

/**
 * How many files of a torrent carry a picture.
 *
 * @param {Array<{ path?: string, name?: string }>} files
 * @returns {number}
 */
export function countVideoFiles(files) {
  let count = 0;
  for (const file of Array.isArray(files) ? files : []) {
    const name = typeof file?.name === "string" && file.name.length > 0
      ? file.name
      : String(file?.path ?? "");
    if (VIDEO_FILE_EXTENSIONS.has(extensionOf(name))) {
      count += 1;
    }
  }
  return count;
}

/**
 * Subtitle formats that are text, and therefore small by construction — a whole
 * episode of dialogue is tens of kilobytes.
 *
 * The distinction is used to decide how much of such a file to fetch ahead of
 * the viewer: a text file is fetched WHOLE, because it is smaller than the
 * torrent's own piece and reading its edges would cost the same pieces as
 * reading all of it. An image-based one (`.sup`, `.sub`+`.idx`) is a picture per
 * cue and runs to tens of megabytes, so it gets the same edges treatment as
 * anything else.
 */
export const TEXT_SUBTITLE_SIDECAR_EXTENSIONS = new Set([
  ".srt",
  ".ass",
  ".ssa",
  ".vtt",
  ".webvtt",
  ".ttml",
  ".smi",
  ".txt"
]);

/**
 * Extensions whose track table a `Container` subclass can read. Everything else
 * in {@link AUDIO_SIDECAR_EXTENSIONS} is a bare stream: one track, no metadata.
 */
const CONTAINER_BACKED_AUDIO = new Set([".mka", ".m4a", ".mp4", ".mkv", ".webm"]);

/**
 * The extension of a name, lowercased, including the dot. Empty when there is
 * none.
 *
 * @param {string} name
 * @returns {string}
 */
export function extensionOf(name) {
  const text = typeof name === "string" ? name : "";
  const dot = text.lastIndexOf(".");
  // A leading dot is a hidden file, not an extension.
  return dot > 0 ? text.slice(dot).toLowerCase() : "";
}

/**
 * A name without its extension.
 *
 * @param {string} name
 * @returns {string}
 */
export function baseNameOf(name) {
  const text = typeof name === "string" ? name : "";
  const dot = text.lastIndexOf(".");
  return dot > 0 ? text.slice(0, dot) : text;
}

/**
 * Whether a sidecar file of this extension has a readable track table.
 *
 * @param {string} extension - Lowercased, with the dot.
 * @returns {boolean}
 */
export function declaresItsOwnTracks(extension) {
  return CONTAINER_BACKED_AUDIO.has(extension);
}

/**
 * Split a torrent file's path into the folders above it and its own name, with
 * the torrent's own name removed from the front.
 *
 * WebTorrent prefixes every path in a multi-file torrent with the torrent name;
 * the browser strips it again to show a playlist. Doing it once, here, means the
 * folders travel to the browser already relative to the torrent root, so there
 * is one stripping rule in the system rather than two that can disagree.
 *
 * @param {string} path - `file.path` as WebTorrent reports it.
 * @param {string} torrentName
 * @returns {{ folders: string[], name: string }}
 */
export function splitTorrentPath(path, torrentName) {
  const text = typeof path === "string" ? path.replace(/\\/g, "/") : "";
  const prefix = typeof torrentName === "string" && torrentName.length > 0 ? `${torrentName}/` : "";
  const relative = prefix && text.startsWith(prefix) ? text.slice(prefix.length) : text;
  const segments = relative.split("/").filter((segment) => segment.length > 0);
  const name = segments.length > 0 ? segments[segments.length - 1] : "";
  return { folders: segments.slice(0, -1), name };
}

/**
 * Bracketed groups of a name, in order: `[HorribleSubs] X [1080p]` → both.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function bracketTokensOf(text) {
  const source = typeof text === "string" ? text : "";
  const tokens = [];
  for (const match of source.matchAll(/\[([^\]]+)\]/g)) {
    const token = match[1].trim();
    if (token.length > 0) {
      tokens.push(token);
    }
  }
  return tokens;
}

/**
 * Bracketed groups that look like a release hash — `[78EFD746]`. Anime releases
 * carry the CRC of the file, and two files sharing one are certainly a pair.
 *
 * @param {string} text
 * @returns {string[]}
 */
function hashTokensOf(text) {
  return bracketTokensOf(text)
    .filter((token) => /^[0-9a-f]{4,10}$/i.test(token))
    .map((token) => token.toLowerCase());
}

/**
 * Whether a sidecar and a video are the same release of the same episode.
 *
 * Three rules, all taken from what releases actually do, and none of them
 * involving the folder — a dub lives in a folder of its own by construction, so
 * requiring the folders to match would reject every case this exists for:
 *
 * 1. the base names are equal, which is the common shape (`X.mkv` / `X.mka`);
 * 2. the sidecar's name CONTINUES the video's at a token boundary, which is what
 *    every surveyed player reads: `<video base>.<language>[.<flags>].<ext>`, the
 *    shape Plex, Jellyfin, Kodi, Bazarr and OpenSubtitles all produce;
 * 3. they share a release hash, which anime releases carry.
 *
 * Rule 2 was missing here and present in the browser, as a plain "begins with",
 * and the two were compared nowhere. Measured 2026-09-04 over the 115 torrents
 * in `Dropbox/trn`: of 1249 video files the two answers agreed on 1239 and
 * differed on 10, every one of the ten a `<base>.<language>.ass` name that the
 * browser paired and this side did not. The consequence reached the viewer,
 * because the proxy warms what IT paired while the browser offers what IT
 * paired: a track offered but never warmed waits for its first piece off the
 * swarm, 27.7 s in the field measurement of 2026-08-31.
 *
 * The boundary is what makes rule 2 safe, and a plain "begins with" is not the
 * same rule: without it `Film.20.rus.srt` pairs with `Film.2.mkv` — measured,
 * and the grammar then reports the leftover `0` as the track's title, which is
 * the tell that the remainder is a fragment of another film's name.
 *
 * @param {string} sidecarName
 * @param {string} videoName
 * @returns {boolean}
 */
export function namesPair(sidecarName, videoName) {
  if (sameRelease(sidecarName, videoName)) {
    return true;
  }
  return nameFollows(baseNameOf(sidecarName), baseNameOf(videoName));
}

/**
 * The same question for an IMAGE, which has one shape of its own.
 *
 * A contact sheet is commonly named by the video's WHOLE name with the image
 * extension appended — `Movie.mp4.jpg` beside `Movie.mp4` — verified on a pack
 * of 106 videos with 106 sheets. That is not the base-name rule: the sheet's
 * base name is `Movie.mp4` and the video's is `Movie`.
 *
 * @param {string} imageName
 * @param {string} videoName
 * @returns {boolean}
 */
export function imageNamesPair(imageName, videoName) {
  if (sameRelease(imageName, videoName)) {
    return true;
  }
  const imageBase = baseNameOf(imageName).toLowerCase();
  return imageBase.length > 0 && imageBase === String(videoName ?? "").toLowerCase();
}

/**
 * @param {string} sidecarName
 * @param {string} videoName
 * @returns {boolean}
 */
function sameRelease(sidecarName, videoName) {
  const sidecarBase = baseNameOf(sidecarName).toLowerCase();
  const videoBase = baseNameOf(videoName).toLowerCase();
  if (sidecarBase.length === 0 || videoBase.length === 0) {
    return false;
  }
  if (sidecarBase === videoBase) {
    return true;
  }
  const videoHashes = new Set(hashTokensOf(videoBase));
  if (videoHashes.size > 0) {
    for (const token of hashTokensOf(sidecarBase)) {
      if (videoHashes.has(token)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * @typedef {object} SidecarFile
 * @property {number} fileIndex - Index in the torrent.
 * @property {string} name - File name, extension included.
 * @property {string[]} folders - Folders above it, relative to the torrent root.
 * @property {string} extension - Lowercased, with the dot.
 * @property {number} length - Bytes.
 * @property {boolean} declaresTracks - Whether its own track table can be read.
 */

/**
 * The audio and subtitle files of a torrent that belong to one video file.
 *
 * The pairing is by name (see {@link namesPair}), with ONE relaxation: a torrent
 * holding a single video file has nothing else its sidecars could belong to, so
 * there every sidecar is taken. That covers the very common
 * `Film.mkv` + `Rus.mka` shape, where the two names have nothing in common. It
 * is deliberately not extended to a torrent with several videos, where a wrong
 * pairing would put the sound of one episode over the picture of another.
 *
 * @param {object} params
 * @param {Array<{ path?: string, name?: string, length?: number }>} params.files
 * @param {number} params.videoIndex
 * @param {string} [params.torrentName]
 * @param {number} [params.videoCount] - How many playable video files the
 *   torrent holds. When 1, the relaxation above applies. Counted by the caller,
 *   which is the side that knows what counts as playable.
 * @returns {{ audio: SidecarFile[], subtitles: SidecarFile[], images: SidecarFile[] }}
 *   Images are the third group because a contact sheet or a cover is paired by
 *   the same rule and found in the same one pass. They are matched more
 *   strictly than sound and subtitles: the one-video relaxation does NOT apply
 *   to them, since a torrent's stray screenshot is not this film's cover, and
 *   showing the wrong picture as a poster is a visible mistake where a missing
 *   one is merely nothing.
 */
export function matchSidecarFiles({ files, videoIndex, torrentName = "", videoCount = 0 }) {
  const list = Array.isArray(files) ? files : [];
  const video = list[videoIndex];
  if (!video) {
    return { audio: [], subtitles: [], images: [] };
  }
  const videoPath = splitTorrentPath(video.path ?? video.name ?? "", torrentName);
  const onlyVideo = videoCount === 1;
  /** @type {SidecarFile[]} */
  const audio = [];
  /** @type {SidecarFile[]} */
  const subtitles = [];
  /** @type {SidecarFile[]} */
  const images = [];

  for (const [fileIndex, file] of list.entries()) {
    if (fileIndex === videoIndex) {
      continue;
    }
    const { folders, name } = splitTorrentPath(file?.path ?? file?.name ?? "", torrentName);
    const extension = extensionOf(name);
    const isAudio = AUDIO_SIDECAR_EXTENSIONS.has(extension);
    const isSubtitle = !isAudio && SUBTITLE_SIDECAR_EXTENSIONS.has(extension);
    const isImage = !isAudio && !isSubtitle && IMAGE_SIDECAR_EXTENSIONS.has(extension);
    if (!isAudio && !isSubtitle && !isImage) {
      continue;
    }
    if (isImage ? !imageNamesPair(name, videoPath.name) : !onlyVideo && !namesPair(name, videoPath.name)) {
      continue;
    }
    const entry = {
      fileIndex,
      name,
      folders,
      extension,
      length: Number.isFinite(file?.length) ? file.length : 0,
      declaresTracks: declaresItsOwnTracks(extension),
      // What this file's own path says about the track in it: its language, the
      // flags a releaser wrote, and who made it. Read HERE, by the same grammar
      // that decided the pairing, so the two answers cannot disagree — which is
      // what they did while the browser read the name and this side did not.
      naming: sidecarNaming({ folders, fileName: name, videoName: videoPath.name })
    };
    if (isAudio) {
      audio.push(entry);
    } else if (isSubtitle) {
      subtitles.push(entry);
    } else {
      images.push(entry);
    }
  }

  return { audio, subtitles, images };
}
