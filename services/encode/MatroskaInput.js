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
    const blockHeader = Buffer.concat([vint(selected + 1), Buffer.from([0, 0, 0])]);
    const duration = Math.round(packet.duration * 1e6);
    const afterBlock = Buffer.concat([
      ...(duration > 0 ? [uintElement("9b", duration)] : []),
      ...(packet.discardPaddingSeconds ? [signedElement("75a2", Math.round(packet.discardPaddingSeconds * 1e9))] : []),
      ...(packet.keyframe ? [] : [element("fb", Buffer.from([0]))])]);
    const blockPrefix = prefix("a1", blockHeader.length + payloadBytes);
    const groupPrefix = prefix("a0", blockPrefix.length + blockHeader.length + payloadBytes + afterBlock.length);
    const timestamp = uintElement("e7", stamp);
    const clusterPrefix = prefix("1f43b675", timestamp.length + groupPrefix.length + blockPrefix.length +
      blockHeader.length + payloadBytes + afterBlock.length);
    yield Buffer.concat([clusterPrefix, timestamp, groupPrefix, blockPrefix, blockHeader]);
    for (const slice of slices) yield slice;
    if (afterBlock.length) yield afterBlock;
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

function vint(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("EBML value is outside its integer range.");
  for (let width = 1; width <= 8; width++) {
    if (BigInt(value) >= (1n << BigInt(7 * width)) - 1n) continue;
    const encoded = Buffer.alloc(width);
    let bits = BigInt(value) | (1n << BigInt(7 * width));
    for (let at = width - 1; at >= 0; at--) { encoded[at] = Number(bits & 255n); bits >>= 8n; }
    return encoded;
  }
  throw new TypeError("EBML value has no valid width.");
}

function prefix(id, size) { return Buffer.concat([Buffer.from(id, "hex"), vint(size)]); }
function element(id, payload) { return Buffer.concat([prefix(id, payload.length), payload]); }
function textElement(id, text) { return element(id, Buffer.from(text, "utf8")); }
function signedElement(id, value) {
  if (!Number.isSafeInteger(value)) throw new TypeError("EBML signed integer is outside its exact range.");
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64BE(BigInt(value));
  return element(id, bytes);
}
function uintElement(id, value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("EBML unsigned integer is invalid.");
  let bits = BigInt(value);
  const bytes = [];
  do { bytes.unshift(Number(bits & 255n)); bits >>= 8n; } while (bits > 0n);
  return element(id, Buffer.from(bytes));
}
