/**
 * @file Matroska/WebM container — RFC 9559.
 *
 * Reads Tracks in one pass for all media types (video, audio, subtitle).
 * Implements spec-accurate flag handling:
 *  - FlagEnabled 0xB9 default 1, zero-length element = default (not disabled)
 *  - FlagDefault 0x88 default 1, declaresDefault tracks whether element was written
 *  - FlagForced 0x55AA only for subtitles, FlagHearingImpaired 0x55AB, FlagVisualImpaired 0x55AC,
 *    FlagTextDescriptions 0x55AD, FlagOriginal 0x55AE, FlagCommentary 0x55AF
 *  - Language 0x22B59C default "eng" (RFC 8794 §11.1.19: an element equal to its
 *    default need not be written, and the reader MUST read the default),
 *    LanguageBCP47 0x22B59D MUST — when present, Language ignored
 *  - CodecID 0x86, CodecPrivate 0x63A2, Name 0x536E, TrackType 0x83 (1 video, 2 audio, 17 subtitle)
 *
 * **One reading of each thing the file states, kept on the container.** The
 * layout of the Segment, the Tracks element and the Cues table are each read
 * once and kept — and only once they have been read whole: a read whose bytes
 * have not arrived throws `BytesUnavailable` and leaves nothing behind
 * (`unavailable.js`). The keyframe times and the subtitle plan are both taken
 * from the one Cues reading. Until 2026-10-01 the Cues table was read three
 * times by three functions, the subtitle one kept a read that had not arrived
 * as "no clusters", and an embedded track showed nothing for a whole session.
 *
 * **Read where it lies.** Elements are found by walking the Segment's top-level
 * headers, not by hoping they fit a head window, and read a portion at a time
 * through `ebml-stream.js` — so a large Tracks element or Cues table is read by
 * its own size and never cut short by a bound of ours.
 *
 * Byte-level EBML grammar is `ebml-reader.js` and `ebml-stream.js`; the clusters
 * found from downloaded bytes are `matroska-clusters.js`. Everything Matroska
 * states about itself is read in this module or that one, and the class is the
 * only way in.
 */

import { Container } from "./Container.js";
import { VideoTrack } from "../tracks/VideoTrack.js";
import { h264Configuration } from "./h264-configuration.js";
import { hevcConfiguration } from "./hevc-configuration.js";
import { AudioTrack } from "../tracks/AudioTrack.js";
import { TextSubtitleTrack, TEXT_CODECS_MATROSKA } from "../tracks/TextSubtitleTrack.js";
import { ImageSubtitleTrack } from "../tracks/ImageSubtitleTrack.js";
import { ContainerTrack } from "../tracks/ContainerTrack.js";
import { iterateElements, readFloat, readUint } from "./ebml-reader.js";
import { ElementReader } from "./ebml-stream.js";
import { firstFrameOffset, readBlockHeader, walkHeldClusters } from "./matroska-clusters.js";
import { readMatroskaPackets } from "./matroska-packets.js";
import { RetainedReads } from "./RetainedReads.js";
import { isUnavailable } from "./unavailable.js";
import {
  ID_ATTACHED_FILE, ID_ATTACHMENTS, ID_CHAPTERS, ID_FILE_DATA, ID_FILE_MEDIA_TYPE, ID_FILE_NAME, ID_INFO_TITLE, ID_TAGS,
  chapterTitlesOf, coverIndexOf, workFromTags
} from "./matroska-work-tags.js";
import {
  COVER_TYPES, MAX_COVER_BYTES, OutsideReadableEdges, edgeReader, emptyWorkTags, imageTypeOf, isNumberingOnly, text, textList
} from "./work-tags.js";

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_SEEK_HEAD = 0x114d9b74;
const ID_SEEK = 0x4dbb;
const ID_SEEK_ID = 0x53ab;
const ID_SEEK_POSITION = 0x53ac;
const ID_INFO = 0x1549a966;
const ID_TIMESTAMP_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;
const ID_CLUSTER = 0x1f43b675;
const ID_CUES = 0x1c53bb6b;
const ID_CUE_POINT = 0xbb;
const ID_CUE_TIME = 0xb3;
const ID_CUE_TRACK_POSITIONS = 0xb7;
const ID_CUE_TRACK = 0xf7;
const ID_CUE_CLUSTER_POSITION = 0xf1;
const ID_TIMESTAMP = 0xe7;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK_GROUP = 0xa0;
const ID_BLOCK = 0xa1;
const ID_BLOCK_DURATION = 0x9b;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_NUMBER = 0xd7;
const ID_TRACK_TYPE = 0x83;
const ID_FLAG_ENABLED = 0xb9;
const ID_FLAG_DEFAULT = 0x88;
const ID_FLAG_FORCED = 0x55aa;
const ID_FLAG_HEARING = 0x55ab;
const ID_FLAG_VISUAL = 0x55ac;
const ID_FLAG_TEXT_DESCR = 0x55ad;
const ID_FLAG_ORIGINAL = 0x55ae;
const ID_FLAG_COMMENTARY = 0x55af;
const ID_CODEC_ID = 0x86;
const ID_CODEC_PRIVATE = 0x63a2;
const ID_LANGUAGE = 0x22b59c;
const ID_LANGUAGE_BCP47 = 0x22b59d;
const ID_NAME = 0x536e;
const ID_VIDEO = 0xe0;
const ID_AUDIO = 0xe1;
const ID_PIXEL_WIDTH = 0xb0;
const ID_PIXEL_HEIGHT = 0xba;
const ID_DISPLAY_WIDTH = 0x54b0;
const ID_DISPLAY_HEIGHT = 0x54ba;
const ID_SAMPLING_FREQUENCY = 0xb5;
const ID_CHANNELS = 0x9f;
const ID_AUDIO_BIT_DEPTH = 0x6264;

/** RFC 9559 §5.1.2.1: nanoseconds per tick when Info omits TimestampScale. */
const DEFAULT_TIMESTAMP_SCALE = 1_000_000;
/** RFC 9559 §5.1.4.1.19: what an absent or empty `Language` element means. */
const DEFAULT_LANGUAGE = "eng";

const TRACK_TYPE_VIDEO = 1;
const TRACK_TYPE_AUDIO = 2;
const TRACK_TYPE_SUBTITLE = 17;

/**
 * ReadOrder, Layer, Style, Name, MarginL, MarginR, MarginV, Effect — the eight
 * fields Matroska writes before the text of an SSA/ASS event. See
 * {@link MatroskaContainer.cueTextOf} for the quotation this comes from.
 */
