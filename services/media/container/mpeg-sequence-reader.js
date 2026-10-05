import { mpegVideoConfiguration } from "./mpeg-video-configuration.js";

/** Retain sequence declarations only; preceding user data is not decoder configuration. */
export class MpegSequenceReader {
  #codec;
  #zeros = 0;
  #code = null;
  #expectCode = false;
  #unit = [];
  #sequence = null;
  #facts = null;

  constructor(codec) { this.#codec = codec; }

  push(bytes) {
    for (const byte of bytes) {
      if (this.#expectCode) {
        this.#expectCode = false;
        this.#code = byte;
        this.#unit = [0, 0, 1, byte];
        if (byte === 0xb3) this.#facts = null;
        continue;
      }
      if (byte === 0) { this.#zeros++; continue; }
      if (byte === 1 && this.#zeros >= 2) {
        this.#appendZeros(this.#zeros - 2);
        this.#finishUnit();
        this.#zeros = 0;
        this.#expectCode = true;
        continue;
      }
      this.#appendZeros(this.#zeros);
      this.#zeros = 0;
      this.#append(byte);
      this.#update();
    }
    return this.#facts;
  }

  #appendZeros(count) {
    const remaining = this.#limit() - this.#unit.length;
    for (let at = 0; at < Math.min(count, remaining); at++) this.#unit.push(0);
    this.#update();
  }

  #limit() { return this.#code === 0xb3 ? 140 : this.#code === 0xb5 ? 10 : 0; }
  #append(byte) { if (this.#unit.length < this.#limit()) this.#unit.push(byte); }

  #finishUnit() {
    if (this.#code === 0xb3) {
      this.#sequence = Buffer.from(this.#unit);
      this.#update();
    }
    if (this.#code === 0xb5) this.#update();
  }

  #update() {
    const sequence = this.#code === 0xb3 ? Buffer.from(this.#unit) : this.#sequence;
    if (!sequence) return;
    const extension = this.#code === 0xb5 && this.#unit[4] >> 4 === 1 ? Buffer.from(this.#unit) : null;
    if (this.#codec === "mpeg2video" && !extension) return;
    try {
      const facts = mpegVideoConfiguration(extension ? Buffer.concat([sequence, extension]) : sequence);
      if (facts && (this.#codec !== "mpeg2video" || facts.codecId === "mpeg2video")) this.#facts = facts;
    } catch (error) {
      if (!error.message.includes("truncated")) throw error;
    }
  }
}
