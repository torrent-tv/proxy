/**
 * @file The walk that finds new subtitle cues in what a torrent has downloaded
 * and pushes them to the viewers.
 *
 * Subtitles are two layers put together, and this is the one place that knows
 * about both: what a file STATES about its subtitle tracks and how a cue is
 * written out is the media layer's, while which clusters may be read, where
 * the cursor stands and what one walk at a time means are the TORRENT's own
 * rules. The media layer used to import the second directly.
 *
 * Moved out of `server.js` verbatim (torrent-tv/meta#280): every free variable
 * is a port.
 */

import { SubtitleOrchestrator } from "./SubtitleOrchestrator.js";
import {
  warmSubtitleCues,
  cuesHeldFor,
  subtitleTracksOf,
  declaredSubtitleTracksOf,
  forgetSubtitles
} from "./SubtitleCues.js";
import { CONTAINER_HEAD_BYTES } from "./ContainerOrchestrator.js";
import { coalescing } from "../../utils/coalesce.js";

export class SubtitleWalk {
  /** The orchestrator the walk feeds; `server.js` reads it where it read `subtitles`. */
  subtitles;
  #torrents;
  #containers;
  #paramsFor;
  #wantedSeconds;
  #publish;
  #log;
  #warn;
  #walk;

  /**
   * @param {object} ports
   * @param {{ knownTorrent: Function, heldRangesOf: Function, readHeldOf: Function }} ports.torrents
   * @param {{ known: Function, containerFor: Function }} ports.containers - The container orchestrator.
   * @param {(request: object) => Promise<object | null>} ports.paramsFor
   * @param {(sourceKey: string, fileIndex: number) => number[]} ports.wantedSeconds
   *   Where the viewers of a file stand: the start of every urgent stretch of
   *   its priority map, ascending whole seconds; `[]` when there is none.
   * @param {(entry: object) => void} ports.publish
   * @param {(line: string) => void} ports.log
   * @param {(line: string) => void} ports.warn
   */
  constructor({ torrents, containers, paramsFor, wantedSeconds, publish, log, warn }) {
    this.#torrents = torrents;
    this.#containers = containers;
    this.#paramsFor = paramsFor;
    this.#wantedSeconds = wantedSeconds;
    this.#publish = publish;
    this.#log = log;
    this.#warn = warn;
    this.#walk = coalescing((sourceKey, fileIndex) => this.#walkFile(sourceKey, fileIndex));
    this.subtitles = new SubtitleOrchestrator(containers, {
      publish: entry => this.#publish(entry),
      warm: async (torrent, fileIndex, sourceKey) => {
        const file = await this.heldFileFor(sourceKey, fileIndex, torrent);
        return file ? warmSubtitleCues(file) : [];
      },
      held: async (torrent, fileIndex, sourceKey, trackNumber) => {
        const file = await this.heldFileFor(sourceKey, fileIndex, torrent);
        return file ? cuesHeldFor(file, trackNumber) : null;
      },
      tracksOf: async (torrent, fileIndex, sourceKey) => {
        const file = await this.heldFileFor(sourceKey, fileIndex, torrent);
        return file ? subtitleTracksOf(file) : [];
      },
      declaredTracksOf: async (torrent, fileIndex, sourceKey) => {
        const file = await this.heldFileFor(sourceKey, fileIndex, torrent);
        return file ? declaredSubtitleTracksOf(file) : [];
      },
      forget: forgetSubtitles
    });
  }

  /**
   * One file of one torrent, reduced to what the subtitle walk may know: a
   * name, a length, its one container, which ranges are downloaded whole, how
   * to read one of those without asking the swarm, the portion one read may
   * span, and where the viewers stand. File offsets and the bitfield stay in
   * the torrent's thread; the piece length crosses as a plain number.
   *
   * @param {string} sourceKey
   * @param {number} fileIndex
   * @param {object} [known] - The torrent handle when the caller already has it.
   * @returns {Promise<import("./SubtitleCues.js").HeldFile | null>}
   */
  heldFileFor = async (sourceKey, fileIndex, known = null) => {
    let torrent = known;
    if (!torrent) {
      torrent = this.#torrents.knownTorrent(sourceKey);
      if (!torrent) return null;
    }
    const file = torrent?.files?.[fileIndex];
    if (!file || !(file.length > 0)) {
      return null;
    }
    return {
      sourceKey,
      fileIndex,
      name: String(file.name ?? ""),
      length: file.length,
      portionBytes: Number(torrent.pieceLength) > 0 ? Number(torrent.pieceLength) : undefined,
      // The file's ONE container — the one the track table, the media info and
      // the keyframe table are read from. Built here only when nobody has built
      // it yet, so a pass of the walk does not fetch the file's edges again.
      container: async () => {
        const known = this.#containers.known(sourceKey, fileIndex);
        if (known !== undefined) {
          return known;
        }
        const params = await this.#paramsFor({ sourceKey, fileIndex, tailBytes: CONTAINER_HEAD_BYTES });
        return params ? this.#containers.containerFor(params) : null;
      },
      heldRanges: () => this.#torrents.heldRangesOf(torrent, fileIndex),
      readHeld: (start, end) => this.#torrents.readHeldOf(torrent, fileIndex, start, end),
      // Where the viewers of this file stand: the start of every urgent stretch
      // of its priority map, which is where each viewer's own need begins.
      wantedSeconds: () => this.#wantedSeconds(sourceKey, fileIndex),
      // A pass left readable clusters for the next one: run it.
      askAgain: () => {
        void this.pushFreshCues(sourceKey, fileIndex);
      }
    };
  };

  /**
   * Walk whatever new cues a file now holds and push them to the viewers.
   *
   * One walk of a file at a time, and one more after it whenever pieces
   * arrived meanwhile (`coalescing`): `verified` fires per piece, so a queue of
   * identical passes would only postpone the one with something new to find,
   * and dropping them — as this used to — lost the pass that would have found
   * the last pieces of a file.
   *
   * @param {string} sourceKey
   * @param {number} fileIndex
   * @returns {Promise<void>}
   */
  pushFreshCues(sourceKey, fileIndex) {
    return this.#walk(`${sourceKey}:${fileIndex}`, sourceKey, fileIndex);
  }

  async #walkFile(sourceKey, fileIndex) {
    try {
      const file = await this.heldFileFor(sourceKey, fileIndex);
      if (!file) {
        return;
      }
      for (const entry of await warmSubtitleCues(file)) {
        if (this.subtitles.hasPacketCues(sourceKey, fileIndex, entry.trackIndex)) continue;
        const span = entry.spanStartSeconds === null
          ? "empty"
          : `${entry.spanStartSeconds.toFixed(1)}-${entry.spanEndSeconds.toFixed(1)}s`;
        this.#log(
          `subtitle push ${sourceKey.slice(0, 8)}:${fileIndex} track ${entry.trackIndex}: ` +
          `${entry.cues.length} new cue(s) covering ${span}` +
          (entry.withdrawn.length > 0 ? `, ${entry.withdrawn.length} taken back` : "") +
          `, clusters walked ${entry.walkedClusters}/${entry.indexedClusters}, cursor ${entry.cursor}`
        );
        this.#publish({ sourceKey, fileIndex, ...entry });
      }
    } catch (error) {
      this.#warn(`subtitle push ${sourceKey.slice(0, 8)}:${fileIndex} failed: ${error?.message ?? error}`);
    }
  }
}
