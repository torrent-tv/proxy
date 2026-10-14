import { avcPacketSlices } from "./annex-b-input.js";
import { bitPayloadSlices } from "./bit-payload.js";

/** Emit already admitted packets as one timestamped Matroska input. */
export async function* matroskaInput({ tracks, readPacket, originSeconds = 0, includeHeader = true, seen = new Map() }) {
  if (!Array.isArray(tracks) || tracks.length === 0 || typeof readPacket !== "function" || !Number.isFinite(originSeconds)) {
    throw new TypeError("A Matroska input requires tracks, admitted packets and a timeline origin.");
  }
  if (includeHeader) {
  const declarations = tracks.map((input, position) => trackElement(input.track, position + 1));
  yield element("1a45dfa3", Buffer.concat([
    uintElement("4286", 1), uintElement("42f7", 1), uintElement("42f2", 4), uintElement("42f3", 8),
    textElement("4282", "matroska"), uintElement("4287", 4), uintElement("4285", 2)
  ]));
  yield Buffer.from("1853806701ffffffffffffff", "hex");
  yield element("1549a966", uintElement("2ad7b1", 1000));
  yield element("1654ae6b", Buffer.concat(declarations));
  }
  const positions = tracks.map(() => 0);
  const currentSeen = new Map();
  while (true) {
    let selected = -1, time = Infinity;
    for (let position = 0; position < tracks.length; position++) {
      const packet = tracks[position].packets[positions[position]];
      if (!packet) continue;
      const decodeTime = packet.dts ?? packet.pts;
      if (selected < 0 || decodeTime < time) { selected = position; time = decodeTime; }
    }
    if (selected < 0) {
      seen.clear();
      for (const [position, identities] of currentSeen) seen.set(position, identities);
      return;
    }
    const input = tracks[selected];
    const packet = input.packets[positions[selected]++];
    const identity = `${packet.pts}:${packet.ranges.map(range => range.join("-")).join(",")}`;
    const identities = currentSeen.get(selected) ?? new Set();
    if (identities.has(identity)) continue;
    identities.add(identity);
    currentSeen.set(selected, identities);
    if (seen.get(selected)?.has(identity)) continue;
    const stamp = Math.round((packet.pts + (input.track.codecDelaySeconds ?? 0) - originSeconds) * 1e6);
    if (!Number.isSafeInteger(stamp) || stamp < 0) throw new Error("Admitted packet precedes its Matroska timeline origin.");
    const payload = await readPacket(input, packet);
    let slices = Array.isArray(payload) ? payload : [payload];
    let payloadBytes = slices.reduce((sum, slice) => sum + (Buffer.isBuffer(slice) ? slice.length : 0), 0);
    const expected = packet.ranges.reduce((sum, [start, end]) => sum + end - start + 1, 0);
    if (!slices.length || slices.some(slice => !Buffer.isBuffer(slice)) || payloadBytes !== expected) throw new Error("Admitted packet bytes are incomplete.");
    if (packet.bitOffset !== undefined) {
      slices = bitPayloadSlices(slices, packet.bitOffset, packet.bitLength);
      payloadBytes = packet.bitLength / 8;
    }
    if (input.track.packetFraming === "annex-b") {
      slices = avcPacketSlices(slices);
      payloadBytes = slices.reduce((sum, slice) => sum + slice.length, 0);
    }
    // EVERY PACKET'S CLUSTER IS WRITTEN INTO ONE BUFFER, its sizes worked out
    // first: an element at a time, each id parsed from hex, each number split
    // into bytes through BigInt and every part joined again, this writer was
    // 6 % of the main thread over a two-hour AVI on Home Assistant (r30,
    // torrent-tv/meta#178). The bytes are the same.
    const duration = Math.round(packet.duration * 1e6);
    const padding = packet.discardPaddingSeconds ? Math.round(packet.discardPaddingSeconds * 1e9) : null;
    if (duration > 0 && !Number.isSafeInteger(duration)) throw new TypeError("EBML unsigned integer is invalid.");
    if (padding !== null && !Number.isSafeInteger(padding)) throw new TypeError("EBML signed integer is outside its exact range.");
    const blockHeaderBytes = vintWidth(selected + 1) + 3;
    const durationWidth = duration > 0 ? uintWidth(duration) : 0;
    const afterBytes = (duration > 0 ? 1 + vintWidth(durationWidth) + durationWidth : 0) +
      (padding !== null ? 2 + 1 + 8 : 0) + (packet.keyframe ? 0 : 3);
    const blockSize = blockHeaderBytes + payloadBytes;
    const blockPrefixBytes = 1 + vintWidth(blockSize);
    const groupSize = blockPrefixBytes + blockSize + afterBytes;
    const groupPrefixBytes = 1 + vintWidth(groupSize);
    const stampWidth = uintWidth(stamp);
    const timestampBytes = 1 + vintWidth(stampWidth) + stampWidth;
    const clusterSize = timestampBytes + groupPrefixBytes + groupSize;
    const head = Buffer.allocUnsafe(4 + vintWidth(clusterSize) + timestampBytes + groupPrefixBytes + blockPrefixBytes + blockHeaderBytes);
    let at = head.writeUInt32BE(0x1f43b675, 0);
    at = writeVint(head, at, clusterSize);
    head[at++] = 0xe7;
    at = writeVint(head, at, stampWidth);
    at = writeUint(head, at, stamp, stampWidth);
    head[at++] = 0xa0;
    at = writeVint(head, at, groupSize);
    head[at++] = 0xa1;
    at = writeVint(head, at, blockSize);
    at = writeVint(head, at, selected + 1);
    head[at++] = 0; head[at++] = 0; head[at++] = 0;
    yield head;
    for (const slice of slices) yield slice;
    if (afterBytes > 0) {
      const after = Buffer.allocUnsafe(afterBytes);
      let offset = 0;
      if (duration > 0) {
        after[offset++] = 0x9b;
        offset = writeVint(after, offset, durationWidth);
        offset = writeUint(after, offset, duration, durationWidth);
      }
      if (padding !== null) {
        offset = after.writeUInt16BE(0x75a2, offset);
        offset = writeVint(after, offset, 8);
        offset = after.writeBigInt64BE(BigInt(padding), offset);
      }
      if (!packet.keyframe) { after[offset++] = 0xfb; after[offset++] = 0x81; after[offset++] = 0; }
      yield after;
    }
  }
}

