/**
 * @file WHAT IS IN ONE TORRENT — its files, which of them carry a picture, and
 * which files belong to which picture.
 *
 * The torrent's own statement about itself, held instead of recomputed. The
 * pairing rules already lived beside this file, as functions; what did not
 * exist was anywhere to keep their answer, so every caller worked it out again
 * — the warm-up on one path and the playback plan on another, over the same
 * list, several times per opened film.
 *
 * It is a class rather than a set of functions because the fact it holds passes
 * the test this project uses for that: the composition is born with the file
 * list, dies with the record of the torrent, and is addressed by one name.
 *
 * **What it must NOT hold**, and the boundary is the point:
 *
 *  - nothing about a FILM. A poster, a title, a description are answers from a
 *    third party about an identity, and that identity comes from a file's own
 *    bytes rather than from the torrent's list of names. They are keyed by the
 *    picture's file, arrive late or not at all, and must never delay playback;
 *  - no reference to another layer. Not a container, whose life is a file's and
 *    which reads bytes; not a priority map, which is built from viewers and
 *    lives above this; not a viewer. What leaves here is plain values — indices
 *    into the torrent's own list — and whoever takes them holds nothing of this
 *    object.
 *
 * **What was measured and deliberately NOT built**, so that it is not proposed
 * again as an oversight: telling a real episode from an extra. Over the 134
 * torrents of the survey collection, the words that would say so (`sample`,
 * `trailer`, `extra`, `bonus`, `preview`, `making`) matched four files, and all
 * four were ordinary titles — "Making cash with her pussy" is an episode, not a
 * making-of. Size says no more: the ratio of a video to the median of its own
 * torrent runs continuously from 0.00 to 1.00 with no gap anywhere, because a
 * collection of short clips is made of short clips. So there is nothing here to
 * derive a rule from, and a rule invented anyway would decide the order in
 * which a stranger's bandwidth is spent. Every picture is an item.
 *
 * Nothing here reads bytes, waits on the swarm or knows about ffmpeg. Like the
 * functions it is built on, it is a function of the list of names.
 */

import {
  VIDEO_FILE_EXTENSIONS,
  extensionOf,
  matchSidecarFiles,
  splitTorrentPath
} from "./files.js";

/**
 * One picture of a torrent, with the files that belong to it.
 *
 * @typedef {object} TorrentItem
 * @property {number} fileIndex - Index of the picture in the torrent's own list.
 * @property {string} name - Its file name, extension included.
 * @property {string[]} folders - The folders above it, relative to the torrent root.
 * @property {string} relativePath - Both of those as one path.
 * @property {number} length - Bytes.
 * @property {import("./files.js").SidecarFile[]} audio - Soundtracks beside it.
 * @property {import("./files.js").SidecarFile[]} subtitles - Subtitle files beside it.
 * @property {import("./files.js").SidecarFile[]} images - Contact sheets and covers.
 */

/**
 * One file of a torrent that belongs to no picture.
 *
 * @typedef {object} TorrentLeftover
 * @property {number} fileIndex
 * @property {string} name
 * @property {string[]} folders
 * @property {string} relativePath
 * @property {number} length
 */

/**
 * Files in the order a person reads them: by folder, then by name, with runs of
 * digits compared as numbers.
 *
 * A torrent's own order is whatever the tool that made it chose, and it is
 * routinely by size — one measured release lists its episodes 08, 06, 07, 01,
 * 02, 10. Nothing downstream depends on the position: every item carries the
 * torrent's own index, and that is what a file is opened by.
 *
 * `numeric` is what makes 2 come before 10; comparing the strings would put
 * "10" before "2".
 *
 * @param {{ relativePath: string }} left
 * @param {{ relativePath: string }} right
 * @returns {number}
 */
function inReadingOrder(left, right) {
  return left.relativePath.localeCompare(right.relativePath, undefined, {
    numeric: true,
    sensitivity: "base"
  });
}

export class TorrentContents {
  /** @type {TorrentItem[]} */
  #items = [];

  /** Which item a file belongs to, as its picture or as one of its parts. @type {Map<number, TorrentItem>} */
  #itemByFile = new Map();

  /** How many files carry a picture. @type {number} */
  #videoCount = 0;

  /** @type {TorrentLeftover[]} */
  #leftovers = [];

