/**
 * @file The subtitle tracks of a Matroska file, and where their cues live.
 *
 * Two halves, both reading only what is asked for by byte range:
 *
 *   - {@link readSubtitlePlan} — once per file: which tracks are text
 *     subtitles, in what codec, and the cluster positions their cue points
 *     name. Two short reads, the head and the Cues element, exactly as the
 *     keyframe reader already does.
 *   - {@link harvestCluster} — per cluster, over bytes already downloaded:
 *     the cues inside it, ready to be shown.
 *
 * Kept apart from `matroska.js` because that file answers one question (where
 * are the keyframes) and is read on the path that starts playback; this one is
 * only ever consulted for a viewer who asked for subtitles.
 */

import { findElement, iterateElements, readUint } from "./ebml-reader.js";
import { blocksOfTrack } from "./matroska-blocks.js";

const ID_SEGMENT = 0x18538067;
const ID_SEEK_HEAD = 0x114d9b74;
const ID_SEEK = 0x4dbb;
const ID_SEEK_ID = 0x53ab;
const ID_SEEK_POSITION = 0x53ac;
const ID_INFO = 0x1549a966;
const ID_TIMESTAMP_SCALE = 0x2ad7b1;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_NUMBER = 0xd7;
const ID_TRACK_TYPE = 0x83;
const ID_CODEC_ID = 0x86;
const ID_CODEC_PRIVATE = 0x63a2;
const ID_LANGUAGE = 0x22b59c;
const ID_NAME = 0x536e;
const ID_FLAG_DEFAULT = 0x88;
/**
 * The rest of what a TrackEntry says about itself, RFC 9559 §5.1.4.1. Read
 * because the file states them and a releaser's own wording in `Name` is the
 * only thing we had before: "fors" and "SDH" in a menu were whatever text
 * someone happened to type.
 *
 * `FlagEnabled` defaults to 1 and means "the track is usable"; a track that
 * says 0 is counted but not offered. `FlagForced` applies only to subtitles and
 * defaults to 0. `FlagHearingImpaired` is set "if and only if the track is
 * suitable for users with hearing impairments". `FlagVisualImpaired`,
 * `FlagOriginal` and `FlagCommentary` bear on the AUDIO choice and are read
 * with that work, not here — see roadmap item 55.
 */
const ID_FLAG_ENABLED = 0xb9;
const ID_FLAG_FORCED = 0x55aa;
const ID_FLAG_HEARING_IMPAIRED = 0x55ab;
/**
 * The language as RFC 5646 writes it. The specification is a MUST: "If this
 * element is used, then any Language elements used in the same TrackEntry MUST
 * be ignored" — so where both are present, this one is the answer and the
 * three-letter code is not.
 */
const ID_LANGUAGE_BCP47 = 0x22b59d;
const ID_CUES = 0x1c53bb6b;
const ID_CUE_POINT = 0xbb;
const ID_CUE_TRACK_POSITIONS = 0xb7;
const ID_CUE_TRACK = 0xf7;
const ID_CUE_CLUSTER_POSITION = 0xf1;

/** TrackType 17 is subtitles; 1 is video and 2 audio. */
const TRACK_TYPE_SUBTITLE = 17;
/** How much of the file start to read: the same window the keyframe reader uses. */
const HEAD_BYTES = 64 * 1024;
/** Cap on the Cues read; a long film indexes to tens of KB. */
const MAX_CUES_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMESTAMP_SCALE = 1_000_000;

/**
 * The codecs whose blocks are text this proxy can turn into WebVTT.
 *
 * `S_TEXT/UTF8` is a plain line of text and needs nothing. `S_TEXT/ASS` and
 * `S_TEXT/SSA` carry a dialogue row whose fields have to be stripped, and their
 * header lives in CodecPrivate — supported, with the stripping done where the
 * cue is turned into WebVTT. `S_HDMV/PGS` and `S_VOBSUB` are pictures, not
 * text, and are deliberately absent: offering them would promise something this
 * path cannot deliver.
 */
