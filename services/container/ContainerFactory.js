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
   * @param {(start:number,end:number)=>Promise<Buffer|null>} readRange
   * @param {number} fileSize
   * @param {string} label
   * @returns {Promise<import("./Container.js").Container|null>}
   */
  static async create({ readRange, fileSize, label = "" }) {
    if (typeof readRange !== "function" || !Number.isFinite(fileSize) || fileSize <= 0) return null;
    const head = await readRange(0, Math.min(SNIFF_BYTES - 1, fileSize - 1));
    if (!head) return null;
    if (MatroskaContainer.detect(head)) return new MatroskaContainer({ readRange, fileSize, label });
    if (Mp4Container.detect(head)) return new Mp4Container({ readRange, fileSize, label });
    if (AviContainer.detect(head)) return new AviContainer({ readRange, fileSize, label });
    return null;
  }
}
