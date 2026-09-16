/**
 * @file Progress reported by one encoder run, placed on the source timeline.
 *
 * ffmpeg reports time relative to the start of each run on both the re-encode
 * and copy branches. `-output_ts_offset` and `-copyts` change muxed timestamps,
 * not the `-progress` clock. Every reading is therefore rebased by this run's
 * own start, never by an output-wide value shared with another run.
 */

function parseTimestamp(value) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const parts = value.split(":");
  if (parts.length !== 3) {
    return null;
  }
  const [hours, minutes, seconds] = parts.map(Number);
  return [hours, minutes, seconds].every(Number.isFinite)
    ? hours * 3600 + minutes * 60 + seconds
    : null;
}

export class RunProgress {
  constructor({ startSeconds = 0, totalSeconds = null, now = Date.now } = {}) {
    this.startPositionSeconds = Number.isFinite(startSeconds) ? Math.max(0, startSeconds) : 0;
    this.processedSeconds = this.startPositionSeconds;
    this.totalSeconds = Number.isFinite(totalSeconds) && totalSeconds > 0 ? totalSeconds : null;
    this.percent = null;
    this.remainingSeconds = this.totalSeconds;
    this.speed = "";
    this.updatedAt = now();
    this.lastLoggedAt = 0;
    this.now = now;
    this.#derive();
  }

  note({ processedSeconds = null, outTime, speed = null }) {
    const relative = Number.isFinite(processedSeconds)
      ? processedSeconds
      : parseTimestamp(outTime);
    if (relative !== null) {
      this.processedSeconds = this.startPositionSeconds + Math.max(0, relative);
    }
    if (typeof speed === "string") {
      this.speed = speed;
    }
    this.updatedAt = this.now();
    this.#derive();
    return this.snapshot();
  }

  shouldLog(everyMs) {
    if (this.percent === null || this.updatedAt - this.lastLoggedAt < everyMs) {
      return false;
    }
    this.lastLoggedAt = this.updatedAt;
    return true;
  }

  snapshot() {
    return {
      processedSeconds: this.processedSeconds,
      startPositionSeconds: this.startPositionSeconds,
      totalSeconds: this.totalSeconds,
      percent: this.percent,
      remainingSeconds: this.remainingSeconds,
      speed: this.speed,
      updatedAt: this.updatedAt
    };
  }

  #derive() {
    if (this.totalSeconds === null) {
      this.percent = null;
      this.remainingSeconds = null;
      return;
    }
    const span = Math.max(1, this.totalSeconds - this.startPositionSeconds);
    const processed = Math.max(0, this.processedSeconds - this.startPositionSeconds);
    this.percent = Math.max(0, Math.min(100, (processed / span) * 100));
    this.remainingSeconds = Math.max(0, this.totalSeconds - this.processedSeconds);
  }
}
