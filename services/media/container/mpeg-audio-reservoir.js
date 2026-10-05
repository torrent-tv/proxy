/** Layer III decoder input follows its declared main_data_begin byte references. */
export class MpegAudioReservoir {
  #history = [];

  prepare(bytes, frameSize, frameIndex) {
    const version = (bytes[1] >> 3) & 3, layer = (bytes[1] >> 1) & 3;
    if (layer !== 1) return null;
    if (version === 1) throw new Error("MPEG audio version is invalid.");
    const mono = bytes[3] >> 6 === 3, mpeg1 = version === 3;
    const header = 4 + ((bytes[1] & 1) ? 0 : 2);
    const sideBytes = mpeg1 ? mono ? 17 : 32 : mono ? 9 : 17;
    if (bytes.length < header + sideBytes || frameSize < header + sideBytes) throw new Error("MP3 side information is truncated.");
    const required = mpeg1 ? (bytes[header] << 1) | (bytes[header + 1] >> 7) : bytes[header];
    let available = 0, decodeFromIndex = frameIndex;
    for (let at = this.#history.length - 1; at >= 0 && available < required; at--) {
      available += this.#history[at].bytes;
      decodeFromIndex = this.#history[at].index;
    }
    if (available < required) throw new Error("MP3 bit reservoir refers to bytes before the available source frames.");
    const capacity = frameSize - header - sideBytes;
    const history = capacity ? [...this.#history, { index: frameIndex, bytes: capacity }] : [...this.#history];
    let total = history.reduce((sum, frame) => sum + frame.bytes, 0);
    const maximum = mpeg1 ? 511 : 255;
    while (history.length > 1 && total - history[0].bytes >= maximum) total -= history.shift().bytes;
    return { decodeFromIndex, commit: () => { this.#history = history; } };
  }
}