const ASS_FIELDS_BEFORE_TEXT = 8;

function readString(buf, el) {
  return buf.toString("utf8", el.dataOffset, el.dataOffset + el.size).replace(/\0+$/, "");
}

/**
 * @typedef {object} SegmentLayout
 * @property {number} segmentDataOffset - Where the Segment's data begins.
 * @property {number} segmentEnd - One past its last byte (the file's end for an
 *   unknown-sized Segment).
 * @property {number} secondsPerTick
 * @property {number | null} infoAt - Positions of the top-level elements, from
 *   the walk to the first cluster or from the SeekHead.
 * @property {number | null} tracksAt
 * @property {number | null} cuesAt
 * @property {number | null} tagsAt
 * @property {number | null} chaptersAt
 * @property {number | null} attachmentsAt
 * @property {string | null} segmentTitle - `Info/Title`, RFC 9559 §5.1.2.12.
 * @property {number | null} firstClusterAt
 */

export class MatroskaContainer extends Container {
  /** @type {Buffer | null} */
  #declarations = null;

  /** @type {SegmentLayout | null} */
  #layout = null;

  /** @type {Array<import("../tracks/ContainerTrack.js").ContainerTrack> | null} */
  #tracks = null;
  #packets = null;
  #packetStates = new Map();

  /**
   * The Cues reading: undefined until read, null when the file has none.
   * @type {{ points: Array<{ ticks: number, positions: Array<{ track: number, clusterAt: number }> }> } | null | undefined}
   */
  #cues = undefined;

  /** @type {import("./work-tags.js").WorkTags | null} */
  #workTags = null;

  /**
   * Where the cover's data lies: undefined until looked for, null for none.
   * @type {{ at: number, size: number, mediaType: string } | null | undefined}
   */
  #coverAt = undefined;

  get formatName() {
    return "matroska";
  }

  packetIndexBytes() {
    return [...this.#packetStates.values()].reduce((sum, state) => sum +
      [...(state.packets?.values() ?? [])].reduce((bytes, records) => bytes + records.allocatedBytes, 0), 0);
  }

  static detect(head) {
    return isMatroska(head);
  }

  /**
   * The keyframe times this container's own index states, in ascending seconds.
   *
   * Static so a caller that has bytes and no container can ask; the reading is
   * the instance's, over a container built for the purpose.
   *
   * @param {(start:number,end:number)=>Promise<Buffer|null>} readRange
   * @param {number} fileSize
   * @returns {Promise<number[]|null>} Null where the container has no index.
   */
  static async readKeyframeTimes(readRange, fileSize) {
    const index = await new MatroskaContainer({ readRange, fileSize }).parseKeyframeIndex();
    return index ? index.times : null;
  }

  /**
   * @param {(start:number,end:number)=>Promise<Buffer|null>} readRange
   * @param {number} fileSize
   * @returns {Promise<object|null>}
   */
  static readSubtitlePlan(readRange, fileSize) {
    return new MatroskaContainer({ readRange, fileSize }).readSubtitlePlan();
  }

  /**
   * The blocks one track has inside a cluster held whole in a buffer.
   *
   * @param {Buffer} bytes - The cluster, from its own element header onward.
   * @param {number} trackNumber
   * @param {number} secondsPerTick
   * @returns {{ startSeconds: number, endSeconds: number | null, payload: Buffer }[]}
   */
  static blocksInCluster(bytes, trackNumber, secondsPerTick) {
    return harvestCluster(bytes, trackNumber, secondsPerTick);
  }

  /**
   * The blocks one track has inside a cluster whose bounds are already known —
   * RFC 9559 §5.1.3.4 (SimpleBlock) and §5.1.3.5 (BlockGroup).
   *
   * @param {Buffer} buffer
   * @param {{ dataOffset: number, size: number }} cluster
   * @param {number} trackNumber
   * @param {number} secondsPerTick
   * @returns {{ startSeconds: number, durationSeconds: number | null, payload: Buffer }[]}
   */
  static blocksOfTrack(buffer, cluster, trackNumber, secondsPerTick) {
    return blocksOfTrack(buffer, cluster, trackNumber, secondsPerTick);
  }

