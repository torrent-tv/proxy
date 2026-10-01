/**
 * @file The most a soundtrack's codec allows it to carry, from what its
 * container declares about it.
 *
 * A copied soundtrack is sent to the viewer as the file has it, so the most it
 * can weigh on their link is a property of its CODEC as configured: a bound
 * the stream is held to by its own specification, not an average a file
 * happens to state. Only bounds confirmed against a published source are
 * given, for exactly the configurations those sources describe; any other
 * combination answers null, and the caller falls back to what the file states
 * or to re-encoding the track. Sources, and why each other codec has none:
 * `research/soundtrack-rate-bound-2026-10-01.md`.
 *
 * 1. AAC-LC (`audioObjectType` 2) with 1024-sample frames: at most 6144 bits
 *    per channel in one frame, whatever the bit reservoir holds (ISO/IEC
 *    14496-3 §4.5.3.1; Fraunhofer's FDK AAC encoder states the same: "For
 *    AAC-LC, the bitrate is only limited by the maximum AAC frame length. It
 *    is, regardless of the available bit reservoir, defined as 6144 bits per
 *    channel"). One frame lasts 1024 / samplingFrequency seconds, so the rate
 *    over any stretch of whole frames is at most
 *    6144 x channels x samplingFrequency / 1024 bit/s. The channel count and
 *    the sampling frequency are the ones the AudioSpecificConfig states — for
 *    a stream with implicit SBR that is the core's, which is what one frame
 *    lasts. The count includes an LFE channel the buffer rule does not, so the
 *    bound errs high.
 * 2. AC-3: the largest syncframe ATSC A/52:2018 Table 5.18 allows at each
 *    sampling frequency (`frmsizecod` 37), over the 1536 samples it carries.
 *    That is 640 kbit/s at 32 and 48 kHz and 640.369 kbit/s at 44.1 kHz, whose
 *    frames alternate in length; with the frequency unknown the largest of the
 *    three is the bound.
 *
 * PURE: plain values in, plain values out. No container, no torrent.
 */

/** ISO/IEC 14496-3 Table 1.18: samplingFrequencyIndex to Hz. 0xF is explicit. */
const AAC_SAMPLING_FREQUENCIES = Object.freeze([
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350
]);

/** ISO/IEC 14496-3 Table 1.19: channelConfiguration to channels; 0 is a PCE. */
const AAC_CHANNELS = Object.freeze([null, 1, 2, 3, 4, 5, 6, 8]);

/** The AAC-LC object type, and the one frame length the bound is stated for. */
const AAC_LC = 2;
const AAC_LC_FRAME_LENGTH = 1024;
const AAC_MAX_BITS_PER_CHANNEL_FRAME = 6144;

/**
 * ATSC A/52:2018 Table 5.18, `frmsizecod` 37 (640 kbps nominal): 16-bit words
 * in the largest syncframe at each sampling frequency. A syncframe carries
 * 1536 samples (§5.1).
 */
const AC3_LARGEST_WORDS = Object.freeze(new Map([[48000, 1280], [44100, 1394], [32000, 1920]]));
const AC3_SAMPLES_PER_FRAME = 1536;

/**
 * @typedef {object} CodecParameters
 * @property {string} codec - The ffmpeg-side name: "aac", "ac3", ...
 * @property {number | null} objectType - AAC `audioObjectType`.
 * @property {number | null} frameLength - Samples per frame.
 * @property {number | null} channels
 * @property {number | null} sampleRate - Hz.
 */

/**
 * A minimal MSB-first bit reader over a buffer.
 *
 * @param {Buffer} bytes
 */
function bitReader(bytes) {
  let position = 0;
  return {
    read(count) {
      let value = 0;
      for (let i = 0; i < count; i += 1) {
        const byte = bytes[position >> 3];
        if (byte === undefined) {
          throw new RangeError("AudioSpecificConfig ended early");
        }
        value = (value * 2) + ((byte >> (7 - (position & 7))) & 1);
        position += 1;
      }
      return value;
    }
  };
}

/**
 * The fields of an AudioSpecificConfig the bound is computed from (ISO/IEC
 * 14496-3 §1.6.2.1 and the GASpecificConfig that follows it for AAC-LC).
 *
 * @param {Buffer | null} bytes
 * @returns {{ objectType: number, sampleRate: number | null, channels: number | null, frameLength: number | null } | null}
 *   Null when the bytes are not a readable config.
 */