const TEXT_CODECS = new Set(["S_TEXT/UTF8", "S_TEXT/ASS", "S_TEXT/SSA"]);

/**
 * @typedef {object} SubtitleTrackPlan
 * @property {number} trackNumber - As the blocks name it.
 * @property {number} declaredIndex - Its position among ALL of the file's
 *   subtitle tracks, picture-based ones included — which is the number ffmpeg
 *   gives the same stream in `0:s:N`, and therefore the only number the browser
 *   ever names. Text tracks alone are not a numbering: a file whose PGS track
 *   comes first would have every text track one lower here than in the browser.
 * @property {string} codecId
 * @property {string} language - The language the file declares: its RFC 5646
 *   tag where it writes one, and the three-letter code otherwise. The
 *   specification requires that order — where `LanguageBCP47` is present, the
 *   `Language` element MUST be ignored.
 * @property {string} languageBcp47 - The RFC 5646 tag alone, or "".
 * @property {string} name - What the file calls the track, if anything.
 * @property {boolean} isDefault
 * @property {boolean} isForced - `FlagForced`: the track carries what a viewer
 *   needs even when they asked for no subtitles — signs, and dialogue in
 *   another language. It does NOT carry the film's own dialogue.
 * @property {boolean} isHearingImpaired - `FlagHearingImpaired`: suitable for
 *   viewers who cannot hear, so it carries non-speech sound as well as speech.
 * @property {string} codecPrivate - The ASS/SSA header, base64, or "".
 * @property {number[]} clusterPositions - File offsets of clusters whose cue
 *   points name this track, ascending. Empty when the file indexes only its
 *   picture, and then the caller has to walk clusters as they arrive instead.
 */

/**
 * Read a string element, trimming the padding some muxers leave.
 *
 * @param {Buffer} buffer
 * @param {{ dataOffset: number, size: number }} element
 * @returns {string}
 */
function readString(buffer, element) {
  return buffer
    .toString("utf8", element.dataOffset, element.dataOffset + element.size)
    .replace(/\0+$/, "");
}

/**
 * Everything about a file's text subtitle tracks that can be learned without
 * reading the film.
 *
 * @param {(start: number, end: number) => Promise<Buffer | null>} readRange
 * @param {number} fileSize
 * @returns {Promise<{ tracks: SubtitleTrackPlan[], declared: object[], secondsPerTick: number, segmentDataOffset: number } | null>}
 */
