import { createHash } from "node:crypto";

/**
 * @file What a session PRODUCES, stated once and used as its identity.
 *
 * Three domain axes already have a home in this package: what a file states
 * about itself (`container/`), what a track states about itself (`tracks/`),
 * and what anybody wants off the swarm (`demand/`). This is the fourth — what
 * we make out of them — and it had no home at all: the identity of a session
 * was a `[...].join(":")` inside a 300-line function, with no name, no test and
 * nothing printing it.
 *
 * The rule it exists to express, stated by the user 2026-09-03:
 *
 * > A session belongs to the tracks its output actually carries. Its key holds
 * > those tracks' parameters and nothing else. Two sessions whose parameters
 * > agree ARE the same session, and the encoded result is reused by definition.
 *
 * So reuse between viewers is not a feature built on top of this — it is what a
 * correctly built key already means. A field of the REQUEST that does not
 * change one byte of the output must not appear here; measured 2026-09-03, two
 * viewers of one copied picture got two sessions whose output was identical
 * byte for byte (`research/two-viewers-one-file-2026-09-03.md`).
 *
 * What deliberately does NOT appear:
 *
 * 1. the viewer, in any form. Not the consumer id, not where they started, not
 *    their viewport. A viewer is not a property of the material;
 * 2. the bitrate ceiling the viewer's measured link puts on a re-encode. It is
 *    a runtime parameter of a SHARED session — the worst link among the live
 *    consumers decides — so two viewers on one encode is the design, not a
 *    collision. Rate control appears in neither the SPS nor the PPS, which is
 *    why it can move under a player that has already cached the init;
 * 3. the video track number. Only `0:v:0` is ever mapped, so the file names the
 *    picture. Add it here the day a second video track can be chosen.
 *
 * A limit worth stating: two specs that agree name interchangeable output
 * within ONE proxy. A copied picture's bytes depend only on the source, but a
 * re-encoded one's depend on this host's encoder, its preset and its rate cap —
 * so this is not enough to reuse segments BETWEEN proxies (roadmap item 41).
 */

/**
 * The picture an output carries.
 */
export class VideoOutput {
  /**
   * @param {object} params
   * @param {number} params.fileIndex - The file the picture is read from.
   * @param {{ encoder: string, width: number, height: number, fps: number, preset: string | null, tonemap: boolean } | null} params.encode
   *   Null when the picture is copied — then the output is the source's own
   *   picture and nothing asked for can change a byte of it. When it is
   *   re-encoded, the FORMAT that is actually produced: which encoder, the
   *   size, the frame rate, the speed setting and whether HDR is tone mapped
   *   down. Each of those changes what a decoder must be told in the header,
   *   so pieces that differ in any of them cannot share one init segment.
   *
   *   What was ASKED for is not here. The key used to carry the viewer's box
   *   and whether it was to be produced exactly, while the budget chose the
   *   real size afterwards — so one address could name two formats, and pieces
   *   of both would be served under the header of one (decided with the user
   *   2026-09-16).
   */
  constructor({ fileIndex, encode = null }) {
    this.fileIndex = Number.isInteger(fileIndex) && fileIndex >= 0 ? fileIndex : 0;
    this.encode = encode
      ? {
          encoder: typeof encode.encoder === "string" && encode.encoder.length > 0 ? encode.encoder : "unknown",
          width: Number.isInteger(encode.width) && encode.width > 0 ? encode.width : 0,
          height: Number.isInteger(encode.height) && encode.height > 0 ? encode.height : 0,
          fps: Number.isFinite(encode.fps) && encode.fps > 0 ? encode.fps : 0,
          preset: typeof encode.preset === "string" && encode.preset.length > 0 ? encode.preset : null,
          tonemap: encode.tonemap === true
        }
      : null;
  }

  /**
   * How many points of picture this output carries, or zero for a copy, which
   * is the source's own size and is compared by the caller that knows it.
   *
   * @returns {number}
   */
  get area() {
    return this.encode ? this.encode.width * this.encode.height : 0;
  }

  /**
   * @returns {string}
   */
  toKey() {
    if (!this.encode) {
      return `v=${this.fileIndex}/copy`;
    }
    const { encoder, width, height, fps, preset, tonemap } = this.encode;
    return `v=${this.fileIndex}/enc/${encoder}/${width}x${height}@${fps}/${preset ?? "-"}/${tonemap ? "tonemap" : "none"}`;
  }
}