export function parseAudioSpecificConfig(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2) {
    return null;
  }
  try {
    const bits = bitReader(bytes);
    let objectType = bits.read(5);
    if (objectType === 31) {
      objectType = 32 + bits.read(6);
    }
    const frequencyIndex = bits.read(4);
    const sampleRate = frequencyIndex === 0xf
      ? bits.read(24)
      : (AAC_SAMPLING_FREQUENCIES[frequencyIndex] ?? null);
    const channelConfiguration = bits.read(4);
    const channels = AAC_CHANNELS[channelConfiguration] ?? null;
    // GASpecificConfig begins with frameLengthFlag for the object types that
    // carry one; for any other the frame length is not read here.
    const frameLength = objectType === AAC_LC
      ? (bits.read(1) === 1 ? 960 : AAC_LC_FRAME_LENGTH)
      : null;
    return { objectType, sampleRate: sampleRate > 0 ? sampleRate : null, channels, frameLength };
  } catch {
    return null;
  }
}

/**
 * What a container declares about one soundtrack's codec configuration, as
 * plain values.
 *
 * For AAC the AudioSpecificConfig is the statement, and the container's own
 * channel count and frequency are not used in its place: for HE-AAC the
 * container may state the output frequency while a frame lasts the core's.
 *
 * @param {object} params
 * @param {string} params.codec - The ffmpeg-side name.
 * @param {string} [params.codecPrivateB64] - The AudioSpecificConfig for AAC.
 * @param {number | null} [params.channels] - As the container states it.
 * @param {number | null} [params.samplingFrequency] - As the container states it.
 * @returns {CodecParameters | null} Null when nothing names the codec.
 */
export function codecParametersOf({ codec, codecPrivateB64 = "", channels = null, samplingFrequency = null }) {
  const name = typeof codec === "string" ? codec.trim().toLowerCase() : "";
  if (!name) {
    return null;
  }
  if (name === "aac") {
    const config = typeof codecPrivateB64 === "string" && codecPrivateB64.length > 0
      ? parseAudioSpecificConfig(Buffer.from(codecPrivateB64, "base64"))
      : null;
    return {
      codec: name,
      objectType: config?.objectType ?? null,
      frameLength: config?.frameLength ?? null,
      channels: config?.channels ?? null,
      sampleRate: config?.sampleRate ?? null
    };
  }
  return {
    codec: name,
    objectType: null,
    frameLength: null,
    channels: Number.isFinite(channels) && channels > 0 ? channels : null,
    sampleRate: Number.isFinite(samplingFrequency) && samplingFrequency > 0 ? samplingFrequency : null
  };
}

/**
 * Whether a set of parameters holds everything the bound for its codec is
 * computed from. A set that is complete can replace another whole; one that is
 * not adds nothing to a set already known.
 *
 * @param {CodecParameters | null} params
 * @returns {boolean}
 */
export function codecParametersComplete(params) {
  if (!params?.codec) {
    return false;
  }
  if (params.codec === "aac") {
    return [params.objectType, params.frameLength, params.channels, params.sampleRate]
      .every((value) => Number.isFinite(value) && value > 0);
  }
  // Every other codec's bound — where it has one — needs no more than its name.
  return true;
}

/**
 * Whether two sets contradict each other: a field both state, stated
 * differently.
 *
 * @param {CodecParameters | null} left
 * @param {CodecParameters | null} right
 * @returns {boolean}
 */
export function codecParametersConflict(left, right) {
  if (!left || !right) {
    return false;
  }
  return ["codec", "objectType", "frameLength", "channels", "sampleRate"].some(
    (field) => left[field] !== null && left[field] !== undefined &&
      right[field] !== null && right[field] !== undefined &&
      left[field] !== right[field]
  );
}

/**
 * The confirmed bound for these parameters, in kbit/s, or null.
 *
 * @param {CodecParameters | null} params
 * @returns {number | null}
 */
export function peakKbpsOf(params) {
  if (!params?.codec) {
    return null;
  }
  if (params.codec === "aac") {
    if (
      params.objectType !== AAC_LC ||
      params.frameLength !== AAC_LC_FRAME_LENGTH ||
      !(params.channels > 0) ||
      !(params.sampleRate > 0)
    ) {
      return null;
    }
    return (AAC_MAX_BITS_PER_CHANNEL_FRAME * params.channels * params.sampleRate) / AAC_LC_FRAME_LENGTH / 1000;
  }
  if (params.codec === "ac3") {
    const rateOf = (sampleRate, words) => (words * 16 * sampleRate) / AC3_SAMPLES_PER_FRAME / 1000;
    const words = AC3_LARGEST_WORDS.get(params.sampleRate);
    if (words !== undefined) {
      return rateOf(params.sampleRate, words);
    }
    return Math.max(...[...AC3_LARGEST_WORDS].map(([sampleRate, largest]) => rateOf(sampleRate, largest)));
  }
  return null;
}
