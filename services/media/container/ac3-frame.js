/** ATSC A/52 sync information gives exact frame length and sample count. */
export function ac3Frame(bytes) {
  if (bytes.length < 7 || bytes[0] !== 0x0b || bytes[1] !== 0x77) throw new Error("AC-3 frame synchronization is invalid.");
  const bitstreamId = bytes[5] >> 3;
  if (bitstreamId > 16) throw new Error("AC-3 bitstream version is invalid.");
  let position = 16;
  const read = count => {
    let value = 0;
    for (let bit = 0; bit < count; bit++, position++) value = (value << 1) | ((bytes[position >> 3] >> (7 - (position & 7))) & 1);
    return value;
  };
  let sampleRate, size, channelMode, lfe, samples, codecId;
  const frequencies = [48000, 44100, 32000];
  if (bitstreamId <= 10) {
    read(16);
    const frequency = read(2), sizeCode = read(6);
    if (frequency === 3 || sizeCode > 37) throw new Error("AC-3 frame parameters are invalid.");
    const rates = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512, 576, 640];
    const bitrate = rates[sizeCode >> 1] * 1000;
    size = frequency === 1 ? 2 * (Math.floor(bitrate * 1536 / (44100 * 16)) + (sizeCode & 1))
      : bitrate * 1536 / (frequencies[frequency] * 8);
    sampleRate = frequencies[frequency] / 2 ** Math.max(0, bitstreamId - 8);
    read(5);
    read(3);
    channelMode = read(3);
    if ((channelMode & 1) && channelMode !== 1) read(2);
    if (channelMode & 4) read(2);
    if (channelMode === 2) read(2);
    lfe = read(1);
    samples = 1536;
    codecId = "ac3";
  } else {
    const streamType = read(2), substream = read(3);
    if (streamType === 3) throw new Error("E-AC-3 stream type is reserved.");
    if (streamType === 1 || substream !== 0) throw new Error("E-AC-3 dependent substreams require combined frame-set indexing.");
    size = 2 * (read(11) + 1);
    const frequency = read(2), blockCode = read(2);
    sampleRate = frequency === 3 ? frequencies[blockCode] / 2 : frequencies[frequency];
    if (!sampleRate || size < 7) throw new Error("E-AC-3 frame parameters are invalid.");
    samples = 256 * (frequency === 3 ? 6 : [1, 2, 3, 6][blockCode]);
    channelMode = read(3);
    lfe = read(1);
    codecId = "eac3";
  }
  return { size, sampleRate, channels: [2, 1, 2, 3, 3, 4, 4, 5][channelMode] + lfe, duration: samples / sampleRate, codecId };
}
