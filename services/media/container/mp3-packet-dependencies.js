import { mpegAudioFrame } from "./mpeg-audio-frame.js";

export function isMp3Codec(codecId) { return ["mp3", "A_MPEG/L3", ".mp3"].includes(codecId); }

/** Inspect frame headers and side information, never their compressed bodies. */
export async function mp3PacketFacts(packet, readRange) {
  const size = packet.ranges.reduce((sum, [start, end]) => sum + end - start + 1, 0);
  let at = 0, capacity = 0, required = 0;
  while (at < size) {
    const header = await prefix(packet.ranges, at, 4, readRange);
    const frame = mpegAudioFrame(header);
    if (frame.codecId !== "mp3" || at + frame.size > size) throw new Error("MP3 packet frame addresses are inconsistent.");
    const mpeg1 = ((header[1] >> 3) & 3) === 3, mono = header[3] >> 6 === 3;
    const headerBytes = 4 + ((header[1] & 1) ? 0 : 2);
    const sideBytes = mpeg1 ? mono ? 17 : 32 : mono ? 9 : 17;
    if (frame.size < headerBytes + sideBytes) throw new Error("MP3 frame is smaller than its side information.");
    const bytes = await prefix(packet.ranges, at + headerBytes, sideBytes, readRange);
    const before = mpeg1 ? (bytes[0] << 1) | (bytes[1] >> 7) : bytes[0];
    required = Math.max(required, before - capacity);
    capacity += frame.size - headerBytes - sideBytes;
    at += frame.size;
  }
  return { required, capacity };
}

async function prefix(ranges, offset, length, readRange) {
  const bytes = Buffer.allocUnsafeSlow(length);
  let copied = 0;
  for (const [start, end] of ranges) {
    const size = end - start + 1;
    if (offset >= size) { offset -= size; continue; }
    const wanted = Math.min(length - copied, size - offset);
    const value = await readRange(start + offset, start + offset + wanted - 1);
    if (!value || value.length !== wanted) throw new Error("MP3 header read is incomplete.");
    bytes.set(value, copied);
    copied += wanted;
    if (copied === length) return bytes;
    offset = 0;
  }
  throw new Error("MP3 packet side information exceeds its byte ranges.");
}
