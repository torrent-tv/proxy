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
import { strictReader } from "./unavailable.js";

const SNIFF_BYTES = 16;

export class ContainerFactory {
  /**
   * The container these bytes are, built over them.
   *
   * Null means the bytes were read and are none of the formats this knows — a
   * statement about the file. Bytes that have not arrived throw
   * `BytesUnavailable`, which is not one: until 2026-10-01 they came back as
   * null too, and a file whose head was still downloading was remembered as
   * being of no known format.
   *
   * @param {{ readRange: (start:number,end:number)=>Promise<Buffer|null>, fileSize: number, label?: string, portionBytes?: number }} params
   * @returns {Promise<import("./Container.js").Container|null>}
   */
  static async create(params) {
    const { readRange, fileSize } = params;
    if (typeof readRange !== "function" || !Number.isFinite(fileSize) || fileSize <= 0) return null;
    const head = await strictReader(readRange, fileSize)(0, Math.min(SNIFF_BYTES, fileSize) - 1);
    if (MatroskaContainer.detect(head)) return new MatroskaContainer(params);
    if (Mp4Container.detect(head)) return new Mp4Container(params);
    if (AviContainer.detect(head)) return new AviContainer(params);
    return null;
  }
}
