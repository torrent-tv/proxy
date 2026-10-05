export function mpegAudioFrame(bytes) {
  if (bytes[0] !== 0xff || (bytes[1] & 0xe0) !== 0xe0) throw new Error("MPEG audio lost frame synchronization.");
  const version = (bytes[1] >> 3) & 3, layer = (bytes[1] >> 1) & 3;
  const rateIndex = bytes[2] >> 4, sampleIndex = (bytes[2] >> 2) & 3;
  if (version === 1 || !layer || !rateIndex || rateIndex === 15 || sampleIndex === 3) throw new Error("MPEG audio frame parameters are invalid.");
  const mpeg1 = version === 3;
  const rates = mpeg1 ? layer === 3 ? [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448] :
    layer === 2 ? [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384] :
      [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] :
    layer === 3 ? [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256] :
      [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const sampleRate = [44100, 48000, 32000][sampleIndex] / (mpeg1 ? 1 : version === 2 ? 2 : 4);
  const bitrate = rates[rateIndex] * 1000, padding = (bytes[2] >> 1) & 1;
  const samples = layer === 3 ? 384 : layer === 1 && !mpeg1 ? 576 : 1152;
  const size = layer === 3 ? (Math.floor(12 * bitrate / sampleRate) + padding) * 4 :
    Math.floor((layer === 1 && !mpeg1 ? 72 : 144) * bitrate / sampleRate) + padding;
  if (size < 4) throw new Error("MPEG audio frame is smaller than its header.");
  return { size, sampleRate, codecId: `mp${4 - layer}`, duration: samples / sampleRate, channels: bytes[3] >> 6 === 3 ? 1 : 2 };
}
