/** Adobe FLV 10.1 Annex E: demuxer positions name tags rather than their payload. */
export async function flvPacketRanges({ readRange, fileSize, position, size, track, pts, dts }) {
  if (position + 11 > fileSize) throw new Error("FLV tag header exceeds the source.");
  const header = await readRange(position, position + 10);
  const type = header[0];
  if (type & 0xe0 || header.readUIntBE(8, 3) !== 0) throw new Error("Filtered, encrypted or reserved FLV tags are unsupported.");
  if (type !== (track.type === "video" ? 9 : 8)) throw new Error("FLV tag does not contain the declared track.");
  const dataSize = header.readUIntBE(1, 3);
  const end = position + 11 + dataSize;
  if (!dataSize || end + 4 > fileSize) throw new Error("FLV tag exceeds the source.");
  const timestamp = (header.readUIntBE(4, 3) + header[7] * 0x1000000) / 1000;
  if (Math.abs(timestamp - dts) > 1e-6) throw new Error("FLV tag and demuxer decode timestamps disagree.");
  const framing = track.type === "video" ? 5 : track.codecId === "aac" ? 2 : track.codecId === "mp3" ? 1 : null;
  if (framing === null || (track.type === "video" && track.codecId !== "h264")) throw new Error("FLV packet framing is unsupported for the declared codec.");
  if (dataSize <= framing || dataSize - framing !== size) throw new Error("FLV tag and demuxer payload lengths disagree.");
  const prefix = await readRange(position + 11, position + 10 + framing);
  if (track.type === "video") {
    if ((prefix[0] & 15) !== 7 || prefix[1] !== 1) throw new Error("FLV tag does not contain AVC frame data.");
    const offset = prefix.readIntBE(2, 3) / 1000;
    if (Math.abs(timestamp + offset - pts) > 1e-6) throw new Error("FLV composition time and demuxer presentation timestamp disagree.");
  } else if (track.codecId === "aac") {
    if ((prefix[0] >> 4) !== 10 || prefix[1] !== 1) throw new Error("FLV tag does not contain AAC frame data.");
  } else if ((prefix[0] >> 4) !== 2) throw new Error("FLV tag does not contain MPEG layer III frame data.");
  const previous = await readRange(end, end + 3);
  if (previous.readUInt32BE(0) !== 11 + dataSize) throw new Error("FLV previous-tag size is invalid.");
  return [[position + 11 + framing, end - 1]];
}