  /**
   * A reader for the inside of one element: a portion at a time, never past
   * the element's end — so a Cues table of thousands of CuePoints costs a few
   * reads rather than one per CuePoint, and nothing after the element is
   * fetched for it.
   *
   * @param {number} end - One past the element's last byte.
   * @returns {ElementReader}
   */
  #readerWithin(end) {
    return new ElementReader({
      read: this.readRange,
      fileSize: this.fileSize,
      portionBytes: this.portionBytes,
      prefetch: true,
      readableUntil: () => end
    });
  }

  /**
   * Where the Segment's top-level elements are.
   *
   * Found by walking their HEADERS from the Segment's start to the first
   * cluster — each one costs the bytes of its header and nothing of its data —
   * and, for what lies after the clusters, from the SeekHead. RFC 9559 §6.4: a
   * Cues element SHOULD be stored before the first cluster or be referenced by
   * a SeekHead, so the two together find it wherever a conforming file puts it.
   *
   * @returns {Promise<SegmentLayout | null>} Null for bytes that are not a
   *   Matroska Segment.
   */
  async #segmentLayout() {
    if (this.#layout !== null) {
      return this.#layout;
    }
    const reader = new ElementReader({ read: this.readRange, fileSize: this.fileSize, portionBytes: this.portionBytes });
    let segment = null;
    for (let at = 0; at < this.fileSize;) {
      const header = await reader.header(at, this.fileSize);
      if (!header || (at === 0 && header.id !== ID_EBML)) return null;
      if (header.end !== null && header.end > this.fileSize) throw new Error("Matroska top-level element exceeds the file.");
      if (header.id === ID_SEGMENT) { segment = header; break; }
      if (header.end === null || header.end <= at) throw new Error("Matroska top-level element has no bounded next position.");
      at = header.end;
    }
    if (!segment) {
      return null;
    }
    const segmentDataOffset = segment.dataOffset;
    const segmentEnd = segment.size === null ? this.fileSize : Math.min(this.fileSize, segmentDataOffset + segment.size);

    /** @type {Map<number, number>} */
    const found = new Map();
    /** @type {Map<number, number>} */
    const seeks = new Map();
    let firstClusterAt = null;
    let at = segmentDataOffset;
    while (at < segmentEnd) {
      const header = await reader.header(at, segmentEnd);
      if (!header) {
        break;
      }
      if (header.id === ID_CLUSTER) {
        firstClusterAt = at;
        break;
      }
      if (!found.has(header.id)) {
        found.set(header.id, at);
      }
      if (header.id === ID_SEEK_HEAD && header.size !== null) {
        const data = await reader.data(header);
        if (data) {
          for (const [id, position] of readSeekEntries(data)) {
            seeks.set(id, segmentDataOffset + position);
          }
        }
      }
      if (header.end === null) {
        break;
      }
      at = header.end;
    }
    const positionOf = (id) => found.get(id) ?? seeks.get(id) ?? null;

    let secondsPerTick = DEFAULT_TIMESTAMP_SCALE / 1e9;
    let segmentTitle = null;
    const infoAt = positionOf(ID_INFO);
    if (infoAt !== null) {
      const info = await reader.header(infoAt, segmentEnd);
      const data = info && info.id === ID_INFO ? await reader.data(info) : null;
      if (data) {
        for (const field of iterateElements(data)) {
          if (field.id === ID_TIMESTAMP_SCALE) {
            const scale = readUint(data, field.dataOffset, field.size);
            if (scale > 0) {
              secondsPerTick = scale / 1e9;
            }
          } else if (field.id === ID_INFO_TITLE) {
            segmentTitle = readString(data, field);
          }
        }
      }
    }
    this.#layout = {
      segmentDataOffset,
      segmentEnd,
      secondsPerTick,
      infoAt,
      tracksAt: positionOf(ID_TRACKS),
      cuesAt: positionOf(ID_CUES),
      tagsAt: positionOf(ID_TAGS),
      chaptersAt: positionOf(ID_CHAPTERS),
      attachmentsAt: positionOf(ID_ATTACHMENTS),
      segmentTitle,
      firstClusterAt: firstClusterAt ?? seeks.get(ID_CLUSTER) ?? null
    };
    return this.#layout;
  }

  /**
   * Duration and the start of this file's own timeline, per RFC 9559 §5.1.2.
   *
   * Duration is stated in `Info` as a FLOAT in ticks. The start of the timeline
   * is not stated anywhere — Matroska has no such element — so it is the
   * timestamp of the first Cluster, which is what the first frame is placed
   * against.
   *
   * Kept only once it has been read: a head that had not arrived used to leave
   * an empty answer here for the life of the container.
   *
   * @returns {Promise<import("./Container.js").ContainerMediaInfo>}
   */
  async readMediaInfo() {
    if (this.mediaInfo) {
      return this.mediaInfo;
    }
    /** @type {import("./Container.js").ContainerMediaInfo} */
    const info = { format: this.formatName, durationSeconds: null, startTimeSeconds: null };
    const layout = await this.#segmentLayout();
    if (!layout) {
      this.mediaInfo = info;
      return info;
    }
    const reader = new ElementReader({ read: this.readRange, fileSize: this.fileSize, portionBytes: this.portionBytes });
    if (layout.infoAt !== null) {
      const header = await reader.header(layout.infoAt, layout.segmentEnd);
      const data = header && header.id === ID_INFO ? await reader.data(header) : null;
      if (data) {
        for (const field of iterateElements(data)) {
          if (field.id === ID_DURATION) {
            const ticks = readFloat(data, field.dataOffset, field.size);
            if (ticks !== null && ticks > 0) {
              info.durationSeconds = ticks * layout.secondsPerTick;
            }
          }
        }
      }
    }
    if (layout.firstClusterAt !== null) {
      info.startTimeSeconds = await clusterTimestampSeconds(reader, layout.firstClusterAt, layout);
    }
    this.mediaInfo = info;
    return info;
  }

  /**
   * What the file states about the work: `Info/Title`, the `Tags` that apply
   * to the whole file, the titles of its chapters and tracks, and whether it
   * carries a cover (see `matroska-work-tags.js`).
   *
   * Each element is read on its own, so one that lies outside the bytes this
   * reading may fetch costs only itself. A reading that left something out is
   * not kept: the bytes may be held by the next ask.
   *
   * @param {(start: number, end: number) => boolean} mayFetch
   * @returns {Promise<import("./work-tags.js").WorkTags>}
   */
  async readWorkTags(mayFetch) {
    if (this.#workTags) return this.#workTags;
    const tags = emptyWorkTags();
    const layout = await this.#segmentLayout();
    if (!layout) {
      this.#workTags = tags;
      return tags;
    }
    tags.segmentTitle = text(layout.segmentTitle);
    const reader = new ElementReader({ read: edgeReader(this.readRange, mayFetch, isUnavailable), fileSize: this.fileSize, portionBytes: this.portionBytes });
    const leftOut = (error) => {
      if (!(error instanceof OutsideReadableEdges)) throw error;
      tags.outsideEdges = true;
    };
    const dataOf = async (at, id) => {
      if (at === null) return null;
      const header = await reader.header(at, layout.segmentEnd);
      return header && header.id === id ? reader.data(header) : null;
    };
    try {
      const data = await dataOf(layout.tagsAt, ID_TAGS);
      if (data) Object.assign(tags, workFromTags(data));
    } catch (error) { leftOut(error); }
    try {
      const data = await dataOf(layout.chaptersAt, ID_CHAPTERS);
      if (data) tags.chapterTitles = textList(chapterTitlesOf(data).filter((title) => !isNumberingOnly(title)));
    } catch (error) { leftOut(error); }
    try {
      const cover = await this.#coverAddress(reader, layout);
      if (cover && cover.size > 0 && cover.size <= MAX_COVER_BYTES) tags.cover = { type: cover.mediaType, size: cover.size };
    } catch (error) { leftOut(error); }
    tags.trackTitles = textList((await this.readTracks()).map((track) => track.name));
    if (!tags.outsideEdges) this.#workTags = tags;
    return tags;
  }

  /**
   * The cover the file carries as an attachment, its bytes checked to be the
   * image its type says. `null` where there is none, it is larger than
   * {@link MAX_COVER_BYTES}, or its bytes are not an image a browser shows.
   *
   * @param {(start: number, end: number) => boolean} mayFetch
   * @returns {Promise<{ type: string, bytes: Buffer } | null>}
   */
  async readCover(mayFetch) {
    const layout = await this.#segmentLayout();
    if (!layout) return null;
    const read = edgeReader(this.readRange, mayFetch, isUnavailable);
    const reader = new ElementReader({ read, fileSize: this.fileSize, portionBytes: this.portionBytes });
    const cover = await this.#coverAddress(reader, layout);
    if (!cover || cover.size === 0 || cover.size > MAX_COVER_BYTES) return null;
    const bytes = Buffer.from(await read(cover.at, cover.at + cover.size - 1));
    const type = imageTypeOf(bytes);
    return type && COVER_TYPES.has(type) ? { type, bytes } : null;
  }

  /**
   * Where the cover's data lies, from the headers of the attachments: each
   * `AttachedFile`'s name and media type are read, its data never — fonts of
   * an anime release are megabytes each.
   *
   * @param {ElementReader} reader
   * @param {SegmentLayout} layout
   * @returns {Promise<{ at: number, size: number, mediaType: string } | null>}
   */
  async #coverAddress(reader, layout) {
    if (this.#coverAt !== undefined) return this.#coverAt;
    if (layout.attachmentsAt === null) return (this.#coverAt = null);
    const attachments = await reader.header(layout.attachmentsAt, layout.segmentEnd);
    if (!attachments || attachments.id !== ID_ATTACHMENTS || attachments.end === null) return (this.#coverAt = null);
    const files = [];
    for (let at = attachments.dataOffset; at < attachments.end;) {
      const file = await reader.header(at, attachments.end);
      if (!file || file.end === null) break;
      if (file.id === ID_ATTACHED_FILE) {
        const found = { name: "", mediaType: "", at: null, size: 0 };
        for (let inner = file.dataOffset; inner < file.end;) {
          const field = await reader.header(inner, file.end);
          if (!field || field.end === null) break;
          if (field.id === ID_FILE_NAME || field.id === ID_FILE_MEDIA_TYPE) {
            const value = (await reader.data(field))?.toString("utf8").replace(/\0+$/u, "") ?? "";
            if (field.id === ID_FILE_NAME) found.name = value;
            else found.mediaType = value.toLowerCase();
          } else if (field.id === ID_FILE_DATA) {
            found.at = field.dataOffset;
            found.size = field.size ?? 0;
          }
          inner = field.end;
        }
        if (found.at !== null) files.push(found);
      }
      at = file.end;
    }
    const index = coverIndexOf(files);
    this.#coverAt = index < 0 ? null : { at: files[index].at, size: files[index].size, mediaType: files[index].mediaType || "image/jpeg" };
    return this.#coverAt;
  }

  /**
   * Every track the file declares, in its order, read once.
   *
   * @returns {Promise<import("../tracks/index.js").ContainerTrack[]>}
   */
  async readTracks() {
    this.#declarations ??= new RetainedReads(this.packetMemory);
    if (this.#tracks !== null) {
      return this.#tracks;
    }
    const layout = await this.#segmentLayout();
    if (!layout || layout.tracksAt === null) {
      this.#tracks = [];
      return this.#tracks;
    }
    const reader = new ElementReader({ read: this.readRange, fileSize: this.fileSize, portionBytes: this.portionBytes });
    const tracksHeader = await reader.header(layout.tracksAt, layout.segmentEnd);
    if (!tracksHeader || tracksHeader.id !== ID_TRACKS || tracksHeader.end === null) {
      this.#tracks = [];
      return this.#tracks;
    }
    /** @type {import("../tracks/index.js").ContainerTrack[]} */
    const result = [];
    const counters = { video: -1, audio: -1, subtitle: -1 };
    const within = this.#readerWithin(tracksHeader.end);
    let at = tracksHeader.dataOffset;
    while (at < tracksHeader.end) {
      const entry = await within.header(at, tracksHeader.end);
      if (!entry || entry.end === null) {
        break;
      }
      if (entry.id === ID_TRACK_ENTRY) {
        const data = entry.size === 0 ? Buffer.alloc(0) : entry.size > this.portionBytes ? null
          : await this.#declarations.read(entry.dataOffset, entry.end - 1, () => within.data(entry));
        // An entry larger than one portion is refused rather than assembled.
        // Its type cannot be known without its data, so it is kept as a track
        // of no kind — which makes the count of its kind short by one, and
        // `alignWithBanner` then refuses to line the two readings up rather
        // than pairing them wrongly.
        const fields = data ? parseTrackEntry(data) : { refused: true, trackNumber: null };
        const track = trackFrom(fields, counters);
        if (track) {
          if (["V_MPEG4/ISO/AVC", "V_MPEGH/ISO/HEVC"].includes(track.codecId) && track.codecPrivateB64) {
            const configuration = (track.codecId === "V_MPEG4/ISO/AVC" ? h264Configuration : hevcConfiguration)(Buffer.from(track.codecPrivateB64, "base64"));
            track.codecConfiguration = configuration;
            track.reorderDepth = configuration.reorderDepth;
            track.width = configuration.width;
            track.height = configuration.height;
            track.bitDepth = configuration.bitDepth;
            track.fps = configuration.fps ?? track.fps;
          }
          track.defaultDurationSeconds = fields.defaultDurationSeconds || track.defaultDurationSeconds || 0;
          track.seekPrerollSeconds = Math.max(fields.seekPrerollSeconds ?? 0, track.seekPrerollSeconds ?? 0);
          track.codecDelaySeconds = fields.codecDelaySeconds ?? 0;
          track.timestampScale = fields.timestampScale ?? 1;
          track.codecRanges = [[entry.dataOffset, entry.end - 1]];
          result.push(track);
        }
      }
      at = entry.end;
    }
    this.#tracks = result;
    return result;
  }

  async readPacketIndex(interval) {
    if (this.#packets) return this.#packets;
    const layout = await this.#segmentLayout();
    if (!layout) throw new Error("Matroska Segment is absent.");
    const tracks = await this.readTracks();
    const info = await this.readMediaInfo();
    const start = await this.#packetStart(layout, tracks, interval);
    // Reuse a contiguous reading that has already reached this cue. A seek
    // across an unindexed gap gets its own reading instead of walking the gap.
    let state = [...this.#packetStates.values()]
      .filter(one => one.startAt <= start && one.at >= start)
      .sort((a, b) => b.startAt - a.startAt)[0];
    if (!state) {
      state = { startAt: start, at: start };
      this.#packetStates.set(start, state);
    }
    const index = await readMatroskaPackets({ readRange: this.readRange,
      fileSize: this.fileSize, portionBytes: this.portionBytes, layout, tracks,
      durationSeconds: info.durationSeconds, interval, state, packetMemory: this.packetMemory });
    if (index.isComplete() && state.startAt === layout.firstClusterAt) {
      this.#packets = index;
    }
    return index;
  }

  async #packetStart(layout, tracks, interval) {
    const first = layout.firstClusterAt ?? layout.segmentEnd;
    if (!Number.isFinite(interval?.from) || interval.from <= 0) return first;
    const cues = await this.readCues();
    const requested = tracks.filter(track => interval.trackIds ? interval.trackIds.includes(track.trackNumber)
      : ["video", "audio"].includes(track.type));
    // A subtitle can remain visible across arbitrarily many picture Clusters;
    // picture cues alone cannot prove that an earlier subtitle has ended.
    if (requested.every(track => track.type === "subtitle")) return first;
    const cueTrack = requested.find(track => track.type === "video") ??
      tracks.find(track => track.type === "video") ?? requested[0];
    if (!cueTrack) return first;
    const points = (cues?.points ?? []).flatMap(point => point.positions
      .filter(position => position.track === cueTrack.trackNumber && position.clusterAt >= first && position.clusterAt < layout.segmentEnd)
      .map(position => ({ at: position.clusterAt, seconds: point.ticks * layout.secondsPerTick })))
      .sort((a, b) => a.seconds - b.seconds);
    const preroll = Math.max(0, ...requested.map(track =>
      Math.max(track.seekPrerollSeconds ?? 0, track.defaultDurationSeconds ?? 0)));
    let preceding = -1;
    for (let index = 0; index < points.length && points[index].seconds <= interval.from - preroll; index++) preceding = index;
    // The preceding cue's Cluster also retains audio that overlaps this cut
    // and decoder dependencies before the first presented packet.
    return preceding < 0 ? first : points[Math.max(0, preceding - 1)].at;
  }

  /**
   * The Cues table, read once, every CuePoint with every track it names.
   *
   * @returns {Promise<{ points: Array<{ ticks: number, positions: Array<{ track: number, clusterAt: number }> }> } | null>}
   *   Null where the file has no Cues element — a statement about the file,
   *   kept. A Cues element that has not downloaded throws and is not kept.
   */
  async readCues() {
    if (this.#cues !== undefined) {
      return this.#cues;
    }
    const layout = await this.#segmentLayout();
    if (!layout || layout.cuesAt === null) {
      this.#cues = null;
      return null;
    }
    const reader = new ElementReader({ read: this.readRange, fileSize: this.fileSize, portionBytes: this.portionBytes });
    const cues = await reader.header(layout.cuesAt, layout.segmentEnd);
    if (!cues || cues.id !== ID_CUES || cues.end === null) {
      // The SeekHead names a position with no Cues element at it. The file is
      // wrong there, and the same bytes will say the same thing next time.
      this.#cues = null;
      return null;
    }
    const points = [];
    const within = this.#readerWithin(cues.end);
    let at = cues.dataOffset;
    while (at < cues.end) {
      const point = await within.header(at, cues.end);
      if (!point || point.end === null) {
        break;
      }
      if (point.id === ID_CUE_POINT) {
        const data = await within.data(point);
        if (data) {
          const parsed = parseCuePoint(data, layout.segmentDataOffset);
          if (parsed) {
            points.push(parsed);
          }
        }
      }
      at = point.end;
    }
    this.#cues = { points };
    return this.#cues;
  }

  /**
   * This container's subtitle tracks, the Cues table and the clusters it
   * names — everything the cue walk starts from.
   *
   * `cuesState` says whether the file has a Cues table at all; where it has
   * none, the walk finds clusters from the downloaded bytes themselves.
   *
   * @returns {Promise<object | null>} Null for bytes that are not Matroska.
   */
  async readSubtitlePlan() {
    const layout = await this.#segmentLayout();
    if (!layout) {
      return null;
    }
    const allTracks = await this.readTracks();
    const cues = await this.readCues();
    const subtitles = allTracks.filter((track) => track.type === "subtitle");
    const declared = subtitles.map((track) => ({
      trackNumber: track.trackNumber,
      codecId: track.codecId,
      // The three-letter code: this list is lined up against ffmpeg's banner,
      // which prints that form. The RFC 5646 tag rides beside it.
      language: track.languageCode || track.language,
      languageBcp47: track.languageBcp47,
      declaresLanguage: track.declaresLanguage,
      languageSource: track.languageSource,
      name: track.name,
      isDefault: track.isDefault,
      declaresDefault: track.declaresDefault,
      isEnabled: track.isEnabled,
      isForced: track.isForced === true,
      isHearingImpaired: track.isHearingImpaired === true
    }));
    /** @type {Map<number, Set<number>>} */
    const byTrack = new Map();
    /** @type {Map<number, number>} */
    const entrySeconds = new Map();
    for (const point of cues?.points ?? []) {
      const seconds = point.ticks * layout.secondsPerTick;
      for (const { track, clusterAt } of point.positions) {
        if (!byTrack.has(track)) {
          byTrack.set(track, new Set());
        }
        byTrack.get(track).add(clusterAt);
        // The cluster begins at or before the earliest frame that names it.
        const known = entrySeconds.get(clusterAt);
        if (known === undefined || seconds < known) {
          entrySeconds.set(clusterAt, seconds);
        }
      }
    }
    const tracks = subtitles
      .filter((track) => TEXT_CODECS_MATROSKA.has(track.codecId) && track.isEnabled)
      .map((track) => ({
        trackNumber: track.trackNumber,
        declaredIndex: track.declaredIndex,
        codecId: track.codecId,
        language: track.language,
        languageBcp47: track.languageBcp47,
        declaresLanguage: track.declaresLanguage,
        languageSource: track.languageSource,
        name: track.name,
        isDefault: track.isDefault,
        isForced: track.isForced === true,
        isHearingImpaired: track.isHearingImpaired === true,
        codecPrivate: track.codecPrivateB64,
        clusterPositions: [...(byTrack.get(track.trackNumber) ?? [])].sort((left, right) => left - right)
      }));
    return {
      tracks,
      declared,
      secondsPerTick: layout.secondsPerTick,
      segmentDataOffset: layout.segmentDataOffset,
      fileSize: this.fileSize,
      segmentEnd: layout.segmentEnd,
      firstClusterAt: layout.firstClusterAt,
      cuesState: cues ? "complete" : "absent",
      entryPoints: [...entrySeconds].map(([at, seconds]) => ({ at, seconds })).sort((left, right) => left.at - right.at),
      subtitleTrackNumbers: tracks.map((track) => track.trackNumber),
      allTrackNumbers: allTracks.map((track) => track.trackNumber).filter((number) => Number.isFinite(number))
    };
  }

  /**
   * The cues this file holds now, for every text track at once — see
   * `matroska-clusters.js` for how clusters are found and in what order read.
   *
   * @param {object} plan
   * @param {object} track
   * @param {object} progress
   * @param {import("./Container.js").HeldReader} held
   * @returns {Promise<{ found: Map<number, object[]>, covered: number, indexed: number, withdrawn: number[], stats: object }>}
   */
  async readHeldCues(plan, track, progress, held) {
    const walked = await walkHeldClusters({ plan, progress, held });
    const found = new Map();
    for (const candidate of plan.tracks) {
      const blocks = walked.found.get(candidate.trackNumber);
      if (!blocks) {
        continue;
      }
      found.set(
        candidate.trackNumber,
        blocks.map((block) => ({
          startSeconds: block.startSeconds,
          endSeconds: block.endSeconds,
          // The block's bytes become text HERE, where the container that
          // framed them is known.
          text: MatroskaContainer.cueTextOf(block.payload, candidate.codecId),
          source: block.source
        }))
      );
    }
    return { ...walked, found };
  }

  /**
   * The text field of one cue as Matroska frames it.
   *
   * Two rules, both from `matroska.org/technical/subtitles.html`, "Now, how are
   * they stored in Matroska?":
   *
   * 1. "All text is converted to UTF-8", so the block is decoded as UTF-8 and
   *    no other encoding is guessed at. A subtitle FILE is a different matter —
   *    there the bytes may be Windows-1251 and `decodeSubtitleBytes` sniffs for
   *    it — but a muxer had to convert before writing the block.
   * 2. "Events are stored in the Block in this order: ReadOrder, Layer, Style,
   *    Name, MarginL, MarginR, MarginV, Effect, Text", and "Start & End field
   *    are used to set TimeStamp and the BlockDuration element". So eight fields
   *    stand before the text, the two timing fields of the file's own row are
   *    NOT among them, and a read order takes their place at the front. The text
   *    itself may hold commas, so everything from the ninth field on is joined
   *    back together.
   *
   * `S_TEXT/UTF8` and `S_TEXT/WEBVTT` have no such framing: the block holds the
   * cue text and nothing else.
   *
   * @param {Buffer} payload - The block's own bytes.
   * @param {string} codecId - Matroska CodecID of the track the block belongs to.
   * @returns {string}
   */
  static cueTextOf(payload, codecId) {
    const text = Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload ?? "");
    if (String(codecId).startsWith("D_WEBVTT/")) {
      // WebM blocks prefix the cue with its identifier and settings lines.
      const first = text.indexOf("\n"), second = text.indexOf("\n", first + 1);
      if (first < 0 || second < 0) throw new Error("WebM subtitle cue prefixes are truncated.");
      return text.slice(second + 1);
    }
    if (!["S_TEXT/ASS", "S_TEXT/SSA", "S_ASS", "S_SSA"].includes(codecId)) {
      return text;
    }
    const fields = text.split(",");
    return fields.length > ASS_FIELDS_BEFORE_TEXT ? fields.slice(ASS_FIELDS_BEFORE_TEXT).join(",") : "";
  }

  /**
   * The keyframe times of the first video track, from the one Cues reading.
   *
   * A CuePoint belongs to the track named inside its CueTrackPositions, and a
   * muxer indexes whatever tracks it likes — field files index their subtitle
   * tracks too, and read without the track those times entered the cut list as
   * though they were keyframes (2026-08-18). Where the filter leaves nothing
   * although a table exists, the unfiltered table is used: less exact than the
   * picture's own keyframes, better than an even grid that has nothing to do
   * with the file.
   *
   * @returns {Promise<{ times: number[], tolerance: number } | null>}
   */
  async parseKeyframeIndex() {
    const layout = await this.#segmentLayout();
    if (!layout) {
      return null;
    }
    const cues = await this.readCues();
    if (!cues) {
      return null;
    }
    const tracks = await this.readTracks();
    const video = tracks.find((track) => track.type === "video")?.trackNumber ?? null;
    const timesFor = (wanted) =>
      cues.points
        .filter((point) => wanted === null || point.positions.some((position) => position.track === wanted))
        .map((point) => point.ticks * layout.secondsPerTick)
        .sort((left, right) => left - right);
    const times = timesFor(video);
    if (times.length > 0) {
      return { times, tolerance: 0 };
    }
    if (video === null) {
      return null;
    }
    const unfiltered = timesFor(null);
    return unfiltered.length > 0 ? { times: unfiltered, tolerance: 0 } : null;
  }
}

/**
 * Whether this looks like a Matroska file (the EBML magic `0x1A45DFA3`).
 *
 * @param {Buffer} head
 * @returns {boolean}
 */
function isMatroska(head) {
  return head.length >= 4 && head.readUInt32BE(0) === ID_EBML;
}

/**
 * The SeekHead's entries, id to position relative to the Segment's data.
 *
 * @param {Buffer} data - The SeekHead's data.
 * @returns {Map<number, number>}
 */
function readSeekEntries(data) {
  const entries = new Map();
  for (const seek of iterateElements(data)) {
    if (seek.id !== ID_SEEK) {
      continue;
    }
    const end = Math.min(data.length, seek.dataOffset + seek.size);
    let targetId = null;
    let position = null;
    for (const field of iterateElements(data, seek.dataOffset, end)) {
      if (field.id === ID_SEEK_ID) {
        targetId = readUint(data, field.dataOffset, field.size);
      } else if (field.id === ID_SEEK_POSITION) {
        position = readUint(data, field.dataOffset, field.size);
      }
    }
    if (targetId !== null && position !== null && !entries.has(targetId)) {
      entries.set(targetId, position);
    }
  }
  return entries;
}

/**
 * The timestamp of a cluster, from its leading children.
 *
 * §5.1.3.1: the Timestamp SHOULD be the first child, or the second after a
 * CRC-32. Children before it are stepped over by their headers; reading stops
 * at the first block, so a cluster's megabytes are never pulled for this.
 *
 * @param {ElementReader} reader
 * @param {number} at
 * @param {SegmentLayout} layout
 * @returns {Promise<number | null>}
 */
async function clusterTimestampSeconds(reader, at, layout) {
  const cluster = await reader.header(at, layout.segmentEnd);
  if (!cluster || cluster.id !== ID_CLUSTER) {
    return null;
  }
  const limit = cluster.end ?? layout.segmentEnd;
  let cursor = cluster.dataOffset;
  while (cursor < limit) {
    const child = await reader.header(cursor, limit);
    if (!child || child.size === null) {
      return null;
    }
    if (child.id === ID_TIMESTAMP) {
      const bytes = await reader.bytes(child.dataOffset, child.size);
      return readUint(bytes, 0, child.size) * layout.secondsPerTick;
    }
    if (child.id === ID_SIMPLE_BLOCK || child.id === ID_BLOCK_GROUP) {
      return null;
    }
    cursor = child.end;
  }
  return null;
}

/**
 * One CuePoint: its time and every track position it names.
 *
 * @param {Buffer} data
 * @param {number} segmentDataOffset - CueClusterPosition is relative to it.
 * @returns {{ ticks: number, positions: Array<{ track: number, clusterAt: number }> } | null}
 */
function parseCuePoint(data, segmentDataOffset) {
  let ticks = null;
  const positions = [];
  for (const field of iterateElements(data)) {
    if (field.id === ID_CUE_TIME) {
      ticks = readUint(data, field.dataOffset, field.size);
      continue;
    }
    if (field.id !== ID_CUE_TRACK_POSITIONS) {
      continue;
    }
    const end = Math.min(data.length, field.dataOffset + field.size);
    let track = null;
    let cluster = null;
    for (const inner of iterateElements(data, field.dataOffset, end)) {
      if (inner.id === ID_CUE_TRACK) {
        track = readUint(data, inner.dataOffset, inner.size);
      } else if (inner.id === ID_CUE_CLUSTER_POSITION) {
        cluster = readUint(data, inner.dataOffset, inner.size);
      }
    }
    if (track !== null && cluster !== null) {
      positions.push({ track, clusterAt: segmentDataOffset + cluster });
    }
  }
  return ticks === null ? null : { ticks, positions };
}

/**
 * Every field of one TrackEntry this proxy reads, with RFC 9559's defaults.
 *
 * @param {Buffer} data - The TrackEntry's data.
 * @returns {object}
 */
function parseTrackEntry(data) {
  const fields = {
    refused: false,
    trackNumber: null,
    type: null,
    codecId: "",
    language: null,
    languageBcp47: "",
    name: "",
    codecPrivateB64: "",
    isEnabled: true,
    // FlagDefault DEFAULTS TO 1; whether the file wrote it is kept apart,
    // because once the default is applied "no track marked" and "every track
    // marked" look the same.
    isDefault: true,
    declaresDefault: false,
    isForced: false,
    isHearing: false,
    isVisual: false,
    isOriginal: false,
    isCommentary: false,
    pixelWidth: null,
    pixelHeight: null,
    displayWidth: null,
    displayHeight: null,
    samplingFreq: null,
    channels: null
  };
  for (const f of iterateElements(data)) {
    switch (f.id) {
      case 0x23e383: fields.defaultDurationSeconds = readUint(data, f.dataOffset, f.size) / 1e9; break;
      case 0x56bb: fields.seekPrerollSeconds = readUint(data, f.dataOffset, f.size) / 1e9; break;
      case 0x56aa: fields.codecDelaySeconds = readUint(data, f.dataOffset, f.size) / 1e9; break;
      case 0x23314f: fields.timestampScale = readFloat(data, f.dataOffset, f.size); break;
      case ID_TRACK_NUMBER: fields.trackNumber = readUint(data, f.dataOffset, f.size); break;
      case ID_TRACK_TYPE: fields.type = readUint(data, f.dataOffset, f.size); break;
      case ID_CODEC_ID: fields.codecId = readString(data, f); break;
      case ID_CODEC_PRIVATE: fields.codecPrivateB64 = data.toString("base64", f.dataOffset, f.dataOffset + f.size); break;
      // An empty element carries its default (RFC 8794 §6.3 and §11.1.19).
      case ID_LANGUAGE: fields.language = f.size === 0 ? DEFAULT_LANGUAGE : readString(data, f); break;
      case ID_LANGUAGE_BCP47: fields.languageBcp47 = readString(data, f); break;
      case ID_NAME: fields.name = readString(data, f); break;
      // Zero length carries the default, which is 1; only an explicit zero
      // takes a track away.
      case ID_FLAG_ENABLED: fields.isEnabled = f.size === 0 || readUint(data, f.dataOffset, f.size) !== 0; break;
      case ID_FLAG_DEFAULT: fields.isDefault = f.size === 0 || readUint(data, f.dataOffset, f.size) === 1; fields.declaresDefault = true; break;
      case ID_FLAG_FORCED: fields.isForced = f.size > 0 && readUint(data, f.dataOffset, f.size) !== 0; break;
      case ID_FLAG_HEARING: fields.isHearing = f.size > 0 && readUint(data, f.dataOffset, f.size) !== 0; break;
      case ID_FLAG_VISUAL: fields.isVisual = f.size > 0 && readUint(data, f.dataOffset, f.size) !== 0; break;
      case ID_FLAG_TEXT_DESCR: break;
      case ID_FLAG_ORIGINAL: fields.isOriginal = f.size > 0 && readUint(data, f.dataOffset, f.size) !== 0; break;
      case ID_FLAG_COMMENTARY: fields.isCommentary = f.size > 0 && readUint(data, f.dataOffset, f.size) !== 0; break;
      case ID_VIDEO: {
        const end = Math.min(data.length, f.dataOffset + f.size);
        for (const vf of iterateElements(data, f.dataOffset, end)) {
          if (vf.id === ID_PIXEL_WIDTH) fields.pixelWidth = readUint(data, vf.dataOffset, vf.size);
          else if (vf.id === ID_PIXEL_HEIGHT) fields.pixelHeight = readUint(data, vf.dataOffset, vf.size);
          else if (vf.id === ID_DISPLAY_WIDTH) fields.displayWidth = readUint(data, vf.dataOffset, vf.size);
          else if (vf.id === ID_DISPLAY_HEIGHT) fields.displayHeight = readUint(data, vf.dataOffset, vf.size);
        }
        break;
      }
      case ID_AUDIO: {
        const end = Math.min(data.length, f.dataOffset + f.size);
        for (const af of iterateElements(data, f.dataOffset, end)) {
          if (af.id === ID_SAMPLING_FREQUENCY) {
            fields.samplingFreq = af.size === 8 ? data.readDoubleBE(af.dataOffset) : readFloat(data, af.dataOffset, af.size);
          } else if (af.id === ID_CHANNELS) {
            fields.channels = readUint(data, af.dataOffset, af.size);
          } else if (af.id === ID_AUDIO_BIT_DEPTH) {
            fields.bitDepth = readUint(data, af.dataOffset, af.size);
          }
        }
        break;
      }
      default: break;
    }
  }
  return fields;
}

/**
 * The track object one TrackEntry describes.
 *
 * The language follows RFC 9559's order: a `LanguageBCP47` element wins and
 * `Language` is then ignored; otherwise `Language`; otherwise its default,
 * `eng` — which a reader MUST apply (RFC 8794 §11.1.19). Where it came from is
 * kept as `languageSource`.
 *
 * @param {object} fields - From {@link parseTrackEntry}.
 * @param {{ video: number, audio: number, subtitle: number }} counters
 * @returns {import("../tracks/ContainerTrack.js").ContainerTrack | null}
 */
function trackFrom(fields, counters) {
  if (fields.trackNumber === null && !fields.refused) {
    return null;
  }
  const declaresLanguage = fields.languageBcp47.length > 0 || fields.language !== null;
  const languageSource = fields.languageBcp47 ? "bcp47" : fields.language !== null ? "language" : "default";
  const language = fields.languageBcp47 || (fields.language !== null ? fields.language : DEFAULT_LANGUAGE);
  const common = {
    trackNumber: fields.trackNumber,
    codecId: fields.codecId,
    language,
    languageBcp47: fields.languageBcp47,
    declaresLanguage,
    languageSource,
    languageCode: fields.language !== null ? fields.language : DEFAULT_LANGUAGE,
    name: fields.name,
    isEnabled: fields.isEnabled,
    isDefault: fields.isDefault,
    declaresDefault: fields.declaresDefault,
    codecPrivateB64: fields.codecPrivateB64
  };
  if (fields.type === TRACK_TYPE_VIDEO) {
    counters.video += 1;
    return new VideoTrack({
      ...common,
      declaredIndex: counters.video,
      width: fields.pixelWidth,
      height: fields.pixelHeight,
      displayWidth: fields.displayWidth,
      displayHeight: fields.displayHeight
    });
  }
  if (fields.type === TRACK_TYPE_AUDIO) {
    counters.audio += 1;
    return new AudioTrack({
      ...common,
      declaredIndex: counters.audio,
      isOriginal: fields.isOriginal,
      isCommentary: fields.isCommentary,
      isVisualImpaired: fields.isVisual,
      channels: fields.channels,
      samplingFrequency: fields.samplingFreq,
      bitDepth: fields.bitDepth
    });
  }
  if (fields.type === TRACK_TYPE_SUBTITLE) {
    counters.subtitle += 1;
    // A track the file marks unusable is still COUNTED: ffmpeg creates and
    // numbers a stream for it, so leaving it out would shift `declaredIndex`
    // off `0:s:N` for every track after it. It is refused where it is offered.
    const isText = TEXT_CODECS_MATROSKA.has(fields.codecId);
    const Target = isText ? TextSubtitleTrack : ImageSubtitleTrack;
    return new Target({
      ...common,
      declaredIndex: counters.subtitle,
      isForced: fields.isForced,
      isHearingImpaired: fields.isHearing,
      clusterPositions: []
    });
  }
  return new ContainerTrack({ ...common, declaredIndex: -1, type: "other" });
}

/**
 * Every block of one track inside one cluster held whole in a buffer.
 *
 * @param {Buffer} buffer - Bytes holding the cluster's payload.
 * @param {{ dataOffset: number, size: number }} cluster - Where that payload is.
 * @param {number} trackNumber - The track to keep.
 * @param {number} secondsPerTick - From the segment's timestamp scale.
 * @returns {{ startSeconds: number, durationSeconds: number | null, payload: Buffer }[]}
 */
function blocksOfTrack(buffer, cluster, trackNumber, secondsPerTick) {
  const end = Math.min(buffer.length, cluster.dataOffset + cluster.size);
  const blocks = [];
  let clusterTicks = null;
  const pending = [];

  const take = (blockStart, blockEnd, durationTicks) => {
    const header = readBlockHeader(buffer, blockStart, blockEnd);
    if (!header || header.trackNumber !== trackNumber) {
      return;
    }
    const payloadAt = firstFrameOffset(buffer, header.dataOffset, blockEnd, header.flags);
    if (payloadAt === null || payloadAt >= blockEnd) {
      return;
    }
    pending.push({ relativeTicks: header.relativeTicks, durationTicks, payload: buffer.subarray(payloadAt, blockEnd) });
  };

  for (const element of iterateElements(buffer, cluster.dataOffset, end)) {
    const elementEnd = Math.min(end, element.dataOffset + element.size);
    if (element.id === ID_TIMESTAMP) {
      clusterTicks = readUint(buffer, element.dataOffset, element.size);
      continue;
    }
    if (element.id === ID_SIMPLE_BLOCK) {
      take(element.dataOffset, elementEnd, null);
      continue;
    }
    if (element.id !== ID_BLOCK_GROUP) {
      continue;
    }
    let blockStart = null;
    let blockEnd = null;
    let durationTicks = null;
    for (const field of iterateElements(buffer, element.dataOffset, elementEnd)) {
      const fieldEnd = Math.min(elementEnd, field.dataOffset + field.size);
      if (field.id === ID_BLOCK) {
        blockStart = field.dataOffset;
        blockEnd = fieldEnd;
      } else if (field.id === ID_BLOCK_DURATION) {
        durationTicks = readUint(buffer, field.dataOffset, field.size);
      }
    }
    if (blockStart !== null) {
      take(blockStart, blockEnd, durationTicks);
    }
  }
  // The Timestamp SHOULD come first (§5.1.3.1), not MUST: blocks before it are
  // placed once the cluster's time is known.
  if (clusterTicks === null) {
    return blocks;
  }
  for (const block of pending) {
    blocks.push({
      startSeconds: (clusterTicks + block.relativeTicks) * secondsPerTick,
      durationSeconds: block.durationTicks === null ? null : block.durationTicks * secondsPerTick,
      payload: block.payload
    });
  }
  return blocks;
}

/**
 * The cues of one track inside one cluster held whole in a buffer.
 *
 * @param {Buffer} bytes - The cluster, from its own element header onward.
 * @param {number} trackNumber
 * @param {number} secondsPerTick
 * @returns {{ startSeconds: number, endSeconds: number | null, payload: Buffer }[]}
 */
function harvestCluster(bytes, trackNumber, secondsPerTick) {
  const header = [...iterateElements(bytes, 0, bytes.length)][0];
  if (!header) {
    return [];
  }
  return blocksOfTrack(bytes, { dataOffset: header.dataOffset, size: header.size }, trackNumber, secondsPerTick).map(
    (block) => ({
      startSeconds: block.startSeconds,
      endSeconds: block.durationSeconds === null ? null : block.startSeconds + block.durationSeconds,
      payload: block.payload
    })
  );
}