/**
 * The soundtrack an output carries.
 */
export class AudioOutput {
  /**
   * @param {object} params
   * @param {number} params.fileIndex - The file the TRACK lives in, which for a
   *   dub shipped beside the picture is not the picture's file.
   * @param {number} params.trackIndex - `0:a:N` inside that file. The flat
   *   number the browser sends spans the picture's own tracks and the files
   *   beside it, and two flat numbers of two different pictures can name one
   *   track; this is the number that cannot.
   * @param {boolean} params.transcode - Re-encoded to AAC, or copied.
   */
  constructor({ fileIndex, trackIndex, transcode }) {
    this.fileIndex = Number.isInteger(fileIndex) && fileIndex >= 0 ? fileIndex : 0;
    this.trackIndex = Number.isInteger(trackIndex) && trackIndex >= 0 ? trackIndex : 0;
    this.transcode = transcode === true;
  }

  /**
   * @returns {string}
   */
  toKey() {
    return `a=${this.fileIndex}/${this.trackIndex}/${this.transcode ? "aac" : "copy"}`;
  }
}

/**
 * Where an output is cut.
 *
 * Both forms belong to a FILE and not to the session: the keyframe grid is that
 * file's own keyframe times, and the uniform grid is derived from that file's
 * duration. A soundtrack takes the grid of the picture it accompanies, so its
 * grid names the picture's file — which is what makes two soundtrack sessions
 * cut for two different pictures tell themselves apart.
 */
export class CutGrid {
  /**
   * @param {object} params
   * @param {"keyframe" | "uniform"} params.kind
   * @param {number} params.fileIndex - Whose keyframes, or whose duration.
   */
  constructor({ kind, fileIndex }) {
    this.kind = kind === "keyframe" ? "keyframe" : "uniform";
    this.fileIndex = Number.isInteger(fileIndex) && fileIndex >= 0 ? fileIndex : 0;
  }

  /**
   * @returns {string}
   */
  toKey() {
    return `grid=${this.kind === "keyframe" ? "kf" : "even"}@${this.fileIndex}`;
  }
}

/**
 * The shape `OutputSpec.toKey` writes, read back part by part.
 */
const KEY_PATTERN =
  /^(?<source>.+):fmt=(?<format>[a-z0-9]+):grid=(?<grid>kf|even)@(?<gridFile>\d+):(?<carries>video-only|audio-only|muxed)(?::v=(?<videoFile>\d+)\/(?<video>copy|enc\/(?<encoder>[^/:]+)\/(?<width>\d+)x(?<height>\d+)@(?<fps>[0-9.]+)\/(?<preset>[^/:]+)\/(?<tonemap>tonemap|none)))?(?::a=(?<audioFile>\d+)\/(?<audioTrack>\d+)\/(?<audioCodec>aac|copy))?$/;

/**
 * One encode of one torrent's material: which tracks, in what form, cut how,
 * packaged how.
 */
export class OutputSpec {
  /**
   * @param {object} params
   * @param {string} params.sourceKey - `torrent:<infohash>`, the canonical
   *   identity of the torrent itself: a magnet and a `.torrent` file for the
   *   same content produce the same one (`torrent/torrent-source-key.js`). Nothing
   *   further is needed to say WHICH film this is.
   * @param {string} params.segmentFormatId - fMP4 or MPEG-TS. Two viewers
   *   asking for different containers cannot share one ffmpeg.
   * @param {CutGrid} params.grid
   * @param {VideoOutput | null} params.video
   * @param {AudioOutput | null} params.audio
   */
  constructor({ sourceKey, segmentFormatId, grid, video = null, audio = null }) {
    this.sourceKey = String(sourceKey ?? "");
    this.segmentFormatId = String(segmentFormatId ?? "");
    this.grid = grid;
    this.video = video;
    this.audio = audio;
  }

  /**
   * What this output carries, in the vocabulary the rest of the class uses.
   *
   * `muxed` is the one case where a session legitimately holds the parameters
   * of two tracks: a browser that does not understand rendition groups must be
   * sent its sound inside the picture's own stream.
   *
   * @returns {"video-only" | "audio-only" | "muxed" | "empty"}
   */
  get carries() {
    if (this.video && this.audio) {
      return "muxed";
    }
    if (this.video) {
      return "video-only";
    }
    if (this.audio) {
      return "audio-only";
    }
    return "empty";
  }

  /** @returns {boolean} */
  get transcodesVideo() {
    return this.video?.encode !== null && this.video?.encode !== undefined;
  }

