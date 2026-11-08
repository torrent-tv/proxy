/**
 * @file How this proxy reads the bits of a video or audio elementary stream:
 * one bounded MSB-first reader, one emulation-prevention rule, one AAC
 * sampling-frequency table and one AudioSpecificConfig parser. Every parser of
 * a bitstream (AVC, HEVC, MPEG video, DTS, AC-3, AAC/LATM) reads through this
 * file, so a stream is refused or accepted the same way wherever it is read.
 */

/** ISO/IEC 14496-3 Table 1.18: samplingFrequencyIndex to Hz. 0xF is an explicit 24-bit rate. */
export const AAC_SAMPLE_RATES = Object.freeze([96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]);

/** ISO/IEC 14496-3 Table 1.19: channelConfiguration to channels; 0 is a program configuration element. */
const AAC_CHANNELS = Object.freeze([null, 1, 2, 3, 4, 5, 6, 8]);

/** A bounded MSB-first bit reader. A read past the end throws under `label`. */
export class Bits {
  at = 0;

  /**
   * @param {Buffer | Uint8Array} bytes
   * @param {string} label - Names what is read in every error ("HEVC SPS" gives "HEVC SPS bits are truncated.").
   */
  constructor(bytes, label) {
    this.bytes = bytes;
    this.label = label;
  }

  /** @param {number} count - 0 to 32 bits. @returns {number} the unsigned value */
  uint(count) {
    if (!(count >= 0 && count <= 32) || this.at + count > this.bytes.length * 8) throw new Error(`${this.label} bits are truncated.`);
    let value = 0;
    for (let index = 0; index < count; index++, this.at++) value = value * 2 + ((this.bytes[this.at >> 3] >> (7 - (this.at & 7))) & 1);
    return value;
  }

  /** @param {number} count - Any number of bits to pass over. */
  skip(count) {
    if (!(count >= 0) || this.at + count > this.bytes.length * 8) throw new Error(`${this.label} bits are truncated.`);
    this.at += count;
  }

  /** @returns {number} an unsigned Exp-Golomb value */
  ue() {
    let zeroes = 0;
    while (!this.uint(1)) if (++zeroes > 31) throw new Error(`${this.label} Exp-Golomb value is invalid.`);
    return 2 ** zeroes - 1 + this.uint(zeroes);
  }

  /** @returns {number} a signed Exp-Golomb value */
  se() {
    const code = this.ue();
    return code & 1 ? (code + 1) / 2 : -code / 2;
  }

  /**
   * The bits from `from` to `to` as bytes, MSB first and zero padded; the read position is left where it was.
   * @returns {Buffer}
   */
  copy(from, to) {
    const reader = new Bits(this.bytes, this.label);
    reader.skip(from);
    const bytes = Buffer.alloc(Math.ceil((to - from) / 8));
    for (let done = 0; done < to - from; done += 8) {
      const width = Math.min(8, to - from - done);
      bytes[done >> 3] = reader.uint(width) << (8 - width);
    }
    return bytes;
  }
}

/**
 * The emulation-prevention rule, one byte at a time: a 0x03 after two zero bytes is dropped whatever follows
 * it. H.264 §7.4.1 forbids 0x000003 before a byte above 0x03, but encoders write it (LostFilm's LostCoder)
 * and decoders drop it (ffmpeg's ff_h2645_extract_rbsp), so refusing it refuses files every player plays.
 */
export class EmulationPrevention {
  #zeroes = 0;

  /** @param {number} byte @returns {boolean} whether the byte belongs to the RBSP (false: it is the 0x03 to drop) */
  keeps(byte) {
    if (this.#zeroes >= 2 && byte === 3) {
      this.#zeroes = 0;
      return false;
    }
    this.#zeroes = byte === 0 ? this.#zeroes + 1 : 0;
    return true;
  }
}

/**
 * The raw byte sequence payload of a NAL unit: emulation prevention bytes removed, never throws.
 * @param {Buffer} nal
 * @param {number} start - Where the payload begins: 1 after an AVC header, 2 after an HEVC header.
 * @returns {Buffer} a new buffer; `nal` is left alone
 */
