import { Bits, parseAudioSpecificConfig } from "./bitstream.js";

/** LOAS frames retain their original addresses; payload bit positions describe raw AAC. */
export class LatmFrames {
  #configuration = null;

  read(bytes) {
    if (bytes.length < 3 || bytes[0] !== 0x56 || (bytes[1] & 0xe0) !== 0xe0) throw new Error("AAC LOAS synchronization is invalid.");
    const size = 3 + ((bytes[1] & 31) << 8) + bytes[2];
    if (bytes.length < size) return { size };
    const bits = new Bits(bytes.subarray(3, size), "AAC LATM SPS");
    if (!bits.uint(1)) {
      const version = bits.uint(1), versionA = version ? bits.uint(1) : 0;
      if (versionA) throw new Error("AAC LATM version A requires its own payload declarations.");
      if (version) latmValue(bits);
      const sameTime = bits.uint(1), subframes = bits.uint(6), programs = bits.uint(4), layers = bits.uint(3);
      if (!sameTime || subframes || programs || layers) throw new Error("AAC LATM multiplexed layers require separate packet declarations.");
      const ascLength = version ? latmValue(bits) : null, ascStart = bits.at;
      const configuration = audioConfiguration(bits);
      let ascEnd = bits.at;
      if (ascLength !== null) {
        if (ascEnd - ascStart > ascLength) throw new Error("AAC LATM decoder configuration exceeds its bit length.");
        bits.skip(ascLength - (ascEnd - ascStart));
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
      const privateBytes = bits.copy(ascStart, ascEnd);
      this.#configuration = { ...configuration, codecPrivateB64: privateBytes.toString("base64") };
    }
    if (!this.#configuration) throw new Error("AAC LATM payload precedes its stream configuration.");
    let length = 0, part;
    do { part = bits.uint(8); length += part; } while (part === 255);
    if (!(length > 0) || bits.at + length * 8 > bits.bytes.length * 8) throw new Error("AAC LATM payload exceeds its LOAS frame.");
    return { size, ...this.#configuration, codecId: "aac", bitOffset: bits.at + 24, bitLength: length * 8 };
  }
}

/** The AudioSpecificConfig of a LATM stream, or a refusal of one this proxy cannot describe. */
function audioConfiguration(bits) {
  const config = parseAudioSpecificConfig(bits);
  if (!config.supported) throw new Error("AAC LATM requires a supported declared audio configuration.");
  if (config.extensionVersion) throw new Error("AAC LATM extension version requires its own decoder declaration.");
  return { sampleRate: config.sampleRate, channels: config.channels, duration: config.frameLength / config.coreSampleRate };
}

function latmValue(bits) { return bits.uint((bits.uint(2) + 1) * 8); }