function trackElement(track, number) {
  const type = track.type === "video" ? 1 : track.type === "audio" ? 2 : null;
  if (type === null) throw new Error("Admitted input carries an unsupported track type.");
  const codec = track.matroskaCodecId ?? matroskaCodec(track.codecId);
  const fields = [uintElement("d7", number), uintElement("73c5", number), uintElement("83", type),
    uintElement("9c", 0), textElement("86", codec)];
  const privateBytes = track.matroskaCodecPrivateB64 ?? track.codecPrivateB64;
  if (privateBytes) fields.push(element("63a2", Buffer.from(privateBytes, "base64")));
  if (track.language) fields.push(textElement("22b59c", track.language));
  if (track.codecDelaySeconds > 0) fields.push(uintElement("56aa", Math.round(track.codecDelaySeconds * 1e9)));
  if (track.seekPrerollSeconds > 0) fields.push(uintElement("56bb", Math.round(track.seekPrerollSeconds * 1e9)));
  if (type === 1) {
    if (!(track.width > 0 && track.height > 0)) throw new Error("Admitted video has no declared dimensions.");
    fields.push(element("e0", Buffer.concat([uintElement("b0", track.width), uintElement("ba", track.height)])));
  } else {
    if (!(track.samplingFrequency > 0 && track.channels > 0)) throw new Error("Admitted audio has no declared format.");
    const frequency = Buffer.alloc(8);
    frequency.writeDoubleBE(track.samplingFrequency);
    if (codec.startsWith("A_PCM/") && !(track.bitDepth > 0)) throw new Error("Admitted PCM has no declared sample bit depth.");
    fields.push(element("e1", Buffer.concat([element("b5", frequency), uintElement("9f", track.channels),
      ...(track.bitDepth > 0 ? [uintElement("6264", track.bitDepth)] : [])])));
  }
  return element("ae", Buffer.concat(fields));
}

/** Stable identity of every declaration emitted into the input stream. */
export function matroskaTrackIdentity(track) {
  return JSON.stringify([
    track.type, track.matroskaCodecId ?? matroskaCodec(track.codecId),
    track.matroskaCodecPrivateB64 ?? track.codecPrivateB64 ?? "",
    track.language ?? "", track.packetFraming ?? "", track.width ?? null, track.height ?? null,
    track.samplingFrequency ?? null, track.channels ?? null, track.bitDepth ?? null,
    track.codecDelaySeconds ?? 0, track.seekPrerollSeconds ?? 0
  ]);
}

