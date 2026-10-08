/**
 * An AVI soundtrack states its rate in WAVEFORMATEX `nAvgBytesPerSec`, and a
 * soundtrack the browser plays is copied only where a rate is stated
 * (torrent-tv/meta#159). The file is built in memory; no torrent is involved.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { AviContainer } from "../../services/media/container/AviContainer.js";
import { playbackDeclarations } from "../../services/media/playback-declarations.js";
import { buildAudioInventory } from "../../services/media/audio-inventory.js";
import { SOUNDTRACK_MODE_CAUSE, chooseSoundtrackMode } from "../../services/encode/quality/link-budget.js";

function chunk(id, payload) {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(payload.length);
  return Buffer.concat([Buffer.from(id, "latin1"), size, payload, Buffer.alloc(payload.length % 2)]);
}

function list(type, children) {
  return chunk("LIST", Buffer.concat([Buffer.from(type, "latin1"), ...children]));
}

/** An AVI declaring one MP3 stream, 48 kHz stereo, with the given average byte rate. */
function mp3Avi(avgBytesPerSecond) {
  const avih = Buffer.alloc(56);
  avih.writeUInt32LE(40_000, 0);
  avih.writeUInt32LE(50, 16);
  const strh = Buffer.alloc(56);
  strh.write("auds", 0, "latin1");
  strh.writeUInt32LE(1152, 20); // dwScale: one MPEG audio frame
  strh.writeUInt32LE(48_000, 24); // dwRate
  // WAVEFORMATEX followed by MPEGLAYER3WAVEFORMAT's twelve bytes, as the field file carries.
  const strf = Buffer.alloc(30);
  strf.writeUInt16LE(0x55, 0);
  strf.writeUInt16LE(2, 2);
  strf.writeUInt32LE(48_000, 4);
  strf.writeUInt32LE(avgBytesPerSecond, 8);
  strf.writeUInt16LE(1152, 12);
  strf.writeUInt16LE(12, 16);
  const riff = Buffer.concat([Buffer.from("AVI ", "latin1"),
    list("hdrl", [chunk("avih", avih), list("strl", [chunk("strh", strh), chunk("strf", strf)])]),
    list("movi", [])]);
  return chunk("RIFF", riff);
}

async function soundtrackOf(bytes) {
  const container = new AviContainer({ fileSize: bytes.length,
    readRange: async (start, end) => bytes.subarray(start, Math.min(end + 1, bytes.length)) });
  const tracks = await container.readTracks();
  const { audioTracks } = playbackDeclarations({ tracks, media: await container.readMediaInfo() });
  const [entry] = buildAudioInventory({ embedded: audioTracks, videoFileIndex: 0, sidecars: [] });
  return { track: tracks[0], entry };
}

test("an AVI soundtrack states its rate from nAvgBytesPerSec, and a playable one is copied", async () => {
  // The Frankenstein field file: 23 338 bytes a second.
  const { track, entry } = await soundtrackOf(mp3Avi(23_338));
  assert.equal(track.bitrateKbps, 186.704);
  assert.equal(entry.codec, "mp3");
  assert.equal(entry.bitrateKbps, 186.704);
  assert.deepEqual(chooseSoundtrackMode({ entry, browserPlays: true, transcodeAllowed: true }),
    { transcode: false, cause: SOUNDTRACK_MODE_CAUSE.COPY });
  assert.deepEqual(chooseSoundtrackMode({ entry, browserPlays: false, transcodeAllowed: true }),
    { transcode: true, cause: SOUNDTRACK_MODE_CAUSE.UNPLAYABLE });
});

test("an AVI soundtrack whose nAvgBytesPerSec is zero states no rate and is re-encoded", async () => {
  const { track, entry } = await soundtrackOf(mp3Avi(0));
  assert.equal(track.bitrateKbps, null);
  assert.equal(entry.bitrateKbps, null);
  assert.deepEqual(chooseSoundtrackMode({ entry, browserPlays: true, transcodeAllowed: true }),
    { transcode: true, cause: SOUNDTRACK_MODE_CAUSE.NO_FIGURE });
});
