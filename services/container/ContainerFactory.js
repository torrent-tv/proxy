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
import { logger } from "../../utils/logger.js";

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

  /**
   * Where a file's real keyframes are, read from the container's own tables
   * rather than by scanning the media.
   *
   * The problem it solves: on the video-COPY path ffmpeg can only cut segments
   * at the source's existing keyframes. A playlist declaring an even grid
   * instead is false, and players punish it — either walking the whole file to
   * rebuild the timeline, or presenting audio with no picture because a segment
   * begins with nothing decodable (both seen in the field 2026-08-02; the file
   * measured had 10.43 s keyframe spacing against our declared 4 s).
   *
   * Scanning is not an option: the file is served from a torrent, and a full
   * packet scan of 5.5 GB found 77 keyframes in 45 s without finishing.
   * Containers already store the table, and a couple of point reads get it —
   * 16 KB and 0.8 s for 570 keyframes on that same file.
   *
   * This is the sniff plus the container's own reading, which is why it lives
   * on the factory: doing it anywhere else meant a third place that decided
   * what a file is.
   *
   * @param {{ readRange: (start:number,end:number)=>Promise<Buffer|null>, fileSize: number, label?: string }} params
   * @returns {Promise<{ times: number[] | null, format: string, tolerance: number }>}
   *   Ascending seconds, or null times where this file has no readable index —
   *   the caller must then not claim to know the grid. The format is which
   *   container answered, reported whether or not it produced anything: how
   *   often an index disagrees with its own file is a question about the
   *   CONTAINER, and a measurement that does not say which one cannot answer it.
   */
  static async readKeyframeIndex({ readRange, fileSize, label = "" }) {
    if (typeof readRange !== "function" || !Number.isFinite(fileSize) || fileSize <= 0) {
      return { times: null, format: "unknown", tolerance: 0 };
    }
    const startedAt = Date.now();
    let container = null;
    try {
      container = await ContainerFactory.create({ readRange, fileSize, label });
    } catch (error) {
      logger.warn(`container-index: failed to read "${label}": ${error?.message ?? error}`);
      return { times: null, format: "unrecognised", tolerance: 0 };
    }
    if (!container) {
      return { times: null, format: "unrecognised", tolerance: 0 };
    }
    const format = container.formatName;
    let index = null;
    try {
      index = await container.readKeyframeIndex();
    } catch (error) {
      // A malformed or partly-downloaded index must never take playback down —
      // it only means the grid is unknown, which the caller already handles.
      logger.warn(`container-index: failed to read index for "${label}": ${error?.message ?? error}`);
      return { times: null, format, tolerance: 0 };
    }
    const elapsedMs = Date.now() - startedAt;
    const times = index && Array.isArray(index.times) ? index.times : null;
    if (times) {
      logger.info(
        `container-index: ${times.length} keyframes from the ${format} index in ${elapsedMs}ms for "${label}"`
      );
    } else {
      logger.info(`container-index: no usable index for "${label}" (${format}, ${elapsedMs}ms)`);
    }
    return { times, format, tolerance: Number.isFinite(index?.tolerance) ? index.tolerance : 0 };
  }

  static byName(name) {
    const text = String(name ?? "");
    if (/\.(mp4|m4v|m4a)$/i.test(text)) return Mp4Container;
    if (/\.(mkv|mka|webm)$/i.test(text)) return MatroskaContainer;
    return null;
  }
}
