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

  async readKeyframeIndex() {
    const r = await readAviKeyframeTimes(this.readRange, this.fileSize);
    if (!r) return null;
    if (Array.isArray(r)) return { times: r, tolerance: 0 };
    return r;
  }
}