  /** @returns {boolean} */
  get transcodesAudio() {
    return this.audio?.transcode === true;
  }

  /** @returns {boolean} */
  get carriesAudioSeparately() {
    return this.carries === "video-only";
  }

  /** @returns {number} */
  get audioFileIndex() {
    return this.audio?.fileIndex ?? -1;
  }

  /** @returns {number} */
  get audioSourceTrackIndex() {
    return this.audio?.trackIndex ?? 0;
  }

  /**
   * The identity. Two outputs with the same one are the same output.
   *
   * @returns {string}
   */
  toKey() {
    const parts = [this.sourceKey, `fmt=${this.segmentFormatId}`, this.grid.toKey(), this.carries];
    if (this.video) {
      parts.push(this.video.toKey());
    }
    if (this.audio) {
      parts.push(this.audio.toKey());
    }
    return parts.join(":");
  }

  /**
   * The identity read back from its own key, or null for a key this version
   * does not write.
   *
   * A directory of produced pieces names its output by the key it was made
   * under, and that is the only record of what format lies inside it. A key in
   * an older shape — one that named the box a viewer ASKED for rather than the
   * format produced — cannot say that, so it answers null and the directory is
   * not served.
   *
   * @param {string} key
   * @returns {OutputSpec | null}
   */
  static fromKey(key) {
    const match = KEY_PATTERN.exec(String(key ?? ""));
    if (!match) {
      return null;
    }
    const groups = match.groups;
    const video = groups.video === undefined
      ? null
      : new VideoOutput({
          fileIndex: Number(groups.videoFile),
          encode: groups.video === "copy"
            ? null
            : {
                encoder: groups.encoder,
                width: Number(groups.width),
                height: Number(groups.height),
                fps: Number(groups.fps),
                preset: groups.preset === "-" ? null : groups.preset,
                tonemap: groups.tonemap === "tonemap"
              }
        });
    const audio = groups.audioFile === undefined
      ? null
      : new AudioOutput({
          fileIndex: Number(groups.audioFile),
          trackIndex: Number(groups.audioTrack),
          transcode: groups.audioCodec === "aac"
        });
    const spec = new OutputSpec({
      sourceKey: groups.source,
      segmentFormatId: groups.format,
      grid: new CutGrid({ kind: groups.grid === "kf" ? "keyframe" : "uniform", fileIndex: Number(groups.gridFile) }),
      video,
      audio
    });
    // Read back exactly or not at all: a key that parses into something that
    // writes a different key is not a key this version made.
    return spec.toKey() === key ? spec : null;
  }

  /**
   * The name anybody outside this layer addresses the output by.
   *
   * A function of the identity above and of nothing else, so two requests that
   * would produce the same bytes get the same name however far apart they
   * arrive, and MANY VIEWERS OF ONE OUTPUT address one name by construction
   * rather than because somebody arranged it.
   *
   * It used to be a fresh `randomUUID()` minted per session. That was a second
   * name for a thing that already had one — a session is found by `toKey()`, so
   * there is exactly one per output — and it said nothing the key did not. What
   * it did do was hide the output's identity from everything outside: two lives
   * of one output looked like two unrelated things, and no log could be
   * followed across a restart.
   *
   * SHORT AND OPAQUE, so that whoever carries it can carry it whole: the key
   * itself is a sentence with punctuation in it, and every carrier would have
   * to agree on how to escape that. Sixteen characters of SHA-256 is about one
   * chance in ten thousand of two outputs colliding after four billion of them,
   * which is far beyond what one proxy produces.
   *
   * Nothing outside takes it apart, so its shape is ours: it is compared whole,
   * and shortened only for a log line.
   *
   * @returns {string}
   */
  toName() {
    return createHash("sha256").update(this.toKey()).digest("hex").slice(0, 16);
  }
}

/**
 * Whether a string is a name this proxy minted.
 *
 * Here, beside the minting, because it is the same fact read backwards, and a
 * fact stated in two places is one that can disagree with itself. It did, the
 * day the name stopped being a uuid: the shape changed here while the guard
 * elsewhere still demanded 36 characters of hex and dashes, and every route
 * behind that guard would have refused every request.
 *
 * It is a guard and not only a test of form: a name reaching the filesystem
 * must not be able to carry a `/` or a `.`.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isOutputName(value) {
  return typeof value === "string" && /^[a-f0-9]{16}$/.test(value);
}
