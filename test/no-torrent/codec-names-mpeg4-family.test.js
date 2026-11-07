import assert from "node:assert/strict";
import test from "node:test";
import { playbackDeclarations } from "../../services/media/playback-declarations.js";
import { decodeFamilyOf } from "../../services/encode/decode-cost-fit.js";
import { VideoTrack } from "../../services/media/tracks/VideoTrack.js";

// torrent-tv/meta#284 acceptance 1. The members are the ones AviContainer
// treats as MPEG-4 Part 2; the playback inventory must name every one of them
// `mpeg4`, so the encoder is priced at the measured mpeg4 decoder family.
const MPEG4_FOURCCS = ["FMP4", "XVID", "DIVX", "DX50", "MP4V", "M4S2", "MP4S"];
const media = { format: "avi", durationSeconds: 60, startTimeSeconds: 0 };

const declared = codecId => playbackDeclarations({
  tracks: [new VideoTrack({ trackNumber: 1, declaredIndex: 0, codecId, width: 640, height: 480, fps: 25 })],
  media
}).videoCodec;

/** A V_MS/VFW/FOURCC track: the FOURCC is at bytes 16..20 of the BITMAPINFOHEADER. */
const declaredThroughVfw = fourcc => {
  const header = Buffer.alloc(40);
  header.write(fourcc, 16, "ascii");
  return playbackDeclarations({
    tracks: [new VideoTrack({ trackNumber: 1, declaredIndex: 0, codecId: "V_MS/VFW/FOURCC",
      codecPrivateB64: header.toString("base64"), width: 640, height: 480, fps: 25 })],
    media
  }).videoCodec;
};

for (const fourcc of MPEG4_FOURCCS) {
  for (const spelled of [fourcc, fourcc.toLowerCase(), fourcc[0] + fourcc.slice(1).toLowerCase()]) {
    test(`${spelled} is named mpeg4 and priced as the mpeg4 family`, () => {
      const name = declared(spelled);
      assert.equal(name, "mpeg4");
      assert.equal(decodeFamilyOf({ codec: name }), "mpeg4");
    });
  }
  test(`${fourcc} read from a VFW header is named mpeg4 and priced as the mpeg4 family`, () => {
    const name = declaredThroughVfw(fourcc);
    assert.equal(name, "mpeg4");
    assert.equal(decodeFamilyOf({ codec: name }), "mpeg4");
  });
}
