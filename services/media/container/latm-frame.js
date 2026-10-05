import { Bits } from "./h264-configuration.js";

const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** LOAS frames retain their original addresses; payload bit positions describe raw AAC. */
export class LatmFrames {
  #configuration = null;

  read(bytes) {
    if (bytes.length < 3 || bytes[0] !== 0x56 || (bytes[1] & 0xe0) !== 0xe0) throw new Error("AAC LOAS synchronization is invalid.");
    const size = 3 + ((bytes[1] & 31) << 8) + bytes[2];
    if (bytes.length < size) return { size };
    const bits = new Bits(bytes.subarray(3, size), "AAC LATM");
    if (!bits.uint(1)) {
      const version = bits.uint(1), versionA = version ? bits.uint(1) : 0;
      if (versionA) throw new Error("AAC LATM version A requires its own payload declarations.");
      if (version) latmValue(bits);
      const sameTime = bits.uint(1), subframes = bits.uint(6), programs = bits.uint(4), layers = bits.uint(3);
      if (!sameTime || subframes || programs || layers) throw new Error("AAC LATM multiplexed layers require separate packet declarations.");
      const ascLength = version ? latmValue(bits) : null, ascStart = bits.at;
      const configuration = readAudioConfiguration(bits);
      let ascEnd = bits.at;
      if (ascLength !== null) {
        if (ascEnd - ascStart > ascLength) throw new Error("AAC LATM decoder configuration exceeds its bit length.");
        skip(bits, ascLength - (ascEnd - ascStart));
        ascEnd = bits.at;
      }
      const lengthType = bits.uint(3);
      if (lengthType !== 0) throw new Error("AAC LATM fixed or CELP frame length requires its own payload declarations.");
      bits.uint(8);
      if (bits.uint(1)) {
        if (version) latmValue(bits);
        else {
          let more;
          do { more = bits.uint(1); bits.uint(8); } while (more);
        }
      }
      if (bits.uint(1)) bits.uint(8);
      const privateBytes = Buffer.alloc(Math.ceil((ascEnd - ascStart) / 8));
      for (let bit = ascStart; bit < ascEnd; bit++) {
        const value = (bits.bytes[bit >> 3] >> (7 - (bit & 7))) & 1;
        privateBytes[(bit - ascStart) >> 3] |= value << (7 - ((bit - ascStart) & 7));
      }
      this.#configuration = { ...configuration, codecPrivateB64: privateBytes.toString("base64") };
    }
    if (!this.#configuration) throw new Error("AAC LATM payload precedes its stream configuration.");
    let length = 0, part;
    do { part = bits.uint(8); length += part; } while (part === 255);
    if (!(length > 0) || bits.at + length * 8 > bits.bytes.length * 8) throw new Error("AAC LATM payload exceeds its LOAS frame.");
    return { size, ...this.#configuration, codecId: "aac", bitOffset: bits.at + 24, bitLength: length * 8 };
  }
}

function readAudioConfiguration(bits) {
  const start = bits.at;
  let type = audioType(bits);
  const coreRate = audioRate(bits);
  let channels = bits.uint(4), sampleRate = coreRate;
  const parametricStereo = type === 29;
  if (type === 5 || parametricStereo) { sampleRate = audioRate(bits); type = audioType(bits); }
  if (![1, 2, 3, 4].includes(type) || !coreRate || !sampleRate || channels > 7) {
    throw new Error("AAC LATM requires a supported declared audio configuration.");
  }
  const shortFrame = bits.uint(1);
  if (bits.uint(1)) bits.uint(14);
  const extension = bits.uint(1);
  channels = channels ? channels === 7 ? 8 : channels : programChannels(bits, start, coreRate);
  if (extension && bits.uint(1)) throw new Error("AAC LATM extension version requires its own decoder declaration.");
  return { sampleRate, channels: parametricStereo && channels === 1 ? 2 : channels,
    duration: (shortFrame ? 960 : 1024) / coreRate };
}

function audioType(bits) { const type = bits.uint(5); return type === 31 ? 32 + bits.uint(6) : type; }
function audioRate(bits) { const index = bits.uint(4); return index === 15 ? bits.uint(24) : SAMPLE_RATES[index]; }

/** Program configuration declares every single, paired and LFE channel. */
function programChannels(bits, start, sampleRate) {
  bits.uint(4); bits.uint(2);
  if (SAMPLE_RATES[bits.uint(4)] !== sampleRate) throw new Error("AAC program sample rate differs from its decoder declaration.");
  const front = bits.uint(4), side = bits.uint(4), back = bits.uint(4), lfe = bits.uint(2),
    associated = bits.uint(3), coupled = bits.uint(4);
  if (bits.uint(1)) bits.uint(4);
  if (bits.uint(1)) bits.uint(4);
  if (bits.uint(1)) bits.uint(3);
  let channels = lfe;
  for (let index = 0; index < front + side + back; index++) {
    channels += bits.uint(1) ? 2 : 1;
    bits.uint(4);
  }
  skip(bits, 4 * (lfe + associated));
  skip(bits, 5 * coupled);
  skip(bits, (8 - ((bits.at - start) % 8)) % 8);
  skip(bits, bits.uint(8) * 8);
  if (!channels) throw new Error("AAC program declares no output channels.");
  return channels;
}

function latmValue(bits) { return bits.uint((bits.uint(2) + 1) * 8); }
function skip(bits, count) { for (let left = count; left > 0; left -= 32) bits.uint(Math.min(left, 32)); }