export async function readSubtitlePlan(readRange, fileSize) {
  const head = await readRange(0, Math.min(HEAD_BYTES, Math.max(0, fileSize - 1)));
  if (!head || head.length < 4 || head.readUInt32BE(0) !== 0x1a45dfa3) {
    return null;
  }
  const segment = findElement(head, ID_SEGMENT, []);
  if (!segment) {
    return null;
  }
  const base = segment.dataOffset;

  const info = findElement(head, ID_INFO, [], base);
  let scale = DEFAULT_TIMESTAMP_SCALE;
  if (info) {
    const declared = findElement(head, ID_TIMESTAMP_SCALE, [], info.dataOffset, info.dataOffset + info.size);
    if (declared) {
      const value = readUint(head, declared.dataOffset, declared.size);
      if (value > 0) {
        scale = value;
      }
    }
  }

  const tracksElement = findElement(head, ID_TRACKS, [], base);
  if (!tracksElement) {
    return null;
  }
  const tracksEnd = Math.min(head.length, tracksElement.dataOffset + tracksElement.size);
  /** @type {SubtitleTrackPlan[]} */
  const tracks = [];
  /**
   * Every subtitle track the file declares, in the order the Tracks element
   * names them, text or picture. This is not for extraction — `tracks` is —
   * but for lining ffmpeg's `0:s:N` numbering up against the container, which
   * only holds while nothing is missing from the middle of the list.
   *
   * @type {Array<{ trackNumber: number, codecId: string, language: string, name: string, isDefault: boolean, declaresDefault: boolean }>}
   */
  const declared = [];
  for (const entry of iterateElements(head, tracksElement.dataOffset, tracksEnd)) {
    if (entry.id !== ID_TRACK_ENTRY) {
      continue;
    }
    const entryEnd = Math.min(tracksEnd, entry.dataOffset + entry.size);
    let trackNumber = null;
    let type = null;
    let codecId = "";
    let language = "";
    let name = "";
    let codecPrivate = "";
    // Matroska's `FlagDefault` DEFAULTS TO 1, so a file whose muxer wrote it on
    // no track is indistinguishable, once the default has been applied, from
    // one that wrote it on every track — which is how ffmpeg's banner prints it
    // and why the banner cannot answer this. Both are kept: what the flag
    // amounts to, and whether the file said anything at all.
    let isDefault = true;
    let declaresDefault = false;
    // Defaults straight from RFC 9559: a track is usable and not forced unless
    // the file says otherwise, and the impaired flags are absent until claimed.
    let isEnabled = true;
    let isForced = false;
    let isHearingImpaired = false;
    let languageBcp47 = "";
    for (const field of iterateElements(head, entry.dataOffset, entryEnd)) {
      if (field.id === ID_TRACK_NUMBER) {
        trackNumber = readUint(head, field.dataOffset, field.size);
      } else if (field.id === ID_TRACK_TYPE) {
        type = readUint(head, field.dataOffset, field.size);
      } else if (field.id === ID_CODEC_ID) {
        codecId = readString(head, field);
      } else if (field.id === ID_LANGUAGE) {
        language = readString(head, field);
      } else if (field.id === ID_LANGUAGE_BCP47) {
        languageBcp47 = readString(head, field);
      } else if (field.id === ID_NAME) {
        name = readString(head, field);
      } else if (field.id === ID_FLAG_DEFAULT) {
        isDefault = readUint(head, field.dataOffset, field.size) === 1;
        declaresDefault = true;
      } else if (field.id === ID_FLAG_ENABLED) {
        // An element written with zero length carries its default, which for
        // this one is 1 — so an empty element must not read as "unusable", and
        // neither must a value outside the declared 0-1 range. Only an explicit
        // zero takes a track away.
        isEnabled = field.size === 0 || readUint(head, field.dataOffset, field.size) !== 0;
      } else if (field.id === ID_FLAG_FORCED) {
        isForced = field.size > 0 && readUint(head, field.dataOffset, field.size) !== 0;
      } else if (field.id === ID_FLAG_HEARING_IMPAIRED) {
        isHearingImpaired = field.size > 0 && readUint(head, field.dataOffset, field.size) !== 0;
      } else if (field.id === ID_CODEC_PRIVATE) {
        codecPrivate = head.toString("base64", field.dataOffset, field.dataOffset + field.size);
      }
    }
    if (type !== TRACK_TYPE_SUBTITLE || trackNumber === null) {
      continue;
    }
    // A track the file marks unusable is still COUNTED. FlagEnabled says "the
    // track is usable", and a player should not offer it — but ffmpeg does not
    // drop it: `matroskadec.c` parses `MATROSKA_ID_TRACKFLAGENABLED` as
    // `EBML_NONE`, reading the element and keeping nothing, so the stream is
    // created and numbered like any other. Leaving it out of this list would
    // therefore shift `declaredIndex` off ffmpeg's `0:s:N` for every track
    // after it, which is the numbering defect this file was fixed for a day
    // earlier. It is counted here and refused where it is offered instead.
    //
    // `language` here stays the three-letter code, because this list exists to
    // be lined up against ffmpeg's banner, which prints that code. The RFC 5646
    // tag rides beside it for whoever displays the track.
    declared.push({
      trackNumber,
      codecId,
      language,
      languageBcp47,
      name,
      isDefault,
      declaresDefault,
      isEnabled,
      isForced,
      isHearingImpaired
    });
    if (!TEXT_CODECS.has(codecId) || !isEnabled) {
      continue;
    }
    tracks.push({
      trackNumber,
      declaredIndex: declared.length - 1,
      codecId,
      // This list is ours and is not compared with ffmpeg's, so it carries the
      // language the file states most precisely: where RFC 5646 is written, the
      // three-letter code MUST be ignored.
      language: languageBcp47 || language,
      languageBcp47,
      name,
      isDefault,
      isForced,
      isHearingImpaired,
      codecPrivate,
      clusterPositions: []
    });
  }
  if (tracks.length === 0) {
    return { tracks, declared, secondsPerTick: scale / 1e9, segmentDataOffset: base };
  }

  // Where the clusters holding those tracks are. A file that indexes only its
  // picture leaves these empty, which is not a failure: the caller then reads
  // the clusters the viewer's own playback brings in.
  const seekHead = findElement(head, ID_SEEK_HEAD, [], base);
  let cuesRelative;
  if (seekHead) {
    const seekEnd = Math.min(head.length, seekHead.dataOffset + seekHead.size);
    for (const seek of iterateElements(head, seekHead.dataOffset, seekEnd)) {
      if (seek.id !== ID_SEEK) {
        continue;
      }
      let target = null;
      let position = null;
      for (const field of iterateElements(head, seek.dataOffset, Math.min(seekEnd, seek.dataOffset + seek.size))) {
        if (field.id === ID_SEEK_ID) {
          target = readUint(head, field.dataOffset, field.size);
        } else if (field.id === ID_SEEK_POSITION) {
          position = readUint(head, field.dataOffset, field.size);
        }
      }
      if (target === ID_CUES && position !== null) {
        cuesRelative = position;
      }
    }
  }
  if (cuesRelative !== undefined) {
    const cuesAt = base + cuesRelative;
    if (cuesAt > 0 && cuesAt < fileSize) {
      const chunk = await readRange(cuesAt, Math.min(fileSize - 1, cuesAt + MAX_CUES_BYTES));
      const element = chunk && [...iterateElements(chunk, 0, chunk.length)][0];
      if (element && element.id === ID_CUES) {
        const body = chunk.subarray(element.dataOffset, Math.min(chunk.length, element.dataOffset + element.size));
        const byTrack = new Map(tracks.map((track) => [track.trackNumber, new Set()]));
        for (const point of iterateElements(body, 0, body.length)) {
          if (point.id !== ID_CUE_POINT) {
            continue;
          }
          const pointEnd = Math.min(body.length, point.dataOffset + point.size);
          for (const field of iterateElements(body, point.dataOffset, pointEnd)) {
            if (field.id !== ID_CUE_TRACK_POSITIONS) {
              continue;
            }
            let cueTrack = null;
            let position = null;
            for (const inner of iterateElements(body, field.dataOffset, Math.min(pointEnd, field.dataOffset + field.size))) {
              if (inner.id === ID_CUE_TRACK) {
                cueTrack = readUint(body, inner.dataOffset, inner.size);
              } else if (inner.id === ID_CUE_CLUSTER_POSITION) {
                position = readUint(body, inner.dataOffset, inner.size);
              }
            }
            if (position !== null && byTrack.has(cueTrack)) {
              byTrack.get(cueTrack).add(base + position);
            }
          }
        }
        for (const track of tracks) {
          track.clusterPositions = [...byTrack.get(track.trackNumber)].sort((left, right) => left - right);
        }
      }
    }
  }
  return { tracks, declared, secondsPerTick: scale / 1e9, segmentDataOffset: base };
}

/**
 * The cues of one track inside one cluster.
 *
 * @param {Buffer} bytes - The cluster, from its own element header onward.
 * @param {number} trackNumber
 * @param {number} secondsPerTick
 * @returns {{ startSeconds: number, endSeconds: number | null, text: string }[]}
 */
export function harvestCluster(bytes, trackNumber, secondsPerTick) {
  const header = [...iterateElements(bytes, 0, bytes.length)][0];
  if (!header) {
    return [];
  }
  const blocks = blocksOfTrack(
    bytes,
    { dataOffset: header.dataOffset, size: header.size },
    trackNumber,
    secondsPerTick
  );
  return blocks.map((block) => ({
    startSeconds: block.startSeconds,
    endSeconds: block.durationSeconds === null ? null : block.startSeconds + block.durationSeconds,
    text: block.payload.toString("utf8")
  }));
}
