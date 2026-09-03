/**
 * @file AVI container — RIFF.
 *
 * Minimal: only keyframe index via idx1 (AVIIF_KEYFRAME). Tracks are not
 * used by current product beyond video — expose a single VideoTrack if needed.
 * Spec: RIFF AVI, idx1 chunk at file end, OpenDML may lack idx1 → no index.
 */

import { Container } from "./Container.js";
import { isAvi, readAviKeyframeTimes } from "../container-index/avi.js";
import { VideoTrack } from "../tracks/VideoTrack.js";

export class AviContainer extends Container {
  get formatName() {
    return "avi";
  }

  static detect(head) {
    return isAvi(head);
  }

  async readTracks() {
    const head = await this.readRange(0, Math.min(4095, this.fileSize - 1));
    if (!head || !isAvi(head)) return [];
    // AVI track table is minimal — expose one video track for uniformity.
    return [new VideoTrack({
      trackNumber: 1,
      declaredIndex: 0,
      codecId: "",
      language: "",
      languageBcp47: "",
      name: "",
      isEnabled: true,
      isDefault: true,
      declaresDefault: false
    })];
  }

  /**
   * Duration from the main AVI header, per the RIFF AVI specification: the
   * header states microseconds per frame and the total number of frames, and
   * their product is the length.
   *
   * An AVI has no edit list and no timeline offset of any kind, so its start is
   * zero — a declaration of the format itself, not an absence.
   *
   * @returns {Promise<import("./Container.js").ContainerMediaInfo>}
   */
  async readMediaInfo() {
    if (this.mediaInfo) {
      return this.mediaInfo;
    }
    /** @type {import("./Container.js").ContainerMediaInfo} */
    const info = { format: this.formatName, durationSeconds: null, startTimeSeconds: 0 };
    this.mediaInfo = info;
    const head = await this.readRange(0, Math.min(4095, this.fileSize - 1));
    if (!head || !isAvi(head)) {
      return info;
    }
    // RIFF("AVI ") -> LIST("hdrl") -> avih. The avih chunk's payload begins with
    // dwMicroSecPerFrame and its fifth field is dwTotalFrames.
    const at = head.indexOf("avih", 0, "latin1");
    if (at < 0 || at + 8 + 20 > head.length) {
      return info;
    }
    const payload = at + 8;
    const microsecondsPerFrame = head.readUInt32LE(payload);
    const totalFrames = head.readUInt32LE(payload + 16);
    if (microsecondsPerFrame > 0 && totalFrames > 0) {
      info.durationSeconds = (microsecondsPerFrame * totalFrames) / 1e6;
    }
    return info;
  }

  async readKeyframeIndex() {
    const r = await readAviKeyframeTimes(this.readRange, this.fileSize);
    if (!r) return null;
    if (Array.isArray(r)) return { times: r, tolerance: 0 };
    return r;
  }
}
