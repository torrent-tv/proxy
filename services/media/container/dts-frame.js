/** DTS core headers declare physical frame length and PCM block duration. */
export function dtsFrame(bytes) {
  if (bytes.length < 24) throw new Error("DTS core header is truncated.");
  const sync = bytes.readUInt32BE();
  const packed = sync === 0x1fffe800 || sync === 0xff1f00e8;
  const little = sync === 0xfe7f0180 || sync === 0xff1f00e8;
  if (![0x7ffe8001, 0xfe7f0180, 0x1fffe800, 0xff1f00e8].includes(sync)) {
    throw new Error("DTS core synchronization is invalid.");
  }
  let position = 32;
  const bit = logical => {
    const physical = packed ? Math.floor(logical / 14) * 16 + 2 + logical % 14 : logical;
    let byte = physical >> 3;
    if (little) byte ^= 1;
    if (byte >= bytes.length) throw new Error("DTS core header is truncated.");
    return (bytes[byte] >> (7 - (physical & 7))) & 1;
  };
  const read = count => {
    let value = 0;
    for (let at = 0; at < count; at++) value = value * 2 + bit(position++);
    return value;
  };
  read(1);
  if (read(5) !== 31) throw new Error("DTS deficit sample count is invalid.");
  const crc = read(1);
  const blocks = read(7) + 1;
  if (blocks % 8 !== 0) throw new Error("DTS PCM block count is invalid.");
  const logicalSize = read(14) + 1;
  if (logicalSize < 96) throw new Error("DTS core frame length is invalid.");
  const mode = read(6);
  const channels = [1, 2, 2, 2, 2, 3, 3, 4, 4, 5][mode];
  const sampleRate = [0, 8000, 16000, 32000, 0, 0, 11025, 22050, 44100, 0, 0, 12000, 24000, 48000, 96000, 192000][read(4)];
  if (!channels || !sampleRate) throw new Error("DTS core audio format is invalid.");
  read(5);
  if (read(1)) throw new Error("DTS reserved header bit is set.");
  read(4);
  read(3);
  const extended = read(1);
  if (extended) throw new Error("DTS core extensions require extension-specific declarations.");
  read(1);
  const lfe = read(2);
  if (lfe === 3) throw new Error("DTS LFE declaration is invalid.");
  read(1);
  if (crc) read(16);
  read(1);
  read(4);
  read(2);
  if ([4, 7].includes(read(3))) throw new Error("DTS PCM resolution is invalid.");
  return { size: packed ? Math.ceil(logicalSize * 8 / 14) * 2 : logicalSize,
    sampleRate, channels: channels + Number(lfe > 0), duration: blocks * 32 / sampleRate, codecId: "dts" };
}
