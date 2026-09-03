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
   * @param {{ width: number, height: number, manual: boolean } | null} params.encode
   *   Null when the picture is copied — then the output is the source's own
   *   size and nothing about a target box can change it. The box when it is
   *   re-encoded, with `manual` saying the viewer forced it and the realtime
   *   budget must not move it.
   */
  constructor({ fileIndex, encode = null }) {
    this.fileIndex = Number.isInteger(fileIndex) && fileIndex >= 0 ? fileIndex : 0;
    this.encode = encode
      ? {
          width: Number.isInteger(encode.width) && encode.width > 0 ? encode.width : 0,
          height: Number.isInteger(encode.height) && encode.height > 0 ? encode.height : 0,
          manual: encode.manual === true
        }
      : null;
  }

  /**
   * @returns {string}
   */
  toKey() {
    if (!this.encode) {
      return `v=${this.fileIndex}/copy`;
    }
    const box = `${this.encode.width}x${this.encode.height}`;
    return `v=${this.fileIndex}/enc:${box}:${this.encode.manual ? "manual" : "auto"}`;
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
 * One encode of one torrent's material: which tracks, in what form, cut how,
 * packaged how.
 */
export class OutputSpec {
  /**
   * @param {object} params
   * @param {string} params.sourceKey - `torrent:<infohash>`, the canonical
   *   identity of the torrent itself: a magnet and a `.torrent` file for the
   *   same content produce the same one (`torrent-source-key.js`). Nothing
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
}