function matroskaCodec(codec) {
  if (/^[VA]_/.test(codec)) return codec;
  if (/^pcm_[su](?:16|24|32|64)le$/.test(codec) || /^pcm_[su]8(?:le|be)?$/.test(codec)) return "A_PCM/INT/LIT";
  if (/^pcm_[su](?:16|24|32|64)be$/.test(codec)) return "A_PCM/INT/BIG";
  if (/^pcm_f(?:32|64)(?:le|be)$/.test(codec)) return "A_PCM/FLOAT/IEEE";
  const declared = new Map([
    ["avc1", "V_MPEG4/ISO/AVC"], ["avc3", "V_MPEG4/ISO/AVC"], ["h264", "V_MPEG4/ISO/AVC"],
    ["hvc1", "V_MPEGH/ISO/HEVC"], ["hev1", "V_MPEGH/ISO/HEVC"], ["hevc", "V_MPEGH/ISO/HEVC"],
    ["av01", "V_AV1"], ["av1", "V_AV1"], ["vp9", "V_VP9"], ["vp8", "V_VP8"],
    ["mjpeg", "V_MJPEG"], ["ffv1", "V_FFV1"], ["theora", "V_THEORA"], ["jpeg2000", "V_JPEG2000"],
    ["mpeg1video", "V_MPEG1"], ["mpeg2video", "V_MPEG2"], ["mpeg4", "V_MPEG4/ISO/ASP"],
    ["FMP4", "V_MPEG4/ISO/ASP"], ["XVID", "V_MPEG4/ISO/ASP"], ["DIVX", "V_MPEG4/ISO/ASP"],
    ["mp4a", "A_AAC"], ["aac", "A_AAC"], ["mp3", "A_MPEG/L3"], ["mp2", "A_MPEG/L2"], ["mp1", "A_MPEG/L1"],
    ["ac-3", "A_AC3"], ["ac3", "A_AC3"], ["ec-3", "A_EAC3"], ["eac3", "A_EAC3"],
    ["Opus", "A_OPUS"], ["opus", "A_OPUS"], ["fLaC", "A_FLAC"], ["flac", "A_FLAC"], ["dts", "A_DTS"],
    ["vorbis", "A_VORBIS"], ["alac", "A_ALAC"], ["truehd", "A_TRUEHD"]
  ]).get(codec);
  if (!declared) throw new Error(`Admitted codec ${codec} has no Matroska declaration.`);
  return declared;
}

/** How many bytes an EBML size of this value takes: the narrowest whose all-ones value it is below. */
function vintWidth(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("EBML value is outside its integer range.");
  // 2 ** 56 - 1 is above every safe integer, so eight bytes always hold one.
  for (let width = 1; width < 8; width++) if (value < 2 ** (7 * width) - 1) return width;
  return 8;
}

/** The value as an EBML size at `at`, its width's marker bit set; the next offset. */
function writeVint(target, at, value) {
  const width = vintWidth(value);
  writeUint(target, at, value, width);
  target[at] |= 1 << (8 - width);
  return at + width;
}

/** How many bytes an unsigned integer takes, one at least. */
function uintWidth(value) {
  let width = 1;
  for (let rest = Math.floor(value / 256); rest > 0; rest = Math.floor(rest / 256)) width += 1;
  return width;
}

/** The value big-endian in `width` bytes at `at`; the next offset. */
function writeUint(target, at, value, width) {
  let rest = value;
  for (let index = width - 1; index >= 0; index--) {
    target[at + index] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return at + width;
}

function vint(value) {
  const encoded = Buffer.alloc(vintWidth(value));
  writeVint(encoded, 0, value);
  return encoded;
}

function prefix(id, size) { return Buffer.concat([Buffer.from(id, "hex"), vint(size)]); }
function element(id, payload) { return Buffer.concat([prefix(id, payload.length), payload]); }
function textElement(id, text) { return element(id, Buffer.from(text, "utf8")); }
function uintElement(id, value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("EBML unsigned integer is invalid.");
  const width = uintWidth(value);
  const bytes = Buffer.alloc(width);
  writeUint(bytes, 0, value, width);
  return element(id, bytes);
}