export function rbsp(nal, start) {
  const bytes = Buffer.allocUnsafe(Math.max(0, nal.length - start));
  const rule = new EmulationPrevention();
  let length = 0;
  for (let at = start; at < nal.length; at++) if (rule.keeps(nal[at])) bytes[length++] = nal[at];
  return bytes.subarray(0, length);
}

/**
 * Read an AudioSpecificConfig (ISO/IEC 14496-3 §1.6.2.1) from the current position, as the one reading of it:
 * explicit SBR and parametric stereo, and the program configuration element of channelConfiguration 0.
 * Given a `Bits` it reads from where that stands, as a LATM stream does, and truncation throws under its label.
 * Given bytes it answers null when they are no readable configuration.
 *
 * `objectType` is the type as first declared (5 SBR, 29 PS, else the codec's own) and `audioObjectType` the
 * codec underneath; `sampleRate` is the output rate and `coreSampleRate` the one a frame lasts by. A
 * configuration this proxy cannot describe (a codec other than AAC Main/LC/SSR/LTP, no rate, a channel
 * configuration above 7) answers `supported: false` with only what was read before it was told so.
 *
 * @param {Bits | Buffer} source
 * @returns {null | { supported: boolean, objectType: number, audioObjectType: number, sampleRate: number | undefined,
 *   coreSampleRate: number | undefined, channelConfiguration: number, channels: number | null,
 *   frameLength: number | null, extensionVersion: number }}
 */
export function parseAudioSpecificConfig(source) {
  if (source instanceof Bits) return readConfig(source);
  if (!Buffer.isBuffer(source) || source.length < 2) return null;
  try { return readConfig(new Bits(source, "AudioSpecificConfig")); }
  catch { return null; }
}

function readConfig(bits) {
  const start = bits.at;
  const objectType = audioObjectType(bits);
  let type = objectType;
  const coreSampleRate = audioRate(bits);
  const channelConfiguration = bits.uint(4);
  let sampleRate = coreSampleRate;
  if (type === 5 || type === 29) {
    sampleRate = audioRate(bits);
    type = audioObjectType(bits);
  }
  const result = { supported: false, objectType, audioObjectType: type, sampleRate, coreSampleRate, channelConfiguration,
    channels: AAC_CHANNELS[channelConfiguration] ?? null, frameLength: null, extensionVersion: 0 };
  if (![1, 2, 3, 4].includes(type) || !(coreSampleRate > 0) || !(sampleRate > 0) || channelConfiguration > 7) return result;
  const shortFrame = bits.uint(1);
  if (bits.uint(1)) bits.uint(14);
  const extension = bits.uint(1);
  const channels = channelConfiguration ? result.channels : programChannels(bits, start, coreSampleRate);
  if (extension) result.extensionVersion = bits.uint(1);
  return { ...result, supported: true, frameLength: shortFrame ? 960 : 1024,
    channels: objectType === 29 && channels === 1 ? 2 : channels };
}

function audioObjectType(bits) {
  const type = bits.uint(5);
  return type === 31 ? 32 + bits.uint(6) : type;
}

function audioRate(bits) {
  const index = bits.uint(4);
  return index === 15 ? bits.uint(24) : AAC_SAMPLE_RATES[index];
}

/** The program configuration element declares every single, paired and LFE channel. */
function programChannels(bits, start, sampleRate) {
  bits.skip(6);
  if (AAC_SAMPLE_RATES[bits.uint(4)] !== sampleRate) throw new Error("AAC program sample rate differs from its decoder declaration.");
  const front = bits.uint(4), side = bits.uint(4), back = bits.uint(4), lfe = bits.uint(2),
    associated = bits.uint(3), coupled = bits.uint(4);
  if (bits.uint(1)) bits.skip(4);
  if (bits.uint(1)) bits.skip(4);
  if (bits.uint(1)) bits.skip(3);
  let channels = lfe;
  for (let index = 0; index < front + side + back; index++) {
    channels += bits.uint(1) ? 2 : 1;
    bits.skip(4);
  }
  bits.skip(4 * (lfe + associated));
  bits.skip(5 * coupled);
  bits.skip((8 - ((bits.at - start) % 8)) % 8);
  bits.skip(bits.uint(8) * 8);
  if (!channels) throw new Error("AAC program declares no output channels.");
  return channels;
}
