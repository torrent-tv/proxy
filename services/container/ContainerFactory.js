/**
 * @file Container factory — detects format and returns the precise Container subclass.
 *
 * Sniffs first 16 bytes (same as container-index/index.js) and instantiates
 * MatroskaContainer / Mp4Container / AviContainer. Falls back to null (unknown).
 * Orchestrators depend on this, not on concrete constructors.
 */

import { MatroskaContainer } from "./MatroskaContainer.js";
import { Mp4Container } from "./Mp4Container.js";
import { AviContainer } from "./AviContainer.js";

const SNIFF_BYTES = 16;

export class ContainerFactory {
  /**
   * The container these bytes are, built over them.
   *
   * `params` is passed through whole, so a caller with a torrent's two readers
   * gets a container that has both — see {@link Container}'s constructor.
   *
   * @param {{ readRange: (start:number,end:number)=>Promise<Buffer|null>, fileSize: number, label?: string, readHeld?: Function, isHeld?: Function }} params
   * @returns {Promise<import("./Container.js").Container|null>}
   */
  static async create(params) {
    const { readRange, fileSize } = params;
    if (typeof readRange !== "function" || !Number.isFinite(fileSize) || fileSize <= 0) return null;
    const head = await readRange(0, Math.min(SNIFF_BYTES - 1, fileSize - 1));
    if (!head) return null;
    if (MatroskaContainer.detect(head)) return new MatroskaContainer(params);
    if (Mp4Container.detect(head)) return new Mp4Container(params);
    if (AviContainer.detect(head)) return new AviContainer(params);
    return null;
  }

  /**
   * The container a file NAME suggests, for the moment the bytes cannot be
   * sniffed.
   *
   * The head of a file nobody has opened is not downloaded, and the cue walk
   * asks the swarm for nothing — so on that one path the name is all there is.
   * It is a fallback and never a preference: the bytes decide wherever they can
   * be read, because a name is what somebody typed and a header is what the
   * muxer wrote.
   *
   * @param {string} name
   * @returns {typeof MatroskaContainer | typeof Mp4Container | null}
   */
  static byName(name) {
    const text = String(name ?? "");
    if (/\.(mp4|m4v|m4a)$/i.test(text)) return Mp4Container;
    if (/\.(mkv|mka|webm)$/i.test(text)) return MatroskaContainer;
    return null;
  }
}