  /**
   * @param {object} params
   * @param {Array<{ path?: string, name?: string, length?: number }>} params.files -
   *   The torrent's own list, in its own order.
   * @param {string} [params.name] - The torrent's name, which WebTorrent
   *   prefixes to every path in a multi-file torrent.
   */
  constructor({ files, name = "" }) {
    const list = Array.isArray(files) ? files : [];
    const described = list.map((file, fileIndex) => {
      const { folders, name: fileName } = splitTorrentPath(file?.path ?? file?.name ?? "", name);
      return {
        fileIndex,
        name: fileName,
        folders,
        relativePath: [...folders, fileName].join("/"),
        length: Number.isFinite(file?.length) ? file.length : 0,
        isVideo: VIDEO_FILE_EXTENSIONS.has(extensionOf(fileName))
      };
    });
    this.#videoCount = described.filter((file) => file.isVideo).length;

    const claimed = new Set();
    for (const file of described.filter((one) => one.isVideo).sort(inReadingOrder)) {
      const { audio, subtitles, images } = matchSidecarFiles({
        files: list,
        videoIndex: file.fileIndex,
        torrentName: name,
        videoCount: this.#videoCount
      });
      /** @type {TorrentItem} */
      const item = {
        fileIndex: file.fileIndex,
        name: file.name,
        folders: file.folders,
        relativePath: file.relativePath,
        length: file.length,
        audio,
        subtitles,
        images
      };
      this.#items.push(item);
      claimed.add(file.fileIndex);
      this.#itemByFile.set(file.fileIndex, item);
      for (const part of [...audio, ...subtitles, ...images]) {
        claimed.add(part.fileIndex);
        // A part paired with two pictures is answered for by the first that
        // took it, which in this order is the earlier episode. Both items keep
        // it in their own lists, because both genuinely offer it; this map
        // answers the other question — which picture to fetch it beside — and
        // there one answer is what stops it being fetched twice.
        if (!this.#itemByFile.has(part.fileIndex)) {
          this.#itemByFile.set(part.fileIndex, item);
        }
      }
    }

    this.#leftovers = described
      .filter((file) => !claimed.has(file.fileIndex))
      .sort(inReadingOrder)
      .map((file) => ({
        fileIndex: file.fileIndex,
        name: file.name,
        folders: file.folders,
        relativePath: file.relativePath,
        length: file.length
      }));
  }

  /**
   * Every picture of this torrent with what belongs to it, in reading order.
   *
   * @returns {TorrentItem[]}
   */
  get items() {
    return this.#items;
  }

  /**
   * How many files of this torrent carry a picture.
   *
   * @returns {number}
   */
  get videoCount() {
    return this.#videoCount;
  }

  /**
   * Files that belong to no picture: the release's own notes, a screenshot pack
   * matched to nothing, anything a torrent carries beside its films.
   *
   * @returns {TorrentLeftover[]}
   */
  get leftovers() {
    return this.#leftovers;
  }

  /**
   * The item this file belongs to — as its picture, or as one of its parts.
   *
   * @param {number} fileIndex
   * @returns {TorrentItem | null}
   */
  itemOf(fileIndex) {
    return this.#itemByFile.get(fileIndex) ?? null;
  }

  /**
   * The files beside one picture that belong to it, in three groups.
   *
   * The shape the warm-up and the playback plan each worked out for themselves,
   * answered from what was decided once, at construction.
   *
   * @param {number} fileIndex - The picture's index in the torrent.
   * @returns {{ audio: import("./files.js").SidecarFile[], subtitles: import("./files.js").SidecarFile[], images: import("./files.js").SidecarFile[] }}
   */
  sidecarsOf(fileIndex) {
    const item = this.#itemByFile.get(fileIndex);
    if (!item || item.fileIndex !== fileIndex) {
      return { audio: [], subtitles: [], images: [] };
    }
    return { audio: item.audio, subtitles: item.subtitles, images: item.images };
  }
}

/** What has been worked out per torrent, and from how many files. @type {WeakMap<object, { contents: TorrentContents, fileCount: number }>} */
const byTorrent = new WeakMap();

/**
 * What is in this torrent, worked out once.
 *
 * Found from the torrent itself, in the shape the piece store and the demand
 * register already use, because the same instance is wanted by callers that
 * have no way to hand it to one another.
 *
 * A torrent added from a magnet has no files until its metadata arrives, so the
 * answer is rebuilt when the list changes size — which it does exactly once,
 * from nothing to everything.
 *
 * @param {{ files?: unknown[], name?: string }} torrent
 * @returns {TorrentContents}
 */
export function contentsOf(torrent) {
  const files = Array.isArray(torrent?.files) ? torrent.files : [];
  const held = byTorrent.get(torrent);
  if (held && held.fileCount === files.length) {
    return held.contents;
  }
  const contents = new TorrentContents({
    files,
    name: typeof torrent?.name === "string" ? torrent.name : ""
  });
  byTorrent.set(torrent, { contents, fileCount: files.length });
  return contents;
}
